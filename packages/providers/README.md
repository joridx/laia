# @laia/providers

Shared multi-provider LLM routing package for **LAIA** (CLI agent) and **Brain** (MCP server).

Transport-agnostic: resolves *what* to call (URL, headers, auth), not *how* (fetch vs curl).

---

## Overview

```
model string  ──►  detectProvider()  ──►  { providerId, model }
                                              │
                        ┌─────────────────────┼──────────────────────┐
                        ▼                     ▼                      ▼
                  resolveToken()        resolveUrl()        extraHeaders
                  (auth strategy)       (endpoint URL)    (provider headers)
                        │                     │                      │
                        └─────────────────────┴──────────────────────┘
                                              │
                                       HTTP call (curl / fetch)
```

---

## Supported Providers

| ID | Auth | Base URL | Notes |
|----|------|----------|-------|
| `copilot` | Token exchange (apps.json) | `api.business.githubcopilot.com` | Default; requires GitHub Copilot Business |
| `openai` | Bearer (`OPENAI_API_KEY`) | `api.openai.com/v1` | Override via `OPENAI_BASE_URL` |
| `anthropic` | API key (`ANTHROPIC_API_KEY`) | `api.anthropic.com/v1` | Uses `/messages` format |
| `azure_openai` | API key (`AZURE_OPENAI_API_KEY`) | Deployment-based URL | Requires `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT` |
| `ollama` | None | `localhost:11434/v1` | Override via `OLLAMA_BASE_URL` |

---

## API Reference

### `detectProvider(model, [options])`

Resolves a model string to `{ providerId, model }`.

**Priority order:**
1. Explicit prefix: `"openai:gpt-5"` → `{ providerId: "openai", model: "gpt-5" }`
2. Pattern match on model name (see table below)
3. Availability guard: if detected provider has no credentials → fallback to default
4. Default provider (`LAIA_DEFAULT_PROVIDER` env var, or `"copilot"`)

**Auto-detection patterns:**

| Pattern | Provider |
|---------|----------|
| `claude-*` | `anthropic` |
| `gpt-*`, `o1-*`, `o3-*`, `o4-*` | `openai` |
| `*codex*` | `openai` |
| `llama*`, `mistral*`, `qwen*`, `deepseek*`, `gemma*` | `ollama` |
| *(anything else)* | default provider |

```js
import { detectProvider } from '@laia/providers';

detectProvider('gpt-5.3-codex')
// → { providerId: 'openai', model: 'gpt-5.3-codex' }

detectProvider('openai:gpt-4o')
// → { providerId: 'openai', model: 'gpt-4o' }

detectProvider('claude-opus-4.6')
// → { providerId: 'anthropic', model: 'claude-opus-4.6' }
// → falls back to { providerId: 'copilot', model: 'claude-opus-4.6' }
//   if ANTHROPIC_API_KEY is not set
```

---

### `getProvider(providerId)`

Returns the provider config object from `PROVIDERS`. Throws if unknown.

```js
import { getProvider } from '@laia/providers';

const p = getProvider('copilot');
// → { id, baseUrl, auth, supports, extraHeaders, quirks }
```

---

### `resolveToken(provider, { getCopilotToken })`

Async. Returns the auth token for a provider.

- `copilot`: calls `getCopilotToken()` (token exchange via apps.json)
- `bearer` / `api-key` / `anthropic`: reads `process.env[provider.tokenEnv]`
- `none`: returns `null`

```js
import { resolveToken, getProvider } from '@laia/providers';

const token = await resolveToken(getProvider('openai'));
// → process.env.OPENAI_API_KEY
```

---

### `buildAuthHeaders(provider, token)`

Returns the `Authorization` header object for a provider.

| Auth type | Header produced |
|-----------|----------------|
| `bearer`, `copilot` | `{ Authorization: "Bearer <token>" }` |
| `api-key` | `{ "api-key": "<token>" }` |
| `anthropic` | `{ "x-api-key": "<token>" }` |
| `none` | `{}` |

---

### `resolveUrl(provider, endpoint)`

Returns the full API URL.

```js
import { resolveUrl, getProvider } from '@laia/providers';

resolveUrl(getProvider('openai'), 'chat/completions')
// → 'https://api.openai.com/v1/chat/completions'

resolveUrl(getProvider('azure_openai'), 'chat/completions')
// → 'https://<ENDPOINT>/openai/deployments/<DEPLOYMENT>/chat/completions?api-version=2024-10-21'
```

Azure OpenAI is special-cased: constructs the deployment URL from `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT`.

---

### `isProviderAvailable(providerId)`

Synchronous check. Returns `true` if the provider has the required credentials.

- `none`: always true
- `copilot`: true if `apps.json` exists on disk
- others: true if the required env var is set

---

### `findCopilotAppsJson()`

Cross-platform path to `github-copilot/apps.json`:
- Windows: `%LOCALAPPDATA%\github-copilot\apps.json`
- Linux/macOS: `~/.config/github-copilot/apps.json`

Returns `null` if not found.

---

### `findCopilotOAuthToken()`

Returns the best OAuth token from `apps.json`, with priority:

1. Entry with `githubAppId === 'Iv23ctfURkiMfJ4xr5mv'` (VS Code Copilot Chat app)
2. Entry with `oauth_token` starting with `ghu_` (device code OAuth — VS Code flow)
3. First entry sorted alphabetically (deterministic fallback)

Returns `null` if `apps.json` not found or empty.

---

### `getTempDir()`

Cross-platform temp directory: `TEMP` (Windows) → `TMPDIR` (macOS) → `os.tmpdir()`.

---

## Provider `extraHeaders`

The `copilot` provider's `extraHeaders` getter returns VS Code-style headers
(reverse-engineered from `github.copilot-chat-0.37.9`, VS Code 1.109.5):

```js
{
  'Editor-Version': 'vscode/1.109.5',         // override: COPILOT_EDITOR_VERSION
  'Editor-Plugin-Version': 'copilot-chat/0.37.9', // override: COPILOT_PLUGIN_VERSION
  'Copilot-Integration-Id': 'vscode-chat',
}
```

These headers are sent on **both** token exchange and API calls.
Token exchange also adds `X-GitHub-Api-Version: 2025-04-01` (exported as `COPILOT_GITHUB_API_VERSION`).

---

## Provider Quirks

The `copilot` provider has two known proxy quirks:

| Quirk | Description |
|-------|-------------|
| `forceToolChoiceRequired` | Copilot proxy drops `tool_calls` when `tool_choice: "auto"` for Claude models — force `"required"` |
| `disableStreamingForClaude` | Streaming unreliable for Claude models via Copilot proxy |

These are gated on `provider.quirks`, not on the model name, so they do **not** apply when calling Claude directly via `anthropic` provider.

---

## Exports

```js
export {
  PROVIDERS,                  // full registry object
  detectProvider,             // model → { providerId, model }
  getProvider,                // id → provider config
  isProviderAvailable,        // id → boolean
  resolveToken,               // async (provider, opts) → string|null
  buildAuthHeaders,           // (provider, token) → headers object
  resolveUrl,                 // (provider, endpoint) → string
  getBaseUrl,                 // (provider) → string
  findCopilotAppsJson,        // () → string|null
  findCopilotOAuthToken,      // () → string|null
  getTempDir,                 // () → string
  COPILOT_GITHUB_API_VERSION, // '2025-04-01'
}
```

---

## Adding a New Provider

1. Add an entry to `PROVIDERS` in `src/providers.js`:

```js
myprovider: {
  id: 'myprovider',
  baseUrlEnv: 'MYPROVIDER_BASE_URL',
  baseUrlDefault: 'https://api.myprovider.com/v1',
  auth: 'bearer',
  tokenEnv: 'MYPROVIDER_API_KEY',
  supports: { chat: true, responses: false, listModels: false },
  extraHeaders: {},
  quirks: {},
},
```

2. Add a pattern to `detectByPattern()` if the model names are distinctive:

```js
if (m.startsWith('my-')) return { providerId: 'myprovider', model: m };
```

3. Done — `detectProvider('my-model-v1')` will now route to `myprovider`.
