# API-Key Agnostic Multi-Provider Design

**Date**: 2026-03-18
**Status**: Draft
**Branch**: `feature/api-agnostic` (claudia + claude_local_brain)
**Scope**: Claudia (`src/`) + Brain (`mcp-server/`)

## Problem

Claudia and Brain both depend on GitHub Copilot Business undocumented internal APIs:
- `api.github.com/copilot_internal/v2/token` (token exchange)
- `api.business.githubcopilot.com` (LLM calls)
- Spoofed `Editor-Version: JetBrains-IC/2025.3` headers

This blocks any corporate adoption (Allianz Technology) because:
1. Undocumented API usage violates GitHub Copilot ToS
2. Spoofed headers are a security/compliance red flag
3. Ties the tool to a single provider with no legitimate auth flow

## Goal

Replace hardcoded Copilot dependency with a transparent multi-provider system where:
- The user picks a model name; the system auto-routes to the correct provider
- Copilot Business remains a valid provider (for personal/existing use)
- Zero config change needed for current behavior (backwards compatible)
- Adding a new provider = setting 1-2 env vars

## Design

### Shared module: `@claude/providers` (~120 LOC)

#### Code sharing strategy (cross-platform, cross-repo)

Claudia and Brain are separate git repos. The provider registry must be shared without copy-paste drift.

**Evaluated approaches:**

| Approach | Windows | Linux | Pros | Cons |
|----------|---------|-------|------|------|
| Symlink (`ln -s`) | ❌ Needs admin + Developer Mode | ✅ | Simple | Broken on corporate Windows |
| Copy + sync header | ✅ | ✅ | Zero deps | **Will drift** (proven anti-pattern) |
| Junction (`mklink /J`) | ✅ (no admin needed) | N/A (use symlink) | Works | Directories only, OS-specific |
| **npm `file:` dependency** | ✅ | ✅ | **npm-native, cross-platform** | Requires `npm install` after changes |
| Direct relative import | ✅ | ✅ | Zero config | Assumes fixed directory layout |

**Decision: npm `file:` dependency** — the providers module lives in Claudia's repo as a self-contained package. Brain depends on it via `file:` protocol.

#### Directory structure

```
C:/claude/  (or ~/claude/ on Linux)
├── claudia/
│   ├── packages/
│   │   └── providers/           ← NEW: shared provider package
│   │       ├── package.json     ← {"name": "@claude/providers", "type": "module"}
│   │       ├── index.js          ← re-exports from src/
│   │       └── src/
│   │           └── providers.js  ← THE shared code (~120 LOC)
│   ├── package.json              ← adds "@claude/providers": "file:./packages/providers"
│   └── src/
│       └── ...                   ← imports from '@claude/providers'
│
└── claude_local_brain/
    └── mcp-server/
        ├── package.json          ← adds "@claude/providers": "file:../../claudia/packages/providers"
        └── ...                   ← imports from '@claude/providers'
```

**Why this works cross-platform:**
- `file:` protocol resolves relative paths using Node's `path` module → forward slashes work on Windows
- Both repos use ESM (`"type": "module"`) → identical import syntax
- `npm install` creates a symlink on Linux, a junction on Windows (npm handles OS differences)
- Provider updates: edit once in `claudia/packages/providers/`, run `npm install` in Brain → done
- CI/CD: each repo's `npm ci` resolves the dependency (Brain CI needs Claudia checkout as sibling)

#### `packages/providers/package.json`

```json
{
  "name": "@claude/providers",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/providers.js",
  "exports": {
    ".": "./src/providers.js"
  }
}
```

#### Fallback for environments without sibling repos

Brain may run standalone (e.g., Claude Code MCP server without Claudia installed). The import must degrade gracefully:

```js
// claude_local_brain/mcp-server/llm.js
let providers;
try {
  providers = await import('@claude/providers');
} catch {
  // Fallback: inline minimal copilot-only config (current behavior)
  providers = {
    detectProvider: () => ({ providerId: 'copilot', model: LLM_MODEL }),
    getProvider: () => COPILOT_FALLBACK,
    // ... minimal stubs
  };
}
```

#### OS-aware paths in providers.js

The `findAppsJson()` function (currently in both auth.js and brain/llm.js with different implementations) moves into providers as a cross-platform utility:

```js
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

export function findCopilotAppsJson() {
  const candidates = [];

  if (platform() === 'win32') {
    // Windows: %LOCALAPPDATA%\github-copilot\apps.json
    if (process.env.LOCALAPPDATA) {
      candidates.push(join(process.env.LOCALAPPDATA, 'github-copilot', 'apps.json'));
    }
    // Fallback: %APPDATA%\..\Local
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, '..', 'Local', 'github-copilot', 'apps.json'));
    }
  } else {
    // Linux/macOS: ~/.config/github-copilot/apps.json
    candidates.push(join(homedir(), '.config', 'github-copilot', 'apps.json'));
  }

  return candidates.find(p => existsSync(p)) || null;
}

export function getTempDir() {
  return process.env.TEMP || process.env.TMPDIR || '/tmp';
}
```

This replaces:
- `claudia/src/auth.js:4` — Windows-only `APPS_JSON` const
- `brain/mcp-server/llm.js:133-152` — `findAppsJson()` with 3 fallback paths

#### Provider registry

```js
const PROVIDERS = {
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
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    auth: 'bearer',            // Authorization: Bearer <key>
    tokenEnv: 'OPENAI_API_KEY',
    supports: { chat: true, responses: true, listModels: true },
    extraHeaders: {},
    quirks: {},
  },
  anthropic: {
    id: 'anthropic',
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
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
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    supports: { chat: true, responses: false, listModels: false },
    extraHeaders: {},
    quirks: {},
  },
  ollama: {
    id: 'ollama',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    auth: 'none',
    supports: { chat: true, responses: false, listModels: true },
    extraHeaders: {},
    quirks: {},
  },
};
```

#### Model auto-detection with availability check

```js
function detectProvider(model) {
  const m = model.toLowerCase().trim();

  // 1. Explicit prefix override: "provider:model"
  const match = m.match(/^([a-z_]+):(.+)$/);
  if (match && PROVIDERS[match[1]]) {
    return { providerId: match[1], model: match[2] };
  }

  // 2. Auto-detect by model name pattern
  const detected = detectByPattern(m);

  // 3. Availability guard: if detected provider's token env is not set,
  //    fall back to default provider. This prevents breaking existing users
  //    who have CLAUDIA_MODEL=claude-opus-4.6 routed through Copilot.
  if (detected && !isProviderAvailable(detected.providerId)) {
    const fallback = process.env.CLAUDIA_DEFAULT_PROVIDER || 'copilot';
    return { providerId: fallback, model };
  }

  return detected || { providerId: process.env.CLAUDIA_DEFAULT_PROVIDER || 'copilot', model };
}

function detectByPattern(m) {
  if (m.startsWith('claude-'))                          return { providerId: 'anthropic', model: m };
  if (m.startsWith('gpt-') || /^o[134]-/.test(m))      return { providerId: 'openai', model: m };
  if (m.includes('codex'))                              return { providerId: 'openai', model: m };
  if (/^(llama|mistral|qwen|deepseek|gemma)/.test(m))  return { providerId: 'ollama', model: m };
  return null;
}

// A provider is available if: auth is 'none', auth is 'copilot' (apps.json),
// or the required env var is set.
function isProviderAvailable(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return false;
  if (p.auth === 'none') return true;
  if (p.auth === 'copilot') return true;  // apps.json checked at runtime
  return !!process.env[p.tokenEnv];
}
```

Note on `detectByPattern`: the regex `/^o[134]-/` requires a dash after the digit to avoid false matches on arbitrary model names. This matches `o1-mini`, `o3-medium`, `o4-mini` but not `oracle-v1`.

#### Auth header builder

```js
function buildAuthHeaders(provider, token) {
  // Note: 'copilot' and 'bearer' produce identical headers.
  // The distinction is in resolveToken() (token exchange vs env var).
  switch (provider.auth) {
    case 'bearer':    return { Authorization: `Bearer ${token}` };
    case 'copilot':   return { Authorization: `Bearer ${token}` };
    case 'api-key':   return { 'api-key': token };
    case 'anthropic': return { 'x-api-key': token };
    case 'none':      return {};
  }
}
```

#### Token resolution

```js
async function resolveToken(provider, { getCopilotToken } = {}) {
  if (provider.auth === 'none') return null;
  if (provider.auth === 'copilot') return getCopilotToken();
  const key = process.env[provider.tokenEnv];
  if (!key) throw new Error(`Missing env var ${provider.tokenEnv} for provider ${provider.id}`);
  return key;
}
```

#### URL resolution

Azure OpenAI is a special case requiring deployment-based URL construction. All other providers use a simple `baseUrl/endpoint` pattern. This is documented as intentional — Azure's URL format is fundamentally different.

```js
function resolveUrl(provider, endpoint) {
  if (provider.id === 'azure_openai') {
    const base = process.env[provider.endpointEnv];
    const deployment = process.env[provider.deploymentEnv];
    if (!base || !deployment) throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT required');
    return `${base}/openai/deployments/${deployment}/${endpoint}?api-version=${provider.apiVersion}`;
  }
  return `${provider.baseUrl}/${endpoint}`;
}
```

### Changes to Claudia

#### All files that need changes

| File | Change type | Description |
|------|-------------|-------------|
| `src/providers.js` | **NEW** | Provider registry, detection, auth, URL resolution |
| `src/auth.js` | Extend | Add `getProviderToken(providerId)`, keep `getCopilotToken` |
| `src/llm.js` | Modify | Remove hardcoded URL/headers, use provider resolution |
| `src/repl.js` | Modify | Remove `COPILOT_HEADERS` duplicate, make `/model` provider-aware |
| `src/agent.js` | Modify | Use `getProviderToken` instead of `getCopilotToken` |
| `src/tools/agent.js` | Modify | Use `getProviderToken` instead of `getCopilotToken` |
| `src/router.js` | No change | Model IDs stay as bare names; `detectProvider` resolves them |

#### `src/auth.js` — extend, don't break

Keep `getCopilotToken()` and `COMMON_HEADERS` intact (used only for Copilot token exchange). Add:

```js
import { resolveToken, getProvider } from './providers.js';

export async function getProviderToken(providerId) {
  const provider = getProvider(providerId);
  return resolveToken(provider, { getCopilotToken });
}
```

Note: `COMMON_HEADERS` in `auth.js` (line 8) is Copilot-specific for the token exchange endpoint only. It stays in `auth.js`, NOT moved to the provider registry. The provider registry's `extraHeaders` are for LLM API calls.

#### `src/llm.js` — surgical changes

| What | Before | After |
|------|--------|-------|
| Line 5: `BASE_URL` | Hardcoded Copilot URL | Removed (resolved per-call via provider) |
| Lines 9-13: `COPILOT_HEADERS` | Hardcoded JetBrains headers | Removed (in provider registry) |
| `createLLMClient()` | `getToken()` → single token | Receives `providerId`; resolves provider once |
| `apiCall()` headers | `...COPILOT_HEADERS` | `...provider.extraHeaders, ...buildAuthHeaders(provider, token)` |
| `apiCall()` URL | `${BASE_URL}/${endpoint}` | `resolveUrl(provider, endpoint)` |

**`isClaude` heuristic fix** (critical): The current `isClaude` check at line 334 controls the `done()` tool injection and `tool_choice: "required"` forcing. This is a **Copilot proxy bug**, not a Claude bug. After the refactor:

```js
// Before: const isClaude = /claude/i.test(model);
// After: proxy quirk, not model quirk
const needsToolChoiceHack = provider.quirks.forceToolChoiceRequired && /claude/i.test(model);
const needsStreamingFallback = provider.quirks.disableStreamingForClaude && /claude/i.test(model);
```

This way, `claude-opus-4.6` via Copilot gets the workaround, but `claude-opus-4.6` via Anthropic direct (future) would not.

#### `/responses` endpoint guard

When a codex model is requested but the provider doesn't support `/responses`, fall back to `/chat/completions`. This is NOT a separate converter — it reuses the existing `chatMessagesToResponsesItems` logic in reverse direction. Deferred to implementation: if `/responses` is requested on a non-supporting provider, throw a clear error for now. Converting responses→chat format is non-trivial and can be added when a real use case arises.

```js
if (isResponsesModel(model) && !provider.supports.responses) {
  throw new Error(`Provider ${provider.id} does not support /responses endpoint. Use a chat model or switch to openai/copilot provider.`);
}
```

#### `src/repl.js` — `/model` command becomes provider-aware

The current `handleModelCommand` (line 459) fetches model list from `api.business.githubcopilot.com/models` with Copilot headers. Changes:

```js
// Before: hardcoded Copilot endpoint
// After: use provider's listModels capability
if (provider.supports.listModels) {
  const url = resolveUrl(provider, 'models');
  // ... fetch with provider headers
} else {
  // Azure/Anthropic: no list endpoint, show configured models only
  console.log(`Provider ${provider.id} does not support model listing.`);
}
```

Remove the duplicate `COPILOT_HEADERS` from `repl.js` line 16 — use provider registry instead.

#### `src/agent.js` + `src/tools/agent.js` — provider-aware token

Both files currently hardcode `getCopilotToken`:
- `agent.js` line 11: `createLLMClient({ getToken: getCopilotToken, ... })`
- `tools/agent.js` line 44: same pattern

Change to:
```js
import { getProviderToken } from './auth.js';
import { detectProvider } from './providers.js';

const { providerId } = detectProvider(config.model);
createLLMClient({ getToken: () => getProviderToken(providerId), model: config.model });
```

#### `src/router.js` — no changes needed

`MODEL_IDS` contains bare model names (`'claude-opus-4.6'`, `'gpt-5.3-codex'`). These are passed to `detectProvider()` which routes them correctly. If `CLAUDIA_DEFAULT_PROVIDER=openai`, the router emitting `'claude-opus-4.6'` will: detect anthropic → check availability → if no `ANTHROPIC_API_KEY`, fall back to default provider. This is correct behavior.

### Changes to Brain (`mcp-server/llm.js`)

Same pattern. Import `@claude/providers` via npm `file:` dependency. Graceful fallback if package not found (standalone mode).

**Key difference from Claudia:** Brain uses `curl` via `execFile` (not `fetch`). The provider resolution (URL, headers, auth) is identical, but the HTTP transport layer stays curl-based. `@claude/providers` is transport-agnostic — it only resolves **what** to call, not **how**.

| What | Before | After |
|------|--------|-------|
| Lines 128-211: Copilot token code | `findAppsJson()` + `refreshCopilotToken()` | Use `findCopilotAppsJson()` from `@claude/providers`, keep token exchange |
| Line 262-298: `callLlm()` URL/headers | Hardcoded Copilot | `detectProvider(model)` → `resolveUrl()` + `buildAuthHeaders()` |
| curl command builder | Copilot-specific headers | `...provider.extraHeaders` spread into curl `-H` args |
| `ALLOWED_MODELS` set | Hardcoded GPT/Codex list | Removed — any model allowed, provider auto-detected |

**package.json change:**
```json
{
  "dependencies": {
    "@claude/providers": "file:../../claudia/packages/providers"
  }
}
```

**Standalone fallback** (Brain running without Claudia repo as sibling):
```js
let providers;
try {
  providers = await import('@claude/providers');
} catch {
  // Minimal copilot-only config — current behavior preserved
  providers = { /* inline stubs */ };
}
```

Brain env vars use same conventions but with `BRAIN_` prefix option for independence:
- `BRAIN_LLM_MODEL` (existing) — model name, now routed via `detectProvider()`
- `BRAIN_DEFAULT_PROVIDER` — optional override (default: same as Claudia)
- Shares `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. with Claudia

Untouched: budget system, cache, circuit breaker, all 7 task functions (rerank, expand, autotags, distill, duplicate, summarize, compact), curl transport.

### Env var conventions

Standard industry names — no custom prefix needed:

| Var | Provider | Required? |
|-----|----------|-----------|
| *(none, uses apps.json)* | Copilot | Auto-detected |
| `OPENAI_API_KEY` | OpenAI | If using OpenAI models |
| `OPENAI_BASE_URL` | OpenAI | Optional (default: api.openai.com) |
| `ANTHROPIC_API_KEY` | Anthropic | If using Claude models directly |
| `ANTHROPIC_BASE_URL` | Anthropic | Optional (default: api.anthropic.com) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI | If using Azure |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI | If using Azure |
| `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI | If using Azure |
| `AZURE_OPENAI_API_VERSION` | Azure OpenAI | Optional (default: 2024-10-21) |
| `OLLAMA_BASE_URL` | Ollama | Optional (default: localhost:11434) |
| `CLAUDIA_DEFAULT_PROVIDER` | Fallback | Optional (default: copilot) |

### User experience

No config needed for current behavior. Examples:

```bash
# Current (unchanged) — Copilot Business via apps.json
claudia

# Add OpenAI direct
export OPENAI_API_KEY=sk-...
claudia --model gpt-4o            # auto-detects OpenAI

# Add Azure OpenAI (likely AT scenario)
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_ENDPOINT=https://mycompany.openai.azure.com
export AZURE_OPENAI_DEPLOYMENT=gpt-4o
claudia --model azure_openai:gpt-4o

# Force provider with prefix
claudia --model copilot:gpt-5.3-codex   # explicit Copilot
claudia --model openai:gpt-5.3-codex    # explicit OpenAI direct

# Local models
claudia --model llama3.1                 # auto-detects Ollama
```

### Migration: existing users with `CLAUDIA_MODEL=claude-*`

If a user has `CLAUDIA_MODEL=claude-opus-4.6` (currently routed through Copilot), after the refactor `detectProvider` would match `anthropic` first. The **availability guard** in `detectProvider` handles this: if `ANTHROPIC_API_KEY` is not set, it falls back to the default provider (`copilot`). No breaking change.

## Deferred: Anthropic `/messages` adapter

Anthropic's API uses a different format (`/messages` instead of `/chat/completions`):
- System prompt is a top-level `system` field, not a message
- Response format uses `content` blocks instead of `choices[].message`
- Tool use format differs

This requires a request/response adapter (~50-80 LOC). Deferred because:
1. AT will likely use Azure OpenAI (OpenAI-compatible format)
2. Copilot Business already proxies Claude via `/chat/completions` format
3. Can be added later without changing the provider registry design

When implemented:
- `toAnthropicRequest(chatMessages)` — convert chat format to Anthropic format
- `fromAnthropicResponse(response)` — convert back to canonical format
- Placed in `providers.js` or separate `adapters/anthropic.js`

## Testing strategy

### Unit tests for `providers.js` (~80 LOC)

- `detectProvider` with each model prefix (claude-, gpt-, codex, llama, etc.)
- `detectProvider` with explicit prefix (`openai:gpt-4o`, `copilot:claude-opus-4.6`)
- `detectProvider` with unknown prefix (`unknown_provider:model`) → fallback
- `detectProvider` availability guard: model matches anthropic but no `ANTHROPIC_API_KEY` → falls back to copilot
- `detectProvider` ambiguity: both `OPENAI_API_KEY` and Copilot available, `gpt-4o` → routes to OpenAI (pattern match wins over fallback)
- `buildAuthHeaders` for each auth type
- `resolveUrl` standard providers
- `resolveUrl` Azure with deployment
- `resolveUrl` Azure missing env vars → throws
- `resolveToken` missing env var → throws
- `isProviderAvailable` for each auth type

### Integration tests (env-gated)

- Smoke test per provider: skip if key not set, basic `/chat/completions` call if available
- Copilot path: unchanged behavior verified by existing tests

### Regression

- All 154 existing Claudia tests must pass (no behavioral change)
- All 938 existing Brain tests must pass

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Copilot stops working after refactor | Copilot path preserved exactly; same headers, same token flow |
| Provider detection wrong model | Explicit prefix override (`provider:model`) as escape hatch |
| `CLAUDIA_MODEL=claude-*` breaks | Availability guard falls back to default provider if token env not set |
| Azure deployment URL format changes | `apiVersion` env var configurable |
| Brain curl approach fragile | Same curl, just different URL/headers — no structural change |
| Tests break | Feature branch + rollback to `main` |
| `isClaude` workarounds applied on non-Copilot | Fixed: workarounds gated on `provider.quirks`, not model name alone |
| `/model` command fails on non-Copilot provider | Provider-aware: check `supports.listModels`, show message if unsupported |
| `providers.js` copy drifts between Claudia and Brain | **Eliminated**: npm `file:` dependency, single source of truth in `claudia/packages/providers/`. Brain imports via `@claude/providers`. Fallback stubs for standalone mode. |

## Scope summary

| Component | New code | Modified code | Risk |
|-----------|----------|---------------|------|
| `src/providers.js` (new) | ~100 LOC | — | Low |
| `src/auth.js` | — | +10 LOC | Low |
| `src/llm.js` | — | ~25 LOC changed | Medium |
| `src/repl.js` | — | ~15 LOC changed | Medium |
| `src/agent.js` | — | ~5 LOC changed | Low |
| `src/tools/agent.js` | — | ~5 LOC changed | Low |
| Brain `mcp-server/llm.js` | — | ~30 LOC changed | Medium |
| Brain `mcp-server/providers.js` (new, copy) | ~100 LOC | — | Low |
| Tests (new) | ~80 LOC | — | Low |
| **Total** | **~280 new** | **~90 changed** | **Low-Medium** |
