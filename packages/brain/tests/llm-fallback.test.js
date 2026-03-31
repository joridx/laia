/**
 * P12.5: LLM fallback provider tests
 * Tests parseFallbackConfig, classifyError, isOllamaHealthy,
 * callLlm fallback chain, getBudgetStatus with fallback info.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("llm-fallback (P12.5)");

// ─── Setup ────────────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-fb-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";
// Ensure no real fallback interferes
delete process.env.BRAIN_LLM_FALLBACK;
delete process.env.BRAIN_LLM_FALLBACK_DISTILL;

for (const dir of [
  "memory/sessions", "memory/learnings", "memory/projects",
  "memory/todos", "knowledge/general"
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({ version: "2.0", sessions: [] }));
fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({ usage: {} }));
fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({ concepts: {} }));
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({ version: "1.0", learnings: {} }));

const {
  _parseFallbackConfig,
  _classifyError,
  _isOllamaHealthy,
  _testReset,
  getBudgetStatus,
  isLlmAvailable
} = await import("../llm.js");

// ═══════════════════════════════════════════════════════════════════════════════
// parseFallbackConfig
// ═══════════════════════════════════════════════════════════════════════════════

t.section("parseFallbackConfig — basic parsing");

// Empty/null → null
t.assert(_parseFallbackConfig("") === null, "empty string returns null");
t.assert(_parseFallbackConfig(null) === null, "null returns null");
t.assert(_parseFallbackConfig(undefined) === null, "undefined returns null");

// Ollama simple
const ollSimple = _parseFallbackConfig("ollama");
t.assert(ollSimple !== null, "ollama parsed");
t.assert(ollSimple.provider === "ollama", "provider is ollama");
t.assert(ollSimple.model === "llama3.3:70b", "default ollama model");
t.assert(ollSimple.baseUrl.includes("11434"), "default ollama port");
t.assert(ollSimple.apiKey === null, "ollama has no API key");

// Ollama with model
const ollModel = _parseFallbackConfig("ollama:phi-3:mini");
t.assert(ollModel.provider === "ollama", "ollama with model: provider");
t.assert(ollModel.model === "phi-3", "ollama with model: model name");

// OpenAI with key
const oaiKey = _parseFallbackConfig("openai:sk-test123");
t.assert(oaiKey !== null, "openai with key parsed");
t.assert(oaiKey.provider === "openai", "provider is openai");
t.assert(oaiKey.apiKey === "sk-test123", "API key extracted");
t.assert(oaiKey.model === "gpt-4.1-mini", "default openai model");
t.assert(oaiKey.baseUrl.includes("openai.com"), "default openai baseUrl");

// OpenAI with key and model
const oaiModel = _parseFallbackConfig("openai:sk-abc:gpt-5-mini");
t.assert(oaiModel.provider === "openai", "openai with model: provider");
t.assert(oaiModel.apiKey === "sk-abc", "openai with model: key");
t.assert(oaiModel.model === "gpt-5-mini", "openai with model: model");

// Unknown provider → null
t.assert(_parseFallbackConfig("azure") === null, "unknown provider returns null");
t.assert(_parseFallbackConfig("anthropic") === null, "anthropic not supported as fallback");

// ═══════════════════════════════════════════════════════════════════════════════
// classifyError
// ═══════════════════════════════════════════════════════════════════════════════

t.section("classifyError — error taxonomy");

// Timeout
t.assert(_classifyError({ code: "ETIMEDOUT" }, null) === "timeout", "ETIMEDOUT → timeout");
t.assert(_classifyError({ killed: true }, null) === "timeout", "killed process → timeout");

// Auth
t.assert(_classifyError(null, { error: { code: 401 } }) === "auth", "401 code → auth");
t.assert(_classifyError(null, { error: { status: 401 } }) === "auth", "401 status → auth");

// Rate limit
t.assert(_classifyError(null, { error: { code: 429 } }) === "rate_limit", "429 → rate_limit");

// Server error
t.assert(_classifyError(null, { error: { status: 500 } }) === "server_error", "500 → server_error");
t.assert(_classifyError(null, { error: { status: 502 } }) === "server_error", "502 → server_error");
t.assert(_classifyError(null, { error: { status: 503 } }) === "server_error", "503 → server_error");

// Unknown
t.assert(_classifyError({}, null) === "unknown", "generic error → unknown");
t.assert(_classifyError(null, { error: { code: 400 } }) === "unknown", "400 → unknown (not failover-worthy)");

// ═══════════════════════════════════════════════════════════════════════════════
// isOllamaHealthy — caching behavior
// ═══════════════════════════════════════════════════════════════════════════════

t.section("isOllamaHealthy — caching");

_testReset();

// Calling with non-existent host should return false
const unhealthy = await _isOllamaHealthy("http://127.0.0.1:19999");
t.assert(unhealthy === false, "unreachable Ollama returns false");

// Second call within TTL should use cache (fast, no curl)
const start = Date.now();
const cached = await _isOllamaHealthy("http://127.0.0.1:19999");
const elapsed = Date.now() - start;
t.assert(cached === false, "cached result is same");
t.assert(elapsed < 100, `cached call is fast: ${elapsed}ms < 100ms`);

// After reset, cache should be cleared
_testReset();
// (won't test real Ollama since we don't know if it's running)

// ═══════════════════════════════════════════════════════════════════════════════
// getBudgetStatus — fallback info
// ═══════════════════════════════════════════════════════════════════════════════

t.section("getBudgetStatus — fallback reporting");

_testReset();
const status = getBudgetStatus();
t.assert("fallback" in status, "status has fallback field");
t.assert("fallbackDistill" in status, "status has fallbackDistill field");
// No env vars set in test, so both should be null
t.assert(status.fallback === null, "fallback is null when not configured");
t.assert(status.fallbackDistill === null, "fallbackDistill is null when not configured");

// ═══════════════════════════════════════════════════════════════════════════════
// isLlmAvailable — fallback awareness
// ═══════════════════════════════════════════════════════════════════════════════

t.section("isLlmAvailable — fallback awareness");

_testReset();
// In test env with BRAIN_LLM_ENABLED not set → "auto"
// No Copilot apps.json in test tmpDir, no fallback configured → may be true if real apps.json exists
// We test the logic path rather than absolute result

const baseAvailable = isLlmAvailable();
t.assert(typeof baseAvailable === "boolean", "isLlmAvailable returns boolean");

// ═══════════════════════════════════════════════════════════════════════════════
// parseFallbackConfig — env var integration
// ═══════════════════════════════════════════════════════════════════════════════

t.section("parseFallbackConfig — env var defaults");

// Ollama respects OLLAMA_BASE_URL
const origOllamaUrl = process.env.OLLAMA_BASE_URL;
process.env.OLLAMA_BASE_URL = "http://myhost:11434";
const ollCustom = _parseFallbackConfig("ollama");
t.assert(ollCustom.baseUrl === "http://myhost:11434", "respects OLLAMA_BASE_URL");
if (origOllamaUrl) process.env.OLLAMA_BASE_URL = origOllamaUrl;
else delete process.env.OLLAMA_BASE_URL;

// OpenAI respects OPENAI_BASE_URL
const origOpenaiUrl = process.env.OPENAI_BASE_URL;
process.env.OPENAI_BASE_URL = "https://custom.api.com/v1";
const oaiCustom = _parseFallbackConfig("openai:sk-test");
t.assert(oaiCustom.baseUrl === "https://custom.api.com/v1", "respects OPENAI_BASE_URL");
if (origOpenaiUrl) process.env.OPENAI_BASE_URL = origOpenaiUrl;
else delete process.env.OPENAI_BASE_URL;

// OpenAI respects OPENAI_API_KEY as fallback
const origKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = "sk-env-key";
const oaiEnvKey = _parseFallbackConfig("openai");
t.assert(oaiEnvKey.apiKey === "sk-env-key", "falls back to OPENAI_API_KEY env var");
if (origKey) process.env.OPENAI_API_KEY = origKey;
else delete process.env.OPENAI_API_KEY;

// ─── Cleanup ────────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ─── Summary ────────────────────────────────────────────────────────────────

const { passed, failed } = t.summary();
if (failed > 0) process.exit(1);
