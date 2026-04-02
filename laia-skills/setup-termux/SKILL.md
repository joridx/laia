---
name: setup-termux
description: Reference guide for installing LAIA on Android/Termux
schema: 1
invocation: user
context: main
arguments: false
allowed-tools: [read]
intent-keywords: [termux, android, mobile, install, setup, phone]
---

# Setup LAIA on Android/Termux

## One-liner install

From Termux, run:

```bash
curl -fsSL https://raw.githubusercontent.com/joridx/laia/main/scripts/install-termux.sh | bash
```

Or with provider pre-selected:

```bash
curl -fsSL https://raw.githubusercontent.com/joridx/laia/main/scripts/install-termux.sh | bash -s -- openai gpt-4.1
```

## What the installer does

1. Installs Termux packages (git, nodejs-lts, python3, make)
2. Checks Node ≥22 (installs nvm if needed)
3. Clones LAIA repo to ~/laia
4. `npm install --ignore-optional --ignore-scripts` (skips native modules)
5. Creates ~/.laia with mobile-optimized flags
6. Interactive provider/model selection + API key
7. Initializes brain at ~/laia-data
8. Adds `laia` alias to ~/.bashrc

## What works on Termux

- ✅ Full REPL, all tools (bash, read, write, edit, grep, glob)
- ✅ Multi-model (Anthropic, OpenAI, Google)
- ✅ Skills + /skillify
- ✅ Hooks, flags, sessions
- ⚠️ Brain search (keyword only, no embeddings)
- ❌ Brain embeddings (onnxruntime incompatible with Bionic libc)
- ❌ Skill hot-reload (disabled via flags)

## Troubleshooting

| Error | Fix |
|---|---|
| `Cannot find module 'better-sqlite3'` | Ensure `BRAIN_EMBEDDINGS_ENABLED=false` (the alias does this) |
| `ERR_MODULE_NOT_FOUND` for onnxruntime | Same: `BRAIN_EMBEDDINGS_ENABLED=false` |
| `import ... with { type: 'json' }` syntax error | Need Node ≥22, use nvm |
| ENOMEM / very slow | Close other apps, use lighter model (haiku, gpt-4.1-mini) |

## Updating

```bash
cd ~/laia && git pull && npm install --ignore-optional --ignore-scripts
```
