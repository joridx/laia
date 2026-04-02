#!/data/data/com.termux/files/usr/bin/bash
# LAIA Termux Installer — run directly from Termux:
#   curl -fsSL https://raw.githubusercontent.com/joridx/laia/main/scripts/install-termux.sh | bash
#
# Or download and run:
#   wget https://raw.githubusercontent.com/joridx/laia/main/scripts/install-termux.sh
#   bash install-termux.sh [anthropic|openai|google] [model-name]

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; exit 1; }
info() { echo -e "${CYAN}→${NC} $1"; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   LAIA — Termux Installer            ║${NC}"
echo -e "${CYAN}║   Local AI Agent for Android          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ─── Args ─────────────────────────────────────────────────────────────────────
PROVIDER="${1:-}"
MODEL="${2:-}"

# ─── Step 1: Termux packages ─────────────────────────────────────────────────
info "Step 1/8: Installing Termux packages..."
pkg update -y -q 2>/dev/null
pkg upgrade -y -q 2>/dev/null
pkg install -y git nodejs-lts python3 make 2>/dev/null
ok "Base packages installed"

# ─── Step 2: Check Node version ──────────────────────────────────────────────
info "Step 2/8: Checking Node.js version..."
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 22 ]; then
    warn "Node $NODE_VER detected, need ≥22. Installing nvm..."
    if [ ! -d "$HOME/.nvm" ]; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    else
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    fi
    nvm install 22
    nvm use 22
    nvm alias default 22
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
fi
ok "Node.js v$(node -v | sed 's/v//') ready"

# ─── Step 3: Clone LAIA ──────────────────────────────────────────────────────
info "Step 3/8: Cloning LAIA..."
if [ -d "$HOME/laia" ]; then
    warn "~/laia already exists, pulling latest..."
    cd "$HOME/laia" && git pull --ff-only
else
    git clone https://github.com/joridx/laia.git "$HOME/laia"
fi
cd "$HOME/laia"
ok "LAIA source ready at ~/laia"

# ─── Step 4: Install deps (skip native) ──────────────────────────────────────
info "Step 4/8: Installing dependencies (skipping native modules)..."
npm install --ignore-optional --ignore-scripts 2>&1 | tail -3
ok "Dependencies installed"

# ─── Step 5: Config directory ─────────────────────────────────────────────────
info "Step 5/8: Creating config..."
mkdir -p "$HOME/.laia"

# Feature flags for mobile
cat > "$HOME/.laia/flags.json" << 'FLAGS'
{
  "skill_hot_reload": false,
  "skill_auto_improvement": false,
  "magic_docs": false,
  "away_summary": false,
  "reactive_compaction": false,
  "memory_rerank": "off"
}
FLAGS
ok "Mobile-optimized flags set"

# ─── Step 6: Provider selection ───────────────────────────────────────────────
info "Step 6/8: Configuring LLM provider..."

if [ -z "$PROVIDER" ]; then
    echo ""
    echo "  Which provider do you want to use?"
    echo ""
    echo "  1) Anthropic (Claude)     — recommended"
    echo "  2) OpenAI (GPT)"
    echo "  3) Google (Gemini)"
    echo ""
    read -p "  Choice [1]: " CHOICE
    case "${CHOICE:-1}" in
        1) PROVIDER="anthropic" ;;
        2) PROVIDER="openai" ;;
        3) PROVIDER="google" ;;
        *) PROVIDER="anthropic" ;;
    esac
fi

# Default models per provider
case "$PROVIDER" in
    anthropic)
        MODEL="${MODEL:-claude-sonnet-4-20250514}"
        KEY_VAR="ANTHROPIC_API_KEY"
        ;;
    openai)
        MODEL="${MODEL:-gpt-4.1}"
        KEY_VAR="OPENAI_API_KEY"
        ;;
    google)
        MODEL="${MODEL:-gemini-2.5-pro}"
        KEY_VAR="GOOGLE_API_KEY"
        ;;
    *)
        err "Unknown provider: $PROVIDER (use: anthropic, openai, google)"
        ;;
esac

# Write config
cat > "$HOME/.laia/config.json" << CONF
{
  "model": "$MODEL",
  "brainPath": "$HOME/laia-data"
}
CONF
ok "Provider: $PROVIDER, Model: $MODEL"

# API Key
EXISTING_KEY=$(eval echo "\${$KEY_VAR:-}")
if [ -z "$EXISTING_KEY" ]; then
    echo ""
    read -sp "  Enter your $KEY_VAR: " API_KEY
    echo ""
    if [ -z "$API_KEY" ]; then
        err "API key is required"
    fi
    # Append to bashrc (not echoing the key)
    echo "export $KEY_VAR=\"$API_KEY\"" >> "$HOME/.bashrc"
    export "$KEY_VAR=$API_KEY"
    ok "API key saved to ~/.bashrc"
else
    ok "API key already set ($KEY_VAR)"
fi

# ─── Step 7: Brain data ──────────────────────────────────────────────────────
info "Step 7/8: Initializing brain..."
if [ ! -d "$HOME/laia-data" ]; then
    mkdir -p "$HOME/laia-data"/{learnings,sessions,knowledge}
    cd "$HOME/laia-data"
    git init -q
    echo "# LAIA Brain Data" > README.md
    git add -A && git commit -q -m "init: brain data"
    cd "$HOME/laia"
fi
ok "Brain ready at ~/laia-data"

# ─── Step 8: Shell alias ─────────────────────────────────────────────────────
info "Step 8/8: Setting up shell alias..."
if ! grep -q 'alias laia=' "$HOME/.bashrc" 2>/dev/null; then
    echo 'alias laia="BRAIN_EMBEDDINGS_ENABLED=false node ~/laia/bin/laia.js"' >> "$HOME/.bashrc"
fi
ok "Alias 'laia' added to ~/.bashrc"

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   LAIA installed successfully! 🚀    ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  To start LAIA:"
echo ""
echo "    source ~/.bashrc"
echo "    laia"
echo ""
echo "  Or directly:"
echo ""
echo "    BRAIN_EMBEDDINGS_ENABLED=false node ~/laia/bin/laia.js"
echo ""
echo "  Useful commands inside LAIA:"
echo "    /help     — list all commands"
echo "    /skills   — list available skills"
echo "    /flags    — show feature flags"
echo "    /exit     — exit LAIA"
echo ""
