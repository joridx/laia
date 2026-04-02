---
name: setup-termux
description: Install and configure LAIA on Android/Termux from scratch
schema: 1
invocation: user
context: main
arguments: true
argument-hint: "[api-provider: anthropic|openai|google] [model-name]"
allowed-tools: [bash, write, read, edit]
intent-keywords: [termux, android, mobile, install, setup, phone]
---

# Setup LAIA on Android/Termux

## Goal

Install and configure LAIA CLI on an Android device running Termux,
working around native dependency incompatibilities (onnxruntime, better-sqlite3, sharp).
End result: fully functional LAIA REPL on the phone.

## Prerequisites

- Android device with Termux installed (F-Droid version recommended)
- Internet connection
- An API key for at least one LLM provider

## Steps

### 1. Install Termux base packages

```bash
pkg update -y && pkg upgrade -y
pkg install -y git nodejs-lts python3 make openssh
```

**Success:** `node --version` returns v20+ and `git --version` works.

> If Node version is < 22, install nvm:
> ```bash
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
> source ~/.bashrc
> nvm install 22
> nvm use 22
> ```

### 2. Clone LAIA repository

```bash
cd ~
git clone https://github.com/joridx/laia.git
cd ~/laia
```

**Success:** `ls bin/laia.js` exists.

### 3. Install dependencies (skip native modules)

```bash
cd ~/laia
npm install --ignore-optional 2>&1 | tail -5
```

This skips `better-sqlite3`, `onnxruntime-node`, and `sharp` which require
glibc (Android uses Bionic libc — incompatible).

**Success:** `node -e "import('./src/skills.js').then(() => console.log('OK'))"` prints OK.

If npm install fails on native modules despite --ignore-optional:

```bash
npm install --ignore-scripts --ignore-optional
```

### 4. Create LAIA config directory

```bash
mkdir -p ~/.laia
```

### 5. Configure the model and API key

Ask the user which provider they want to use. Default: Anthropic/Claude.

```bash
# Detect provider from arguments or ask user
# Anthropic (default)
cat > ~/.laia/config.json << 'CONF'
{
  "model": "$MODEL",
  "brainPath": "$HOME/laia-data"
}
CONF
```

Set the API key in Termux's persistent environment:

```bash
# For Anthropic:
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc

# For OpenAI:
echo 'export OPENAI_API_KEY="sk-..."' >> ~/.bashrc

# For Google:
echo 'export GOOGLE_API_KEY="..."' >> ~/.bashrc

source ~/.bashrc
```

**CHECKPOINT:** Ask the user for their API key and provider preference.
Never log or echo the key to stdout after setting it.

**Success:** `echo $ANTHROPIC_API_KEY | head -c 10` shows the prefix.

### 6. Configure feature flags for mobile

Disable features that depend on native modules or are wasteful on mobile:

```bash
cat > ~/.laia/flags.json << 'FLAGS'
{
  "skill_hot_reload": false,
  "skill_auto_improvement": false,
  "magic_docs": false,
  "away_summary": false,
  "reactive_compaction": false,
  "memory_rerank": "off"
}
FLAGS
```

**Success:** `cat ~/.laia/flags.json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d+'')))"` parses without error.

### 7. Initialize brain data directory

```bash
mkdir -p ~/laia-data
cd ~/laia-data
git init
mkdir -p learnings sessions knowledge
echo '# LAIA Brain Data' > README.md
git add -A && git commit -m "init: brain data"
```

**Success:** `ls ~/laia-data/learnings` exists.

### 8. Create shell alias

```bash
echo 'alias laia="BRAIN_EMBEDDINGS_ENABLED=false node ~/laia/bin/laia.js"' >> ~/.bashrc
source ~/.bashrc
```

**Success:** `which laia` or `type laia` resolves.

### 9. Test launch

```bash
BRAIN_EMBEDDINGS_ENABLED=false node ~/laia/bin/laia.js --version 2>/dev/null || \
BRAIN_EMBEDDINGS_ENABLED=false node ~/laia/bin/laia.js -p "Say hello in Catalan"
```

**Success:** LAIA starts, responds, and exits cleanly.

### 10. Verify full REPL

```bash
laia
```

Inside the REPL, test:
- `/help` — should list all commands
- `/doctor` — should run diagnostics (if available)
- `/flags` — should show mobile-optimized flags
- Type a question — should get an LLM response
- `/exit` — should exit cleanly

**Success:** All commands work. No native module errors in stderr.

## Troubleshooting

### "Cannot find module 'better-sqlite3'"
Brain tries to load it. Set `BRAIN_EMBEDDINGS_ENABLED=false` (the alias does this).

### "ERR_MODULE_NOT_FOUND" for onnxruntime
Same fix: `BRAIN_EMBEDDINGS_ENABLED=false`. The brain degrades gracefully.

### Node version too old for `import ... with { type: 'json' }`
Need Node ≥ 22. Use nvm (Step 1).

### "ENOMEM" or very slow
Close other apps. LAIA without embeddings uses ~50-100 MB RAM.
Use a lighter model (`claude-haiku-4-20250514` or `gpt-4.1-mini`).

### Termux keyboard issues
Install `pkg install termux-api` and use a keyboard app that supports Ctrl keys
(e.g., Hacker's Keyboard). Or use Termux:Styling for better fonts.

## Notes

- Brain embeddings (semantic search) are disabled on Termux — falls back to keyword match
- Feature flag `skill_hot_reload` is off to avoid chokidar issues on Android
- For best experience, use Termux with a Bluetooth keyboard
- To update LAIA: `cd ~/laia && git pull && npm install --ignore-optional`
- Storage: LAIA + node_modules ≈ 150 MB (without native modules)
