# Multi-Provider LLM Guide

How to configure and use Claudia and Brain with different LLM providers.

---

## Quick Start

No config needed for the default setup. If you have GitHub Copilot Business, Claudia and Brain work out of the box:

```bash
claudia                     # uses Copilot Business (default)
claudia --model gpt-5.3-codex   # explicit model, auto-routes to Copilot
```

---

## How Provider Routing Works

When you specify a model (via `--model`, `CLAUDIA_MODEL`, or `BRAIN_LLM_MODEL`), the system auto-detects the provider:

```
"gpt-5.3-codex"   →  openai   (pattern: codex)
"claude-opus-4.6" →  anthropic (pattern: claude-*)
                     ↳ fallback to copilot if ANTHROPIC_API_KEY not set
"llama3.1"        →  ollama   (pattern: llama*)
"copilot:my-model" → copilot  (explicit prefix override)
```

**Availability guard:** if the auto-detected provider has no credentials configured, the request falls back to the default provider (usually `copilot`). This means `CLAUDIA_MODEL=claude-opus-4.6` keeps working via Copilot even without `ANTHROPIC_API_KEY`.

---

## Providers

### Copilot Business (default)

No configuration needed — reads the OAuth token from VS Code's `apps.json`.

**Requirements:**
- GitHub Copilot Business subscription
- VS Code or JetBrains with Copilot extension installed (creates `apps.json`)

**Token file locations:**
- Windows: `%LOCALAPPDATA%\github-copilot\apps.json`
- Linux/macOS: `~/.config/github-copilot/apps.json`

**Available models (examples):**

| Model | Endpoint | Notes |
|-------|----------|-------|
| `gpt-5.3-codex` | `/responses` | Heavy reasoning, best for code review |
| `gpt-5.2-codex` | `/responses` | Fast reasoning |
| `gpt-5-mini` | `/chat/completions` | Fast, cheap, default for Brain |
| `gpt-5.1` | `/chat/completions` | Balanced |
| `claude-opus-4.6` | `/chat/completions` | Via Copilot proxy |
| `claude-sonnet-4.6` | `/chat/completions` | Via Copilot proxy |

List all enabled models: `/copilot models`

---

### OpenAI Direct

```bash
export OPENAI_API_KEY=sk-...
claudia --model gpt-4o           # auto-detects openai
claudia --model openai:gpt-4o    # explicit prefix
```

Optional base URL override (for proxies or Azure-compatible endpoints):
```bash
export OPENAI_BASE_URL=https://my-proxy.example.com/v1
```

---

### Anthropic Direct

```bash
export ANTHROPIC_API_KEY=sk-ant-...
claudia --model claude-opus-4.6   # auto-detects anthropic if key is set
```

> **Note:** Anthropic uses the `/messages` API format, which differs from `/chat/completions`. An adapter is included. Tool use is not yet supported via this path.

Optional base URL override:
```bash
export ANTHROPIC_BASE_URL=https://my-proxy.example.com/v1
```

---

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_ENDPOINT=https://mycompany.openai.azure.com
export AZURE_OPENAI_DEPLOYMENT=gpt-4o

claudia --model azure_openai:gpt-4o
```

Optional API version (default: `2024-10-21`):
```bash
export AZURE_OPENAI_API_VERSION=2025-01-01
```

The URL is constructed as:
```
{ENDPOINT}/openai/deployments/{DEPLOYMENT}/chat/completions?api-version={VERSION}
```

---

### Ollama (local models)

```bash
# Start Ollama: ollama serve
claudia --model llama3.1          # auto-detects ollama
claudia --model mistral           # auto-detects ollama
claudia --model qwen2.5-coder     # auto-detects ollama
```

Optional base URL (default: `http://localhost:11434/v1`):
```bash
export OLLAMA_BASE_URL=http://192.168.1.100:11434/v1
```

---

## Explicit Provider Prefix

Force a specific provider regardless of model name pattern:

```bash
claudia --model copilot:gpt-5.3-codex    # Copilot Business
claudia --model openai:gpt-5.3-codex     # OpenAI direct
claudia --model anthropic:claude-opus-4.6 # Anthropic direct (needs API key)
```

---

## Default Provider

When no provider can be inferred, the default is `copilot`. Override globally:

```bash
export CLAUDIA_DEFAULT_PROVIDER=openai    # default to OpenAI
export CLAUDIA_DEFAULT_PROVIDER=ollama    # default to local Ollama
```

---

## Brain LLM Configuration

Brain (MCP server) uses its own env vars that parallel Claudia's:

| Var | Default | Description |
|-----|---------|-------------|
| `BRAIN_LLM_ENABLED` | `auto` | `auto` / `true` / `false` |
| `BRAIN_LLM_MODEL` | `gpt-5-mini` | Model for lightweight tasks (rerank, expand, autotags) |
| `BRAIN_LLM_MODEL_HEAVY` | `gpt-5.3-codex` | Model for heavy tasks (distill, summarize, compact) |
| `BRAIN_LLM_BUDGET` | `100` | Max LLM units per server session |

Brain also respects `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. — same env vars as Claudia.

**Configure in `~/.claude.json` MCP server env block:**

```json
{
  "claude-brain": {
    "command": "node",
    "args": ["<homedir>/claude/claude-local-brain/mcp-server/index.js"],
    "env": {
      "CLAUDE_BRAIN_PATH": "<homedir>/claude/claude-brain-data",
      "BRAIN_LLM_MODEL": "gpt-5-mini",
      "BRAIN_LLM_MODEL_HEAVY": "gpt-5.3-codex",
      "BRAIN_LLM_BUDGET": "100"
    }
  }
}
```

---

## Copilot Headers Override

The Copilot provider uses VS Code-style headers by default. If you need to override (e.g. version bump without code change):

```bash
export COPILOT_EDITOR_VERSION="vscode/1.110.0"
export COPILOT_PLUGIN_VERSION="copilot-chat/0.38.0"
```

---

## Standalone Brain (without Claudia installed)

Brain uses `@claude/providers` via an npm `file:` dependency pointing to
`../../claudia/packages/providers`. If Claudia is not a sibling directory,
the import fails silently and Brain uses **inline fallback stubs** that preserve
the original Copilot-only behavior.

To confirm which mode is active, check `brain_health` — it reports the LLM status.

---

## Adding a New Provider

See [`packages/providers/README.md`](../packages/providers/README.md#adding-a-new-provider) — requires only editing `providers.js` and adding a pattern to `detectByPattern()`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Copilot apps.json not found` | No Copilot extension installed | Install VS Code + GitHub Copilot |
| `401` on token exchange | OAuth token expired | Re-authenticate in VS Code (Copilot extension) |
| `model is not accessible via endpoint` | Wrong endpoint for model | Use explicit prefix: `copilot:model-name` |
| Model routes to wrong provider | Auto-detection ambiguous | Use explicit prefix: `provider:model` |
| Brain uses old JetBrains headers | Providers package not installed | Run `npm install` in `mcp-server/` |
