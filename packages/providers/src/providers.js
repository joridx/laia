// @claude/providers — Multi-provider registry for LLM API routing
// Shared between Claudia (CLI agent) and Brain (MCP server)
// Transport-agnostic: resolves WHAT to call, not HOW (fetch vs curl)

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform, tmpdir } from 'os';

// ─── Provider Registry ───────────────────────────────────────────────────────

export const PROVIDERS = {
  copilot: {
    id: 'copilot',
    baseUrl: 'https://api.business.githubcopilot.com',
    auth: 'copilot',           // special token exchange flow (apps.json)
    supports: { chat: true, responses: true, listModels: true },
    extraHeaders: {
      'Editor-Version': 'JetBrains-IC/2025.3',
      'Editor-Plugin-Version': 'copilot-intellij/1.5.66',
      'Copilot-Integration-Id': 'vscode-chat',
    },
    // Copilot proxy quirks: drops tool_calls with tool_choice:"auto" for Claude models
    quirks: { forceToolChoiceRequired: true, disableStreamingForClaude: true },
  },
  openai: {
    id: 'openai',
    baseUrlEnv: 'OPENAI_BASE_URL',
    baseUrlDefault: 'https://api.openai.com/v1',
    auth: 'bearer',            // Authorization: Bearer <key>
    tokenEnv: 'OPENAI_API_KEY',
    supports: { chat: true, responses: true, listModels: true },
    extraHeaders: {},
    quirks: {},
  },
  anthropic: {
    id: 'anthropic',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    baseUrlDefault: 'https://api.anthropic.com/v1',
    auth: 'anthropic',         // x-api-key: <key>
    tokenEnv: 'ANTHROPIC_API_KEY',
    supports: { chat: false, responses: false, messages: true, listModels: false },
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    quirks: {},
  },
  azure_openai: {
    id: 'azure_openai',
    // No baseUrl — resolved dynamically from AZURE_OPENAI_ENDPOINT + deployment
    auth: 'api-key',           // api-key: <key>
    tokenEnv: 'AZURE_OPENAI_API_KEY',
    endpointEnv: 'AZURE_OPENAI_ENDPOINT',
    deploymentEnv: 'AZURE_OPENAI_DEPLOYMENT',
    apiVersionEnv: 'AZURE_OPENAI_API_VERSION',
    apiVersionDefault: '2024-10-21',
    supports: { chat: true, responses: false, listModels: false },
    extraHeaders: {},
    quirks: {},
  },
  ollama: {
    id: 'ollama',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    baseUrlDefault: 'http://localhost:11434/v1',
    auth: 'none',
    supports: { chat: true, responses: false, listModels: true },
    extraHeaders: {},
    quirks: {},
  },
};

// ─── Model → Provider Detection ──────────────────────────────────────────────

/**
 * Resolve a model string to { providerId, model }.
 * Priority: explicit prefix ("openai:gpt-5") > pattern match > availability fallback > default.
 * @param {string} model - Model name, optionally prefixed with "provider:"
 * @param {object} [options]
 * @param {string} [options.defaultProvider] - Fallback provider (default: 'copilot')
 * @returns {{ providerId: string, model: string }}
 */
export function detectProvider(model, { defaultProvider } = {}) {
  const fallback = defaultProvider || process.env.CLAUDIA_DEFAULT_PROVIDER || 'copilot';

  if (typeof model !== 'string' || !model.trim()) {
    return { providerId: fallback, model: model || '' };
  }

  const m = model.toLowerCase().trim();

  // 1. Explicit prefix override: "provider:model"
  const match = m.match(/^([a-z_]+):(.+)$/);
  if (match && PROVIDERS[match[1]]) {
    return { providerId: match[1], model: match[2] };
  }

  // 2. Auto-detect by model name pattern
  const detected = detectByPattern(m);

  // 3. Availability guard: if detected provider's token env is not set,
  //    fall back to default provider. Prevents breaking existing users
  //    who have model=claude-opus-4.6 routed through Copilot.
  if (detected && !isProviderAvailable(detected.providerId)) {
    // Validate fallback is available too; cascade: fallback → copilot → ollama
    if (isProviderAvailable(fallback)) return { providerId: fallback, model };
    if (fallback !== 'copilot' && isProviderAvailable('copilot')) return { providerId: 'copilot', model };
    if (isProviderAvailable('ollama')) return { providerId: 'ollama', model };
    return { providerId: fallback, model }; // let it fail at token resolution
  }

  return detected || { providerId: fallback, model };
}

function detectByPattern(m) {
  if (m.startsWith('claude-'))                          return { providerId: 'anthropic', model: m };
  if (m.startsWith('gpt-') || /^o[134]-/.test(m))      return { providerId: 'openai', model: m };
  if (m.includes('codex'))                              return { providerId: 'openai', model: m };
  if (/^(llama|mistral|qwen|deepseek|gemma)/.test(m))  return { providerId: 'ollama', model: m };
  return null;
}

// ─── Provider Availability ───────────────────────────────────────────────────

/**
 * Check if a provider has the required credentials configured.
 * - 'none': always available (ollama)
 * - 'copilot': available if apps.json exists
 * - others: available if the required env var is set
 */
export function isProviderAvailable(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return false;
  if (p.auth === 'none') return true;
  if (p.auth === 'copilot') return findCopilotAppsJson() !== null;
  return !!process.env[p.tokenEnv];
}

// ─── Provider Lookup ─────────────────────────────────────────────────────────

export function getProvider(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown provider: ${providerId}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

/**
 * Get the effective baseUrl for a provider (resolved at call time from env).
 * @param {object} provider - Provider config from PROVIDERS
 * @returns {string}
 */
export function getBaseUrl(provider) {
  if (provider.baseUrl) return provider.baseUrl; // static (copilot)
  if (provider.baseUrlEnv) return process.env[provider.baseUrlEnv] || provider.baseUrlDefault;
  return provider.baseUrlDefault || '';
}

// ─── Auth Header Builder ─────────────────────────────────────────────────────

/**
 * Build authentication headers for a provider.
 * Note: 'copilot' and 'bearer' produce identical headers — the distinction
 * is in how the token is obtained (token exchange vs env var).
 */
export function buildAuthHeaders(provider, token) {
  switch (provider.auth) {
    case 'bearer':    return { Authorization: `Bearer ${token}` };
    case 'copilot':   return { Authorization: `Bearer ${token}` };
    case 'api-key':   return { 'api-key': token };
    case 'anthropic': return { 'x-api-key': token };
    case 'none':      return {};
    default:          return {};
  }
}

// ─── Token Resolution ────────────────────────────────────────────────────────

/**
 * Resolve the auth token for a provider.
 * @param {object} provider - Provider config from PROVIDERS
 * @param {object} [options]
 * @param {function} [options.getCopilotToken] - Async function to get Copilot token (token exchange)
 * @returns {Promise<string|null>}
 */
export async function resolveToken(provider, { getCopilotToken } = {}) {
  if (provider.auth === 'none') return null;
  if (provider.auth === 'copilot') {
    if (!getCopilotToken) throw new Error('getCopilotToken callback required for Copilot provider');
    return getCopilotToken();
  }
  const key = process.env[provider.tokenEnv];
  if (!key) throw new Error(`Missing env var ${provider.tokenEnv} for provider ${provider.id}`);
  return key;
}

// ─── URL Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the full API URL for a provider + endpoint.
 * Azure OpenAI is a special case with deployment-based URLs.
 * @param {object} provider - Provider config from PROVIDERS
 * @param {string} endpoint - API endpoint (e.g. 'chat/completions', 'responses', 'models')
 * @returns {string}
 */
export function resolveUrl(provider, endpoint) {
  if (provider.id === 'azure_openai') {
    const base = process.env[provider.endpointEnv];
    const deployment = process.env[provider.deploymentEnv];
    if (!base || !deployment) throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT required');
    const apiVersion = process.env[provider.apiVersionEnv] || provider.apiVersionDefault;
    // Strip trailing slash from base
    const cleanBase = base.replace(/\/+$/, '');
    return `${cleanBase}/openai/deployments/${deployment}/${endpoint}?api-version=${apiVersion}`;
  }
  // Resolve baseUrl at call time (not import time)
  const baseUrl = getBaseUrl(provider);
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanEndpoint = endpoint.replace(/^\/+/, '');
  return `${cleanBase}/${cleanEndpoint}`;
}

// ─── Cross-Platform Utilities ────────────────────────────────────────────────

/**
 * Find the GitHub Copilot apps.json file (cross-platform).
 * Windows: %LOCALAPPDATA%\github-copilot\apps.json (primary)
 *          %APPDATA%\..\Local\github-copilot\apps.json (fallback)
 * Linux/macOS: ~/.config/github-copilot/apps.json
 * @returns {string|null} Full path or null if not found
 */
export function findCopilotAppsJson() {
  const candidates = [];

  if (platform() === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(join(process.env.LOCALAPPDATA, 'github-copilot', 'apps.json'));
    }
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, '..', 'Local', 'github-copilot', 'apps.json'));
    }
  } else {
    // Linux / macOS
    candidates.push(join(homedir(), '.config', 'github-copilot', 'apps.json'));
  }

  return candidates.find(p => existsSync(p)) || null;
}

/**
 * Get the temp directory (cross-platform).
 * Uses TEMP (Windows), TMPDIR (macOS), or os.tmpdir() as fallback.
 * @returns {string}
 */
export function getTempDir() {
  return process.env.TEMP || process.env.TMPDIR || tmpdir();
}
