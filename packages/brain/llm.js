/**
 * Optional LLM enhancement via GitHub Copilot Business API + fallback providers (P12.5).
 * Graceful degradation: all exports return null if unavailable.
 * Zero external tokens — uses gpt-5-mini via corporate Copilot license.
 * Fallback chain: Copilot → BRAIN_LLM_FALLBACK (ollama/openai) when primary fails.
 *
 * Four task functions (all return null on failure/unavailable):
 *   llmRerank(query, candidates)       — reorder search results semantically
 *   llmExpandQuery(query)              — generate related search terms
 *   llmAutoTags(title, content, tags)  — suggest tags for a learning
 *   llmDistill(learnings, clusterTags) — draft principle from learning cluster
 *
 * Budget: weighted units (expansion=1, autotags=1, rerank=2, distill=4), session cap=100.
 * Circuit breaker: 3 consecutive errors → disabled 5 min, then half-open retry.
 */

import { execFile, execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { llmInfo, llmWarn, llmError } from "./brain-logger.js";

const execFileAsync = promisify(execFile);

// ─── External LLM config (llm-config.json) ──────────────────────────────────

import { fileURLToPath as _flu } from "url";
const __llmDir = path.dirname(_flu(import.meta.url));
const LLM_CONFIG_PATH = path.join(__llmDir, "llm-config.json");

let _llmConfig = null;
function getLlmConfig() {
  if (_llmConfig) return _llmConfig;
  try {
    const raw = fs.readFileSync(LLM_CONFIG_PATH, "utf8");
    _llmConfig = JSON.parse(raw);
    llmInfo('config_load', { detail: LLM_CONFIG_PATH });
  } catch (e) {
    llmWarn('config_load', { error: e.message, detail: 'using defaults' });
    _llmConfig = { providers: {}, tasks: {}, circuitBreaker: {}, budget: {}, providerChain: ["copilot", "bedrock"] };
  }
  return _llmConfig;
}

/** Get timeout for a provider+task from config, with fallback to hardcoded defaults. */
function getTimeout(provider, task) {
  const cfg = getLlmConfig();
  const pCfg = cfg.providers?.[provider];
  if (pCfg?.timeouts) {
    if (task && pCfg.timeouts[task] !== undefined) return pCfg.timeouts[task];
    if (pCfg.timeouts.default !== undefined) return pCfg.timeouts.default;
  }
  // Hardcoded fallback (keep in sync with llm-config.json)
  return provider === "copilot" ? 15000 : 30000;
}

/** Check if a task is enabled in config. */
export function isTaskEnabled(task) {
  const cfg = getLlmConfig();
  const tCfg = cfg.tasks?.[task];
  return tCfg?.enabled !== false; // default: enabled
}

/** Get task config (maxTokens, temperature, budgetCost). */
function getTaskConfig(task) {
  const cfg = getLlmConfig();
  return cfg.tasks?.[task] || {};
}

/** Heavy tasks use modelHeavy (reasoning), light tasks use model (fast). */
const HEAVY_TASKS = new Set(["distill", "compact"]);
function getModelForTask(task) {
  return HEAVY_TASKS.has(task) ? LLM_MODEL_HEAVY : LLM_MODEL;
}

/** Get the ordered provider chain from config, optionally per-task. */
export function getProviderChain(task = null) {
  const cfg = getLlmConfig();
  // Per-task chain takes priority over global default
  const taskChain = task ? cfg.tasks?.[task]?.providerChain : null;
  const chain = taskChain || cfg.defaultProviderChain || ["copilot", "bedrock"];
  // Filter to only enabled providers
  return chain.filter(p => cfg.providers?.[p]?.enabled !== false);
}

/** Reload config at runtime (e.g. from brain_health). */
export function reloadLlmConfig() {
  _llmConfig = null;
  return getLlmConfig();
}

/** Check if any non-copilot provider is available in the chain (replaces legacy _fallbackConfig check). */
function hasAlternativeProviders() {
  const chain = getProviderChain();
  return chain.some(p => p !== 'copilot');
}

// ─── @laia/providers integration (graceful fallback for standalone mode) ───

let _providers = null;

async function getProviders() {
  if (_providers) return _providers;
  try {
    _providers = await import('@laia/providers');
  } catch {
    // Standalone mode: Brain running without LAIA repo as sibling.
    // Minimal Copilot-only stubs preserving current behavior.
    _providers = {
      findCopilotAppsJson: _findAppsJsonFallback,
      findCopilotOAuthToken: _findOAuthTokenFallback,
      PROVIDERS: {
        copilot: {
          extraHeaders: {
            'Editor-Version': process.env.COPILOT_EDITOR_VERSION || 'vscode/1.109.5',
            'Editor-Plugin-Version': process.env.COPILOT_PLUGIN_VERSION || 'copilot-chat/0.37.9',
            'Copilot-Integration-Id': 'vscode-chat',
          },
        },
      },
      COPILOT_GITHUB_API_VERSION: '2025-04-01',
    };
  }
  return _providers;
}

// Fallback implementations used when @laia/providers is not installed
function _findAppsJsonFallback() {
  if (process.env.LOCALAPPDATA) {
    const p = path.join(process.env.LOCALAPPDATA, "github-copilot", "apps.json");
    if (fs.existsSync(p)) return p;
  }
  if (process.env.APPDATA) {
    const p = path.join(process.env.APPDATA, "..", "Local", "github-copilot", "apps.json");
    if (fs.existsSync(p)) return p;
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const p = path.join(home, ".config", "github-copilot", "apps.json");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function _findOAuthTokenFallback() {
  const appsPath = _findAppsJsonFallback();
  if (!appsPath) return null;
  try {
    const apps = JSON.parse(fs.readFileSync(appsPath, "utf-8"));
    const entries = Object.entries(apps);
    if (!entries.length) return null;
    const vscEntry = entries.find(([, v]) => v.githubAppId === 'Iv23ctfURkiMfJ4xr5mv');
    if (vscEntry?.[1]?.oauth_token) return vscEntry[1].oauth_token;
    const ghuEntry = entries.find(([, v]) => v.oauth_token?.startsWith('ghu_'));
    if (ghuEntry?.[1]?.oauth_token) return ghuEntry[1].oauth_token;
    return entries.sort(([a], [b]) => a.localeCompare(b))[0]?.[1]?.oauth_token || null;
  } catch { return null; }
}

// ─── Configuration ───────────────────────────────────────────────────────────

const LLM_MODE = (process.env.BRAIN_LLM_ENABLED || "auto").toLowerCase();
// Model selection: env var > llm-config.json > hardcoded default
const LLM_MODEL = process.env.BRAIN_LLM_MODEL || getLlmConfig().providers?.copilot?.model || "gpt-5-mini";
const LLM_MODEL_HEAVY = process.env.BRAIN_LLM_MODEL_HEAVY || getLlmConfig().providers?.copilot?.modelHeavy || "gpt-5.3-codex";
let LLM_BUDGET_LIMIT = parseInt(process.env.BRAIN_LLM_BUDGET || String(getLlmConfig().budget?.sessionLimit || 100), 10);

// P12.5: Fallback provider configuration
// Format: "bedrock" | "bedrock:model-id" | "ollama" | "ollama:model-name" | "genailab:agent"
// Legacy env vars — DEPRECATED: routing now via llm-config.json providerChain
// Kept for parseFallbackConfig export (used in tests)
const FALLBACK_RAW = process.env.BRAIN_LLM_FALLBACK || "";
const FALLBACK_DISTILL = process.env.BRAIN_LLM_FALLBACK_DISTILL || FALLBACK_RAW;

// Bedrock inference profile IDs (EU cross-region)
// invoke-model requires full ARN for inference profiles
const BEDROCK_MODELS = {
  haiku: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  sonnet: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  opus: "eu.anthropic.claude-opus-4-5-20251101-v1:0",
};
const BEDROCK_DEFAULT_MODEL = BEDROCK_MODELS.haiku; // cheapest for batch
// Always EU region for EU region compliance — ignore AWS_REGION env
const BEDROCK_REGION = process.env.BRAIN_BEDROCK_REGION || "eu-central-1";
const BEDROCK_ACCOUNT_ID = process.env.BRAIN_BEDROCK_ACCOUNT_ID || "471464546381";
const BEDROCK_AWS_PROFILE = process.env.AWS_PROFILE || "LAIA";

// Build full ARN for inference profile (required by invoke-model)
function bedrockModelArn(profileId, region, accountId) {
  // If already an ARN, return as-is
  if (profileId.startsWith('arn:')) return profileId;
  return `arn:aws:bedrock:${region}:${accountId}:inference-profile/${profileId}`;
}

function parseFallbackConfig(raw) {
  if (!raw) return null;
  const parts = raw.split(":");
  const provider = parts[0].toLowerCase();
  if (provider === "genailab") {
    const agent = parts[1] || "laia";
    const scriptPath = parts.length > 2
      ? parts.slice(2).join(":")  // handle Windows paths with :
      : path.join(process.env.HOME || process.env.USERPROFILE || "", ".laia", "genai_lab_chat.py");
    return { provider: "genailab", agent, scriptPath, baseUrl: null, model: agent, apiKey: null };
  }
  if (provider === "bedrock") {
    const modelAlias = parts[1]?.toLowerCase();
    return {
      provider: "bedrock",
      model: BEDROCK_MODELS[modelAlias] || modelAlias || BEDROCK_DEFAULT_MODEL,
      region: BEDROCK_REGION
    };
  }
  if (provider === "ollama") {
    return {
      provider: "ollama",
      baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      model: parts[1] || "llama3.3:70b",
      apiKey: null
    };
  }

  return null;
}

const _fallbackConfig = parseFallbackConfig(FALLBACK_RAW);
const _fallbackDistillConfig = parseFallbackConfig(FALLBACK_DISTILL);

// Ollama health check: lazy + cached (Codex: 30-60s TTL, don't probe every call)
let _ollamaHealthy = null; // null=unknown, true/false
let _ollamaHealthCheckedAt = 0;
const OLLAMA_HEALTH_TTL = 60_000; // 60s

async function isOllamaHealthy(baseUrl) {
  const now = Date.now();
  if (_ollamaHealthy !== null && (now - _ollamaHealthCheckedAt) < OLLAMA_HEALTH_TTL) {
    return _ollamaHealthy;
  }
  try {
    const { stdout } = await execFileAsync("curl", [
      "-s", "--max-time", "2", `${baseUrl}/api/tags`
    ], { timeout: 3000 });
    _ollamaHealthy = stdout.includes('"models"');
  } catch {
    _ollamaHealthy = false;
  }
  _ollamaHealthCheckedAt = now;
  return _ollamaHealthy;
}

// P12.5b: GenAI Lab health check (passive: python + script exist; cached 120s)
let _genaiLabHealthy = null;
let _genaiLabHealthCheckedAt = 0;
const GENAILAB_HEALTH_TTL = 120_000;

async function isGenAiLabHealthy(scriptPath) {
  const now = Date.now();
  if (_genaiLabHealthy !== null && (now - _genaiLabHealthCheckedAt) < GENAILAB_HEALTH_TTL) {
    return _genaiLabHealthy;
  }
  try {
    // 1) Python + script must exist
    const py = process.env.BRAIN_GENAILAB_PYTHON || "python";
    execSync(`${py} --version`, { timeout: 5000, stdio: "ignore" });
    if (!fs.existsSync(scriptPath)) { _genaiLabHealthy = false; _genaiLabHealthCheckedAt = now; return false; }

    // 2) CDP must be reachable (Edge with --remote-debugging-port)
    const cdpPort = process.env.GENAILAB_CDP_PORT || "9224";
    const { stdout } = await execFileAsync("curl", [
      "-s", "--max-time", "2", `http://localhost:${cdpPort}/json/version`
    ], { timeout: 3000 });
    _genaiLabHealthy = stdout.includes('"Browser"');
    if (!_genaiLabHealthy) {
      llmWarn('provider_skip', { provider: 'genailab', detail: `CDP not active on port ${cdpPort}` });
    }
  } catch {
    _genaiLabHealthy = false;
  }
  _genaiLabHealthCheckedAt = now;
  return _genaiLabHealthy;
}

// P12.5b: GenAI Lab call via Python subprocess (uses execFile with args array — no shell quoting)
function _callGenAiLab(messages, config) {
  const { agent, scriptPath, task } = config;
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    llmError('provider_error', { provider: 'genailab', error: `script not found: ${scriptPath}` });
    return null;
  }

  // Merge messages into a single prompt (GenAI Lab takes a single question string)
  const prompt = messages.map(m => {
    if (m.role === "system") return `System instruction:\n${m.content}`;
    return m.content;
  }).join("\n\n");

  const py = process.env.BRAIN_GENAILAB_PYTHON || "python";
  const TIMEOUT_MS = getTimeout("genailab", task || "default");
  const args = [scriptPath.replace(/\\/g, "/"), prompt];
  if (agent) args.push(agent);

  try {
    // execFileSync: args passed as array — no shell, no quoting issues on Windows
    const stdout = execFileSync(py, args, {
      encoding: "utf8", timeout: TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
    });

    const text = (stdout || "").trim();
    if (!text) {
      llmWarn('provider_error', { provider: 'genailab', error: 'empty response' });
      return null;
    }

    // Auth failure detection
    const lower = text.toLowerCase();
    if (lower.includes("not authenticated") || lower.includes("access denied") || lower.includes("unauthorized")) {
      llmError('auth_failure', { provider: 'genailab', detail: 'open GenAI Lab in Edge to refresh SSO' });
      return null;
    }

    clearErrorStreak();
    llmInfo('llm_success', { provider: 'genailab', model: agent, chars: text.length });
    return { content: text, usage: null, provider: "genailab" };
  } catch (e) {
    const msg = (e.message || "").slice(0, 200);
    const stderr = e.stderr ? String(e.stderr).slice(0, 200) : "";
    if (e.killed || /timed out|SIGTERM/i.test(msg)) {
      llmError('timeout', { provider: 'genailab', latencyMs: TIMEOUT_MS });
    } else if (stderr.includes("not authenticated") || stderr.includes("RuntimeError")) {
      llmError('auth_failure', { provider: 'genailab', error: stderr });
    } else {
      llmError('provider_error', { provider: 'genailab', error: msg });
    }
    return null;
  }
}

const _defaultCosts = { expansion: 1, autotags: 1, duplicate: 1, rerank: 2, distill: 4, summarize: 2, compact: 3, assess: 0.5, reflection: 3 };
// Budget costs can be overridden from llm-config.json tasks[].budgetCost
function getCost(task) {
  const cfg = getLlmConfig();
  const taskName = task === "expansion" ? "expand" : task; // normalize
  const tCfg = cfg.tasks?.[taskName];
  return tCfg?.budgetCost ?? _defaultCosts[task] ?? 1;
}
const COSTS = new Proxy(_defaultCosts, { get: (t, prop) => getCost(prop) });
const ALLOWED_MODELS = new Set([LLM_MODEL, LLM_MODEL_HEAVY, "gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-4o-mini", "gpt-4o"]);
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// ─── Budget tracking (per server lifetime, resets on restart) ────────────────

const budget = { used: 0, calls: 0, errors: 0, consecutiveErrors: 0, disabled: false, disabledUntil: 0 };

export function getBudgetStatus() {
  return {
    used: budget.used,
    limit: LLM_BUDGET_LIMIT,
    remaining: Math.max(0, LLM_BUDGET_LIMIT - budget.used),
    calls: budget.calls,
    errors: budget.errors,
    disabled: budget.disabled,
    model: LLM_MODEL,
    modelHeavy: LLM_MODEL_HEAVY,
    mode: LLM_MODE,
    fallback: hasAlternativeProviders() ? getProviderChain().filter(p => p !== 'copilot').join(',') : null,
    fallbackDistill: hasAlternativeProviders() ? getProviderChain('distill').filter(p => p !== 'copilot').join(',') : null,
    configFile: LLM_CONFIG_PATH,
    providerChain: getProviderChain()
  };
}

export function getRemainingBudget() {
  return Math.max(0, LLM_BUDGET_LIMIT - budget.used);
}

/** Returns a warning string once when budget is exhausted, null otherwise. */
let _budgetWarningFired = false;
export function getBudgetWarning() {
  if (_budgetWarningFired) return null;
  const remaining = LLM_BUDGET_LIMIT - budget.used;
  if (remaining <= 0) {
    _budgetWarningFired = true;
    return `⚠️ LLM budget exhausted (${budget.used}/${LLM_BUDGET_LIMIT} units used, ${budget.calls} calls). To increase mid-session, set BRAIN_LLM_BUDGET to a higher value and restart the MCP server.`;
  }
  return null;
}

function canSpend(units) {
  // Circuit breaker with cooldown: re-enable after 5 min for half-open retry
  if (budget.disabled) {
    if (budget.disabledUntil && Date.now() >= budget.disabledUntil) {
      budget.disabled = false;
      budget.consecutiveErrors = 0;
      llmInfo('circuit_breaker', { detail: 'half-open — allowing retry' });
    } else if (hasAlternativeProviders()) {
      // Circuit breaker blocks primary (copilot), but alternative providers in chain.
      // Allow reserve() so callLlm can route to bedrock/genailab.
    } else {
      return false;
    }
  }
  return (budget.used + units) <= LLM_BUDGET_LIMIT;
}

/** Reserve units atomically before async call. Returns true if reserved. */
function reserve(units) {
  if (!canSpend(units)) return false;
  budget.used += units;
  budget.calls += 1;
  return true;
}

/** Refund units on failed call (partial recovery). */
function refund(units) {
  budget.used = Math.max(0, budget.used - units);
}

function recordError() {
  budget.errors += 1;
  budget.consecutiveErrors += 1;
  const cbCfg = getLlmConfig().circuitBreaker || {};
  const maxErrors = cbCfg.maxConsecutiveErrors || 3;
  const cooldown = cbCfg.cooldownMs || 300000;
  if (budget.consecutiveErrors >= maxErrors) {
    budget.disabled = true;
    budget.disabledUntil = Date.now() + cooldown;
    llmWarn('circuit_breaker', { detail: `disabled for ${cooldown/1000}s after ${maxErrors} consecutive errors` });
  }
}

function clearErrorStreak() {
  budget.consecutiveErrors = 0;
}

// ─── Cache (in-memory, TTL-based) ────────────────────────────────────────────

const _cache = new Map();

function getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return undefined; }
  return entry.value;
}

function setCache(key, value) {
  _cache.set(key, { value, ts: Date.now() });
  if (_cache.size > 200) {
    // Evict oldest
    let oldestKey = null, oldestTs = Infinity;
    for (const [k, v] of _cache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    if (oldestKey) _cache.delete(oldestKey);
  }
}

// ─── Provider: Copilot Business API ──────────────────────────────────────────

let _copilotToken = null;
let _tokenExpiresAt = 0;

async function refreshCopilotToken() {
  const { findCopilotOAuthToken, PROVIDERS, COPILOT_GITHUB_API_VERSION } = await getProviders();
  const oauthToken = findCopilotOAuthToken();
  if (!oauthToken) return null;

  try {
    const extraHeaders = PROVIDERS.copilot.extraHeaders;
    const { stdout } = await execFileAsync("curl", [
      "-sk",
      "-H", `Authorization: token ${oauthToken}`,
      "-H", `Editor-Version: ${extraHeaders['Editor-Version']}`,
      "-H", `Editor-Plugin-Version: ${extraHeaders['Editor-Plugin-Version']}`,
      "-H", `Copilot-Integration-Id: ${extraHeaders['Copilot-Integration-Id']}`,
      "-H", `X-GitHub-Api-Version: ${COPILOT_GITHUB_API_VERSION}`,
      "https://api.github.com/copilot_internal/v2/token"
    ], { timeout: 15000 });

    const data = JSON.parse(stdout);
    if (!data.token) return null;

    _copilotToken = data.token;
    _tokenExpiresAt = Date.now() + 25 * 60 * 1000;

    // Update shared cache for other tools (copilot skill scripts)
    try {
      const { getTempDir } = await getProviders();
      const cacheFile = path.join(getTempDir(), "copilot_token_cache.json");
      fs.writeFileSync(cacheFile, JSON.stringify(data));
    } catch {}

    return _copilotToken;
  } catch (e) {
    llmError('auth_failure', { provider: 'copilot', error: (e.message || "").slice(0, 100) });
    return null;
  }
}


// ─── Provider: AWS Bedrock (Models via AWS) ─────────────────────────

/**
 * Call models via AWS Bedrock invoke-model.
 * Uses `aws bedrock-runtime invoke-model` CLI (inherits SSO/profile credentials).
 * Same Messages API format as Anthropic direct, but routed through corporate AWS.
 * @returns {{ content, usage, provider }|null}
 */
async function _callBedrock(messages, { maxTokens = 1024, temperature = 0.3, fallback, task = null }) {
  const { model, region } = fallback;

  // Bedrock Messages API: system is a separate field
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');

  const noTemp = /opus|o[1-9]-|codex/i.test(model);
  const payload = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: chatMsgs,
    ...(noTemp ? {} : { temperature }),
  });

  const tmpDir = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const ts = Date.now();
  const bodyFile = path.join(tmpDir, `brain-bedrock-${ts}.json`);
  const outFile = path.join(tmpDir, `brain-bedrock-${ts}-resp.json`);
  fs.writeFileSync(bodyFile, payload, 'utf-8');

  const profile = BEDROCK_AWS_PROFILE;
  const modelArn = bedrockModelArn(model, region, BEDROCK_ACCOUNT_ID);
  const awsArgs = [
    'bedrock-runtime', 'invoke-model',
    '--model-id', modelArn,
    '--region', region,
    '--body', `fileb://${bodyFile.replace(/\\/g, '/')}`,
    '--content-type', 'application/json',
    outFile.replace(/\\/g, '/')
  ];

  try {
    try {
      await execFileAsync('aws', awsArgs, {
        timeout: getTimeout("bedrock", task || (maxTokens > 1000 ? "distill" : "default")),
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, AWS_PROFILE: profile }
      });
    } finally {
      try { fs.unlinkSync(bodyFile); } catch {}
    }

    let responseText;
    try {
      responseText = fs.readFileSync(outFile, 'utf-8');
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }

    let response;
    try {
      response = JSON.parse(responseText);
    } catch {
      llmError('parse_error', { provider: 'bedrock', error: (responseText || '').slice(0, 200) });
      return null;
    }

    if (response.error) {
      llmError('api_error', { provider: 'bedrock', error: (response.error.message || JSON.stringify(response.error)).slice(0, 150) });
      return null;
    }

    // Bedrock response = same as Anthropic Messages API: content[0].text
    const content = response.content?.[0]?.text || null;
    const usage = response.usage || null;

    if (!content) {
      llmWarn('provider_error', { provider: 'bedrock', error: 'empty content in response' });
      return null;
    }

    clearErrorStreak();
    llmInfo('llm_success', { provider: 'bedrock', model, chars: content.length });
    return { content, usage, provider: 'bedrock' };
  } catch (e) {
    const msg = (e.message || '').slice(0, 200);
    const stderr = (e.stderr || '').toString().slice(0, 200);
    if (/ExpiredToken|NoCredentials|InvalidIdentityToken/i.test(msg + stderr)) {
      llmError('auth_failure', { provider: 'bedrock', detail: 'AWS credentials expired — run: aws sso login --profile LAIA' });
    } else if (e.killed || /timed out|SIGTERM/i.test(msg)) {
      const actualTimeout = getTimeout("bedrock", task || (maxTokens > 1000 ? "distill" : "default"));
      llmError('timeout', { provider: 'bedrock', latencyMs: actualTimeout });
    } else {
      llmError('provider_error', { provider: 'bedrock', error: msg + (stderr ? ' | ' + stderr : '') });
    }
    return null;
  }
}

// ─── P12.5: Fallback provider call ───────────────────────────────────────────

/**
 * Call an alternative LLM provider (Ollama or OpenAI-compatible).
 * Uses standard Chat Completions API format.
 * Returns { content, usage, provider } or null.
 */
async function _callFallback(messages, { maxTokens, temperature, fallback, task = null }) {
  const { provider, baseUrl, model, apiKey } = fallback;

  // Ollama: check health before attempting (lazy, cached)
  if (provider === "ollama") {
    const healthy = await isOllamaHealthy(baseUrl);
    if (!healthy) {
      llmWarn('provider_skip', { provider: 'ollama', detail: 'not reachable' });
      return null;
    }
  }

  // OpenAI: require API key
  if (provider === "openai" && !apiKey) {
    llmWarn('provider_skip', { provider: 'openai', detail: 'no API key' });
    return null;
  }

  // P12.5b: GenAI Lab — call Python script as subprocess (health check: CDP must be active)
  if (provider === "genailab") {
    const scriptPath = fallback.scriptPath || path.join(process.env.HOME || process.env.USERPROFILE || "", ".laia", "genai_lab_chat.py");
    const healthy = await isGenAiLabHealthy(scriptPath);
    if (!healthy) {
      llmWarn('provider_skip', { provider: 'genailab', detail: 'CDP/Edge not running' });
      return null;
    }
    return _callGenAiLab(messages, { ...fallback, task });
  }

  // AWS Bedrock — Models via corporate AWS (Messages API format)
  if (provider === "bedrock") {
    return _callBedrock(messages, { maxTokens, temperature, fallback, task });
  }

  // Build endpoint
  const endpoint = provider === "ollama"
    ? `${baseUrl}/v1/chat/completions`
    : `${baseUrl}/chat/completions`;

  // Standard Chat Completions payload (works for both Ollama and OpenAI)
  // Skip temperature for reasoning models that don't support it
  const noTemp = /opus|o[1-9]-|codex/i.test(model);
  const payload = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    ...(noTemp ? {} : { temperature }),
    stream: false
  });

  const tmpFile = path.join(
    process.env.TEMP || process.env.TMPDIR || "/tmp",
    `brain-fb-${Date.now()}.json`
  );
  fs.writeFileSync(tmpFile, payload, "utf-8");

  const curlArgs = ["-s", "--max-time", String(Math.ceil(getTimeout(provider, task || "default") / 1000))];

  // SSL: corporate CA bundle or skip verify for localhost
  if (provider === "ollama") {
    // Localhost, no SSL needed
  } else {
    const caCert = process.env.NODE_EXTRA_CA_CERTS;
    if (caCert && fs.existsSync(caCert)) {
      curlArgs.push("--cacert", caCert);
    } else {
      curlArgs.push("-k");
    }
  }

  // Auth header
  if (apiKey) {
    curlArgs.push("-H", `Authorization: Bearer ${apiKey}`);
  }

  curlArgs.push(
    "-H", "Content-Type: application/json",
    "-d", `@${tmpFile}`,
    endpoint
  );

  try {
    let stdout;
    try {
      ({ stdout } = await execFileAsync("curl", curlArgs, { timeout: getTimeout(provider, task || "default") + 5000, maxBuffer: 2 * 1024 * 1024 }));
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    let response;
    try {
      response = JSON.parse(stdout);
    } catch {
      llmError('parse_error', { provider, error: (stdout || "").slice(0, 200) });
      return null;
    }

    if (response.error) {
      llmError('api_error', { provider, error: (response.error.message || JSON.stringify(response.error)).slice(0, 150) });
      return null;
    }

    // Standard Chat Completions response format
    const content = response.choices?.[0]?.message?.content;
    const usage = response.usage || null;

    if (!content) {
      llmWarn('provider_error', { provider, error: 'empty content in response' });
      return null;
    }

    // Fallback succeeded — clear primary error streak too
    clearErrorStreak();
    llmInfo('llm_success', { provider, model });
    return { content, usage, provider };
  } catch (e) {
    llmError('provider_error', { provider, error: (e.message || "").slice(0, 150) });
    return null;
  }
}

async function getCopilotToken() {
  if (_copilotToken && Date.now() < _tokenExpiresAt) return _copilotToken;

  // Try shared cache first (written by /copilot skill or other scripts)
  try {
    const { getTempDir } = await getProviders();
    const cacheFile = path.join(getTempDir(), "copilot_token_cache.json");
    const stat = fs.statSync(cacheFile);
    if ((Date.now() - stat.mtimeMs) / 1000 < 1500) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      if (data.token) {
        _copilotToken = data.token;
        _tokenExpiresAt = Date.now() + Math.min(25 * 60 * 1000, (stat.mtimeMs + 1500000) - Date.now());
        return _copilotToken;
      }
    }
  } catch {}

  return refreshCopilotToken();
}

/**
 * Check if LLM enhancement is available (primary OR fallback).
 */
export function isLlmAvailable() {
  if (LLM_MODE === "false") return false;
  if (budget.disabled) {
    // Half-open: allow retry after cooldown
    if (budget.disabledUntil && Date.now() >= budget.disabledUntil) {
      return true; // canSpend() will handle the actual re-enable
    }
    // Even if primary circuit breaker is open, alternative providers in chain may be available
    if (hasAlternativeProviders()) return true;
    return false;
  }
  if (LLM_MODE === "true") return true;
  // "auto": available if Copilot apps.json exists OR fallback configured
  const findFn = _providers?.findCopilotAppsJson ?? _findAppsJsonFallback;
  return findFn() !== null || hasAlternativeProviders();
}

/**
 * Call the LLM and return parsed response content.
 * Returns { content, usage } or null on failure.
 */
// ─── Test hooks (underscore-prefixed = internal-only) ─────────────────────────

let _mockCallLlm = null;

/** Reset all internal state for testing. @param {number} [budgetOverride] optional budget limit */
export function _testReset(budgetOverride) {
  budget.used = 0;
  budget.calls = 0;
  budget.errors = 0;
  budget.consecutiveErrors = 0;
  budget.disabled = false;
  budget.disabledUntil = 0;
  _budgetWarningFired = false;
  _cache.clear();
  _mockCallLlm = null;
  // P12.5: reset ollama health cache
  _ollamaHealthy = null;
  _ollamaHealthCheckedAt = 0;
  if (budgetOverride !== undefined) LLM_BUDGET_LIMIT = budgetOverride;
}

/** Inject mock callLlm function for testing. Pass null to restore real implementation. */
export function _setMockCallLlm(fn) {
  _mockCallLlm = fn;
}

// ─── callLlm (primary: Copilot, fallback: P12.5) ──────────────────────────────

// Models that require /responses endpoint instead of /chat/completions
const RESPONSES_API_MODELS = new Set(["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-max"]);

// P12.5: Failover-worthy error classes (Codex must-fix #1)
const FAILOVER_ERRORS = new Set(["auth", "token", "circuit_breaker", "timeout", "rate_limit", "server_error"]);

function classifyError(e, response) {
  if (e?.code === "ETIMEDOUT" || e?.killed) return "timeout";
  if (response?.error?.code === 401 || response?.error?.status === 401) return "auth";
  if (response?.error?.code === 429) return "rate_limit";
  const status = response?.error?.status || response?.error?.code;
  if (status >= 500) return "server_error";
  if (budget.disabled) return "circuit_breaker";
  return "unknown";
}

async function callLlm(messages, { maxTokens = 1024, temperature = 0.1, model = null, task = null } = {}) {
  if (_mockCallLlm) return _mockCallLlm(messages, { maxTokens, temperature });

  // Auto-select model per task: heavy tasks (distill, compact) → modelHeavy, rest → model (fast)
  const effectiveModel = model || getModelForTask(task);

  // Per-task provider chain: iterate providers in order, first success wins
  const chain = getProviderChain(task);

  for (const provider of chain) {
    try {
      let result = null;
      if (provider === "copilot") {
        result = await _callCopilot(messages, { maxTokens, temperature, model: effectiveModel, task });
      } else {
        // Build fallback config from llm-config.json provider section
        const fbConfig = _buildProviderConfig(provider);
        if (fbConfig) {
          result = await _callFallback(messages, { maxTokens, temperature, fallback: fbConfig, task });
        }
      }
      if (result) return result;
      llmWarn('chain_fallback', { provider, task: task || "default" });
    } catch (e) {
      llmError('chain_error', { provider, task: task || "default", error: e.message });
    }
  }

  return null;
}

/** Build provider config object from llm-config.json for non-Copilot providers. */
function _buildProviderConfig(providerName) {
  const cfg = getLlmConfig();
  const pCfg = cfg.providers?.[providerName];
  if (!pCfg) return null;

  if (providerName === "bedrock") {
    return {
      provider: "bedrock",
      model: pCfg.model || BEDROCK_DEFAULT_MODEL,
      region: pCfg.region || BEDROCK_REGION
    };
  }
  if (providerName === "ollama") {
    return {
      provider: "ollama",
      baseUrl: pCfg.baseUrl || "http://localhost:11434",
      model: pCfg.model || "qwen2.5:7b",
      apiKey: null
    };
  }
  if (providerName === "genailab") {
    return {
      provider: "genailab",
      agent: pCfg.agent || "default",
      scriptPath: path.join(process.env.HOME || process.env.USERPROFILE || "", ".laia", "genai_lab_chat.py"),
      model: pCfg.agent || "default"
    };
  }
  return null;
}

async function _callCopilot(messages, { maxTokens, temperature, model, task }) {
  // Skip Copilot entirely when circuit breaker is active — go straight to fallback
  if (budget.disabled && budget.disabledUntil && Date.now() < budget.disabledUntil) {
    return null;
  }
  const token = await getCopilotToken();
  if (!token) { recordError(); return null; }

  const selectedModel = (model && ALLOWED_MODELS.has(model)) ? model : LLM_MODEL;
  const useResponsesApi = RESPONSES_API_MODELS.has(selectedModel);

  let payload, endpoint;

  // Models that don't support temperature (reasoning models like claude-opus, o1, o3, codex)
  const noTemperatureModels = /opus|o[1-9]-|codex/i;
  const supportsTemperature = !noTemperatureModels.test(selectedModel);

  if (useResponsesApi) {
    // OpenAI Responses API format — codex/reasoning models don't support temperature
    const systemMsg = messages.find(m => m.role === "system");
    const userMsgs = messages.filter(m => m.role !== "system");
    const inputText = userMsgs.map(m => m.content).join("\n\n");
    payload = JSON.stringify({
      model: selectedModel,
      instructions: systemMsg?.content || undefined,
      input: inputText,
      max_output_tokens: maxTokens,
      ...(supportsTemperature ? { temperature } : {}),
      stream: false
    });
    endpoint = "https://api.business.githubcopilot.com/responses";
  } else {
    // Standard Chat Completions API format
    payload = JSON.stringify({
      model: selectedModel,
      messages,
      max_tokens: maxTokens,
      ...(supportsTemperature ? { temperature } : {}),
      stream: false
    });
    endpoint = "https://api.business.githubcopilot.com/chat/completions";
  }

  try {
    // Write payload to temp file to avoid encoding issues with curl -d on Windows
    const { getTempDir, PROVIDERS } = await getProviders();
    const tmpFile = path.join(getTempDir(), `brain-llm-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, payload, "utf-8");

    // Build curl args — add --cacert for corporate Zscaler CA bundle if present
    const curlArgs = ["-s"];
    const caCert = process.env.NODE_EXTRA_CA_CERTS;
    if (caCert && fs.existsSync(caCert)) {
      curlArgs.push("--cacert", caCert);
    } else {
      curlArgs.push("-k");
    }

    // Copilot timeouts: from llm-config.json, task-aware
    const curlTimeout = getTimeout("copilot", task || (maxTokens > 1000 ? "distill" : "default"));
    // Double protection: curl --max-time + Node.js process timeout
    curlArgs.push("--max-time", String(Math.ceil(curlTimeout / 1000)));

    const { 'Editor-Version': ev, 'Editor-Plugin-Version': epv, 'Copilot-Integration-Id': cii } =
      PROVIDERS.copilot.extraHeaders;
    curlArgs.push(
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Content-Type: application/json",
      "-H", `Editor-Version: ${ev}`,
      "-H", `Editor-Plugin-Version: ${epv}`,
      "-H", `Copilot-Integration-Id: ${cii}`,
      "-d", `@${tmpFile}`,
      endpoint
    );
    let stdout;
    try {
      ({ stdout } = await execFileAsync("curl", curlArgs, { timeout: curlTimeout, maxBuffer: 2 * 1024 * 1024 }));
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    let response;
    try {
      response = JSON.parse(stdout);
    } catch (parseErr) {
      llmError('parse_error', { provider: 'copilot', error: (stdout || "").trim().slice(0, 300) });
      recordError();
      return null;
    }

    if (response.error) {
      llmError('api_error', { provider: 'copilot', error: (response.error.message || JSON.stringify(response.error)).slice(0, 100) });
      if (response.error.code === 401 || response.error.status === 401) {
        _copilotToken = null;
        _tokenExpiresAt = 0;
      }
      recordError();
      return null;
    }

    // Extract content from either API format
    let content, usage;
    if (useResponsesApi) {
      // Responses API: output[0].content[0].text or output_text
      content = response.output_text
        || response.output?.[0]?.content?.[0]?.text
        || null;
      usage = response.usage || null;
    } else {
      // Chat Completions API
      content = response.choices?.[0]?.message?.content;
      usage = response.usage || null;
    }

    if (!content) { recordError(); return null; }

    clearErrorStreak();
    llmInfo('llm_success', { provider: 'copilot', model: selectedModel, chars: content.length, task: task || "default" });
    return { content, usage };
  } catch (e) {
    if (e.killed || e.signal) {
      llmError('timeout', { provider: 'copilot', model: selectedModel, latencyMs: curlTimeout, task: task || "default", detail: `signal=${e.signal || "SIGTERM"}` });
    } else {
      const code = e.code ?? e.status ?? "?";
      const stderr = (e.stderr || "").trim().slice(0, 300);
      const stdout = (e.stdout || "").trim().slice(0, 200);
      llmError('provider_error', { provider: 'copilot', error: `exit:${code}`, detail: (stderr || stdout || "").slice(0, 200) });
    }
    recordError();
    return null;
  }
}

/** Parse JSON from LLM response, handling markdown code fences and broken escaping. */
function parseJsonResponse(text) {
  // Step 1: Strip outer markdown code fences (greedy — first opening, last closing)
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[^\n]*\n/, "");
    const lastFence = cleaned.lastIndexOf("```");
    if (lastFence !== -1) cleaned = cleaned.slice(0, lastFence).trimEnd();
  }
  
  // Step 2: Try direct parse (fast path)
  try { return JSON.parse(cleaned); } catch {}
  
  // Step 3: Extract JSON object/array if surrounded by prose
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  const extracted = objMatch?.[0] || arrMatch?.[0];
  if (extracted && extracted !== cleaned) {
    try { return JSON.parse(extracted); } catch {}
    cleaned = extracted;
  }
  
  // Step 4: Structural extraction — find key-value pairs by locating JSON keys
  // and extracting values between them. Handles unescaped content in string values.
  try {
    // Identify all top-level JSON key positions
    const keyPattern = /"(title|content|tags)"\s*:/g;
    const keys = [];
    let m;
    while ((m = keyPattern.exec(cleaned)) !== null) {
      keys.push({ key: m[1], pos: m.index, afterColon: m.index + m[0].length });
    }
    
    if (keys.length >= 2) {
      const result = {};
      
      for (let i = 0; i < keys.length; i++) {
        const { key, afterColon } = keys[i];
        const valueStart = cleaned.indexOf('"', afterColon);
        
        if (key === 'tags') {
          // Tags is an array — extract [...]
          const arrStart = cleaned.indexOf('[', afterColon);
          const arrEnd = cleaned.indexOf(']', arrStart);
          if (arrStart !== -1 && arrEnd !== -1) {
            try {
              result.tags = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
            } catch {
              // Extract strings manually
              const tagMatches = cleaned.slice(arrStart, arrEnd).match(/"([^"]+)"/g);
              result.tags = tagMatches ? tagMatches.map(t => t.replace(/"/g, '')) : [];
            }
          }
        } else {
          // String value — find boundaries
          if (valueStart === -1) continue;
          
          // End boundary: next key's position (minus comma/whitespace) or end of object
          let valueEnd;
          if (i + 1 < keys.length) {
            // Walk backwards from next key to find the closing quote
            valueEnd = cleaned.lastIndexOf('"', keys[i + 1].pos - 1);
          } else {
            // Last key — find closing quote before final }
            const lastBrace = cleaned.lastIndexOf('}');
            valueEnd = cleaned.lastIndexOf('"', lastBrace - 1);
          }
          
          if (valueEnd > valueStart) {
            const raw = cleaned.slice(valueStart + 1, valueEnd);
            // Properly escape for JSON
            result[key] = raw
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t');
            // Now unescape to get the actual value
            try {
              result[key] = JSON.parse('"' + result[key] + '"');
            } catch {
              // Use raw with basic cleanup
              result[key] = raw.replace(/\n/g, '\n').replace(/\t/g, '\t');
            }
          }
        }
      }
      
      if (result.title || result.content) return result;
    }
  } catch {}
  
  // Step 5: Last resort — fix unescaped newlines globally
  try {
    const fixed = cleaned.replace(/([^\\])\n/g, '$1\\n');
    return JSON.parse(fixed);
  } catch {}
  
  throw new SyntaxError(`parseJsonResponse: unable to parse (${cleaned.length} chars)`);
}

// ─── Task: Rerank ────────────────────────────────────────────────────────────

/**
 * Rerank search candidates using LLM semantic understanding.
 * @param {string} query - The original search query
 * @param {Array} candidates - Array of { slug, title, tags, body/snippet, score }
 * @returns {string[]|null} Array of slugs in reranked order, or null
 */
export async function llmRerank(query, candidates) {
  if (!isLlmAvailable() || !isTaskEnabled("rerank")) return null;
  if (!candidates || candidates.length <= 3) return null;

  const normQuery = query.toLowerCase().trim();
  const cacheKey = `rerank:${normQuery}:${candidates.slice(0, 20).map(c => c.slug).join(",")}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  if (!reserve(COSTS.rerank)) return null;

  const top = candidates.slice(0, 20);
  const candidateList = top.map((c, i) => {
    const tags = (c.tags || []).slice(0, 5).join(", ");
    const title = (c.title || c.slug || "").slice(0, 100);
    const body = (c.body || c.headline || "").slice(0, 150).replace(/\n/g, " ");
    return `${i + 1}. [${c.slug}] ${title} (tags: ${tags}) — ${body}`;
  }).join("\n");

  const result = await callLlm([{
    role: "user",
    content: `Given search query: "${query}"\n\nRank these results by relevance. Return ONLY a JSON array of slug strings, most relevant first.\n\nResults:\n${candidateList}`
  }], { maxTokens: 512, temperature: 0, task: "rerank" });

  if (!result) { refund(COSTS.rerank); return null; }

  try {
    const slugs = parseJsonResponse(result.content);
    if (!Array.isArray(slugs) || slugs.length === 0) return null;
    const validSlugs = new Set(top.map(c => c.slug));
    const filtered = slugs.filter(s => typeof s === "string" && validSlugs.has(s));
    if (filtered.length === 0) return null;
    setCache(cacheKey, filtered);
    return filtered;
  } catch {
    llmWarn('parse_error', { task: 'rerank', error: 'JSON parse failed' });
    return null;
  }
}

// ─── Task: Query Expansion ───────────────────────────────────────────────────

/**
 * Expand query with semantically related terms.
 * @param {string} query - The original search query
 * @returns {string[]|null} Array of expansion terms, or null
 */
export async function llmExpandQuery(query) {
  if (!isLlmAvailable() || !isTaskEnabled("expand")) return null;

  const cacheKey = `expand:${query.toLowerCase().trim()}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  if (!reserve(COSTS.expansion)) return null;

  const result = await callLlm([{
    role: "user",
    content: `Given search query: "${query}"\n\nSuggest 3-5 semantically related search terms for a personal knowledge base (software engineering context). Single words or short phrases, lowercase.\n\nReturn ONLY a JSON array of strings.`
  }], { maxTokens: 200, temperature: 0.2, task: "expand" });

  if (!result) { refund(COSTS.expansion); return null; }

  try {
    const terms = parseJsonResponse(result.content);
    if (!Array.isArray(terms) || terms.length === 0) return null;
    const clean = [...new Set(
      terms.map(t => String(t).toLowerCase().trim()).filter(t => t.length > 0 && t.length < 50)
    )];
    if (clean.length === 0) return null;
    setCache(cacheKey, clean);
    return clean;
  } catch {
    llmWarn('parse_error', { task: 'expand', error: 'JSON parse failed' });
    return null;
  }
}

// ─── Task: Auto-Tags ─────────────────────────────────────────────────────────

/**
 * Suggest tags for a learning based on its content.
 * @param {string} title - Learning title
 * @param {string} content - Learning body (will be truncated)
 * @param {string[]} existingTags - Tags already applied (to avoid duplicates)
 * @returns {string[]|null} Array of suggested new tags, or null
 */
export async function llmAutoTags(title, content, existingTags = [], aliasMap = null) {
  if (!isLlmAvailable() || !isTaskEnabled("autotags")) return null;

  const truncated = (content || "").slice(0, 800);
  const existingSet = new Set((existingTags || []).map(t => t.toLowerCase()));

  // P7.5+: Build canonical tag hint from alias map values (deduped)
  let canonicalHint = "";
  if (aliasMap && Object.keys(aliasMap).length > 0) {
    const canonicals = [...new Set(Object.values(aliasMap))];
    canonicalHint = `\nPrefer these canonical tags when applicable (don't invent synonyms): ${canonicals.join(", ")}`;
  }

  if (!reserve(COSTS.autotags)) return null;

  const result = await callLlm([{
    role: "user",
    content: `Extract 3-5 descriptive tags for this knowledge note. Tags: lowercase, hyphens for multi-word, specific and useful for search.${canonicalHint}\n\nTitle: ${title}\nContent: ${truncated}\nExisting tags: ${[...existingSet].join(", ") || "(none)"}\n\nReturn ONLY a JSON array of NEW tags (not already in existing). Example: ["spark", "date-parsing"]`
  }], { maxTokens: 200, temperature: 0.1, task: "autotags" });

  if (!result) { refund(COSTS.autotags); return null; }

  try {
    const tags = parseJsonResponse(result.content);
    if (!Array.isArray(tags) || tags.length === 0) return null;
    let clean = [...new Set(
      tags.map(t => String(t).toLowerCase().trim().replace(/[^a-z0-9-]/g, ""))
    )].filter(t => t.length > 1 && t.length < 40 && !existingSet.has(t));
    // P7.5+: Normalize through alias map to prevent synonym drift
    if (aliasMap) {
      clean = clean.map(t => aliasMap[t] || t);
      clean = [...new Set(clean)].filter(t => !existingSet.has(t));
    }
    return clean.length > 0 ? clean : null;
  } catch {
    llmWarn('parse_error', { task: 'autotags', error: 'JSON parse failed' });
    return null;
  }
}

// ─── Task: Distillation (draft only, never auto-saved) ──────────────────────

/**
 * Generate a principle draft from a cluster of learnings.
 * Returns a draft object for human review, NOT auto-saved.
 * @param {Array} learnings - Array of { slug, title, tags, body }
 * @param {string[]} clusterTags - Union of tags in the cluster
 * @returns {{ title: string, content: string, tags: string[], sources: string[] }|null}
 */
export async function llmDistill(learnings, clusterTags) {
  if (!isLlmAvailable() || !isTaskEnabled("distill")) return null;
  if (!learnings || learnings.length < 3) return null;

  if (!reserve(COSTS.distill)) return null;

  const TOTAL_CHARS_BUDGET = 40_000;
  const PER_NOTE_MAX = 8_000;
  const PER_NOTE_MIN = 500;
  const perNoteLimit = Math.min(PER_NOTE_MAX, Math.max(PER_NOTE_MIN, Math.floor(TOTAL_CHARS_BUDGET / learnings.length)));

  const notesList = learnings.slice(0, 12).map((l, i) => {
    const body = (l.body || l.headline || "").slice(0, perNoteLimit);
    return `${i + 1}. [${l.slug}] "${l.title}" (tags: ${(l.tags || []).slice(0, 5).join(", ")})\n${body}`;
  }).join("\n\n---\n");

  const result = await callLlm([{
    role: "user",
    content: `You are distilling ${learnings.length} related knowledge notes into ONE structured Markdown reference note.

Notes:
${notesList}

Write a well-structured Markdown document that synthesizes ALL the notes above:
- Use headers (##, ###) to create logical sections and hierarchy
- Use code blocks (\`\`\`) for commands, YAML, config snippets, and code
- Use bullet lists for options, steps, or enumerable items
- Preserve ALL specific details: commands, flags, config values, thresholds, URLs
- If sources had structure, preserve and enhance it; if not, create meaningful sections
- Aim for a scannable reference guide, not a paragraph summary

Return a SINGLE JSON object (NOT an array):
{
  "title": "Short descriptive title (max 80 chars)",
  "content": "The full markdown content",
  "tags": ["3-5 tags for this principle"]
}

IMPORTANT: Return exactly ONE JSON object. Do NOT return an array of objects. Synthesize ALL notes into ONE document.`
  }], { maxTokens: 3000, temperature: 0.2, task: "distill" });

  if (!result) { refund(COSTS.distill); return null; }

  try {
    let parsed = parseJsonResponse(result.content);
    // Haiku sometimes returns an array of objects instead of a single object
    if (Array.isArray(parsed) && parsed.length > 0) {
      const items = parsed.filter(p => p && typeof p === 'object');
      if (items.length > 0) {
        const titles = items.map(p => p.title || p.name || p.slug || '').filter(Boolean);
        // Try ALL possible content field names
        const contentFields = ['content', 'body', 'summary', 'description', 'text', 'note', 'markdown'];
        const contents = items.map(p => {
          for (const f of contentFields) { if (p[f]) return p[f]; }
          // Last resort: stringify the whole object minus title/tags
          const { title: _t, tags: _tg, name: _n, slug: _s, ...rest } = p;
          const vals = Object.values(rest).filter(v => typeof v === 'string' && v.length > 20);
          return vals.join('\n\n') || '';
        }).filter(Boolean);
        const allTags = [...new Set(items.flatMap(p => p.tags || []))];
        parsed = {
          title: titles[0] || 'Distilled Reference',
          content: contents.join('\n\n---\n\n'),
          tags: allTags.slice(0, 6)
        };
      }
    }
    if (!parsed.title || !parsed.content) {
      llmWarn('parse_error', { task: 'distill', error: `missing fields (title: ${!!parsed.title}, content: ${!!parsed.content})`, detail: Object.keys(parsed).join(',') });
      // Retry with simplified prompt if parsing failed
      llmInfo('retry', { task: 'distill', detail: 'retrying with simplified prompt' });
      const retryResult = await callLlm([{
        role: "user",
        content: `Summarize these ${learnings.length} notes into one reference document.

Titles:
${learnings.map((l, i) => `${i + 1}. ${l.title}`).join('\n')}

Return ONLY this exact JSON format (no arrays, no extra text):
{"title": "...", "content": "...", "tags": ["..."]}

The content field must contain the full markdown synthesis.`
      }], { maxTokens: 3000, temperature: 0.2, task: "distill" });
      
      if (retryResult) {
        try {
          const retryParsed = parseJsonResponse(retryResult.content);
          if (!Array.isArray(retryParsed) && retryParsed.title && retryParsed.content) {
            return {
              title: String(retryParsed.title).slice(0, 120),
              content: String(retryParsed.content),
              tags: (retryParsed.tags || clusterTags || []).map(t => String(t).toLowerCase().trim()).slice(0, 6),
              sources: learnings.map(l => l.slug)
            };
          }
        } catch {}
      }
      return null;
    }

    return {
      title: String(parsed.title).slice(0, 120),
      content: String(parsed.content),
      tags: (parsed.tags || clusterTags || []).map(t => String(t).toLowerCase().trim()).slice(0, 6),
      sources: learnings.map(l => l.slug)
    };
  } catch {
    llmWarn('parse_error', { task: 'distill', error: 'JSON parse failed' });
    return null;
  }
}

// ─── P9.3: Duplicate detection (1 unit) ─────────────────────────────────────

/**
 * Check if a new learning is semantically duplicate of existing candidates.
 * Called only for borderline cases (embedding/Jaccard pre-filtered).
 * @param {string} newTitle - Title of the new learning
 * @param {Array} candidates - Top candidates: [{slug, title, similarity, tagOverlap}]
 * @returns {{ slug: string, similarity: number, reason: string }|null}
 */
// ─── Task: Summarize search results (2 units) ───────────────────────────────

/**
 * Summarize search results before sending to LLM, reducing output tokens.
 * Uses the heavy model (codex) for better structured understanding.
 * @param {string} query - The original search query
 * @param {Array} results - Array of { slug, title, tags, body/headline, score }
 * @returns {string|null} Compact markdown summary, or null
 */
export async function llmSummarizeResults(query, results) {
  if (!isLlmAvailable() || !isTaskEnabled("summarize")) return null;
  if (!results || results.length <= 2) return null;

  if (!reserve(COSTS.summarize)) return null;

  const items = results.slice(0, 10).map((r, i) => {
    const body = (r.body || r.headline || "").slice(0, 200).replace(/\n/g, " ");
    return `${i + 1}. [${r.slug}] "${r.title}" (tags: ${(r.tags || []).slice(0, 4).join(",")}) — ${body}`;
  }).join("\n");

  const result = await callLlm([{
    role: "user",
    content: `Summarize these search results for query "${query}" in compact markdown. Keep slug references. Max 5 bullet points, each 1-2 lines. Omit low-relevance results.\n\nResults:\n${items}`
  }], { maxTokens: 512, temperature: 0.1, model: LLM_MODEL_HEAVY, task: "summarize" });

  if (!result) { refund(COSTS.summarize); return null; }
  return result.content;
}

// ─── Task: Compact context (3 units) ────────────────────────────────────────

/**
 * Compact brain_get_context output to reduce tokens sent to LLM.
 * Preserves structure but removes redundancy and verbose sections.
 * Uses the heavy model (codex) for better understanding.
 * @param {string} contextText - Full brain_get_context output
 * @param {number} targetChars - Target character count (approximate)
 * @returns {string|null} Compacted context, or null (use original)
 */
export async function llmCompactContext(contextText, targetChars = 3000, systemPrompt = null, maxTokensOverride = null) {
  if (!isLlmAvailable() || !isTaskEnabled("compact")) return null;
  if (!contextText || contextText.length < targetChars) return null;

  if (!reserve(COSTS.compact)) return null;

  const DEFAULT_SYSTEM = "You compact brain context for an AI coding assistant. NEVER remove or rewrite: code blocks, file paths, IDs (Jira keys, URLs, slugs), config keys, env var names, API endpoints, version numbers, numerical limits, concrete requirements, or TODO items. Preserve: user prefs, project info, pending TODOs, active warnings, key stats. Remove: verbose session narratives, redundant boilerplate, long lists of low-value items. Keep markdown structure. Output must be shorter than input. If you cannot reduce below target without dropping critical details, return the text unchanged.";

  const result = await callLlm([{
    role: "system",
    content: systemPrompt || DEFAULT_SYSTEM
  }, {
    role: "user",
    content: `Compact this brain context to ~${targetChars} chars while preserving all actionable info:\n\n${contextText.slice(0, 12000)}`
  }], { maxTokens: maxTokensOverride || 1500, temperature: 0.1, model: LLM_MODEL_HEAVY, task: "compact" });

  if (!result) { refund(COSTS.compact); return null; }

  // Only use compacted version if it's actually shorter
  if (result.content.length >= contextText.length * 0.9) return null;
  return result.content;
}

export async function llmCheckDuplicate(newTitle, candidates) {
  if (!isLlmAvailable() || !isTaskEnabled("duplicate")) return null;
  if (!candidates || candidates.length === 0) return null;

  // Cache key includes candidate slugs to avoid stale hits when candidates change
  const candidateFP = candidates.slice(0, 5).map(c => c.slug).sort().join(",");
  const cacheKey = `dup:${newTitle}|${candidateFP}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  if (!reserve(COSTS.duplicate)) return null;

  const validSlugs = new Set(candidates.slice(0, 5).map(c => c.slug));
  const candidateList = candidates.slice(0, 5).map((c, i) =>
    `${i + 1}. [${c.slug}] "${c.title}"`
  ).join("\n");

  const result = await callLlm([{
    role: "user",
    content: `Are any of these existing notes semantically duplicate of the new note?

New note: "${newTitle}"

Existing notes:
${candidateList}

Rate the most similar existing note. Return JSON:
{"slug": "slug-of-best-match", "similarity": 0.0-1.0, "reason": "brief explanation"}

Rules:
- similarity >= 0.85 means essentially the same knowledge, just worded differently
- similarity 0.65-0.84 means overlapping but with distinct aspects
- similarity < 0.65 means different topics
- If none are similar, return {"slug": null, "similarity": 0, "reason": "no match"}`
  }], { maxTokens: 200, temperature: 0.1, task: "duplicate" });

  if (!result) { refund(COSTS.duplicate); return null; }

  try {
    const parsed = parseJsonResponse(result.content);
    if (!parsed || typeof parsed.similarity !== "number") { refund(COSTS.duplicate); return null; }

    // No match: cache and return null to avoid repeated LLM calls
    if (!parsed.slug) {
      setCache(cacheKey, null);
      return null;
    }

    // Reject hallucinated slugs not in candidate list
    if (!validSlugs.has(String(parsed.slug))) {
      setCache(cacheKey, null);
      return null;
    }

    const value = {
      slug: String(parsed.slug),
      similarity: Math.max(0, Math.min(1, parsed.similarity)),
      reason: String(parsed.reason || "").slice(0, 200)
    };
    setCache(cacheKey, value);
    return value;
  } catch {
    llmWarn('parse_error', { task: 'duplicate', error: 'JSON parse failed' });
    refund(COSTS.duplicate);
    return null;
  }
}


// ─── P14.3: Value assessment gate ───────────────────────────────────────────

/**
 * Assess whether a learning is worth storing.
 * Returns { score: 0-1, reason: string } or null if LLM unavailable.
 * score < 0.3: reject, 0.3-0.5: warn "low value", > 0.5: accept.
 */
export async function llmAssessValue(title, body, type) {
  if (!isLlmAvailable() || !isTaskEnabled("assess")) return null;

  const cacheKey = `assess:${title}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  if (!reserve(COSTS.assess)) return null;

  const result = await callLlm([{
    role: "user",
    content: `Assess this learning's value for a personal knowledge base. Rate 0.0-1.0.

Title: "${title}"
Type: ${type}
Body: ${body.slice(0, 500)}

Criteria:
- Actionable? (does it help avoid errors or save time?)
- Specific? (contains concrete details, not vague advice?)
- Not obvious? (would an experienced dev not already know this?)
- Durable? (will this be useful in 3+ months?)

Return JSON: {"score": 0.0-1.0, "reason": "brief explanation"}
Nothing else.`
  }], { maxTokens: 100, temperature: 0.1, task: "assess" });

  if (!result) { refund(COSTS.assess); return null; }

  try {
    const json = JSON.parse(result.replace(/```json?\n?|```/g, "").trim());
    const score = Math.min(1, Math.max(0, Number(json.score) || 0));
    const assessed = { score, reason: String(json.reason || "").slice(0, 200) };
    setCache(cacheKey, assessed);
    return assessed;
  } catch {
    refund(COSTS.assess);
    return null;
  }
}

// P12.5: Test-only exports (underscore prefix = internal)
export { parseFallbackConfig as _parseFallbackConfig };
export { classifyError as _classifyError };
export { isOllamaHealthy as _isOllamaHealthy };
export { _callFallback };
export { callLlm };
