#!/data/data/com.termux/files/usr/bin/bash
# fix-termux.sh — One-shot fix for LAIA on Termux/Android
# Usage: bash fix-termux.sh

set -e

echo "=== LAIA Termux Fix ==="

# 1. Remove stale ANTHROPIC_API_KEY from ALL shell configs
for f in ~/.bashrc ~/.bash_profile ~/.profile ~/.zshrc; do
  sed -i '/ANTHROPIC_API_KEY/d' "$f" 2>/dev/null || true
done
unset ANTHROPIC_API_KEY
echo "[1/6] Removed ANTHROPIC_API_KEY from all shell configs ✓"

# 2. Ensure copilot apps.json exists
COPILOT_DIR="$HOME/.config/github-copilot"
mkdir -p "$COPILOT_DIR"
if [ ! -f "$COPILOT_DIR/apps.json" ]; then
  echo ""
  echo "⚠️  Copilot apps.json not found."
  echo "Copy it from your PC:  cat ~/.config/github-copilot/apps.json"
  echo "Then paste the FULL content here (one line) and press Enter:"
  read -r APPS_CONTENT
  echo "$APPS_CONTENT" > "$COPILOT_DIR/apps.json"
  echo "[2/6] Created apps.json ✓"
else
  echo "[2/6] apps.json already exists ✓"
fi

# 3. Ensure ~/.laia/config.json — FORCE copilot provider
mkdir -p ~/.laia
cat > ~/.laia/config.json << 'EOF'
{
  "model": "claude-sonnet-4-20250514",
  "provider": "copilot",
  "brainPath": "/data/data/com.termux/files/home/laia-data"
}
EOF
echo "[3/6] Config written (provider=copilot) ✓"

# 4. Ensure flags (mobile-friendly)
cat > ~/.laia/flags.json << 'EOF'
{
  "skill_hot_reload": false,
  "magic_docs": false,
  "away_summary": false
}
EOF
echo "[4/6] Flags written ✓"

# 5. Clear stale token cache
rm -f /tmp/copilot_token_cache.json "$TMPDIR/copilot_token_cache.json" 2>/dev/null || true
echo "[5/6] Cleared token cache ✓"

# 6. Smoke test
echo "[6/6] Testing connection..."
RESULT=$(BRAIN_EMBEDDINGS_ENABLED=false node -e "
import {detectProvider,isProviderAvailable} from '$HOME/laia/packages/providers/src/providers.js';
import {getCopilotToken} from '$HOME/laia/src/auth.js';
const d = detectProvider('claude-sonnet-4-20250514');
console.log('provider:', d.providerId);
if (d.providerId !== 'copilot') { console.log('FAIL: expected copilot, got', d.providerId); process.exit(1); }
const t = await getCopilotToken();
if (!t) { console.log('FAIL: token is null'); process.exit(1); }
console.log('token: OK (' + t.substring(0,10) + '...)');
" 2>&1)

echo "$RESULT"

if echo "$RESULT" | grep -q "FAIL"; then
  echo ""
  echo "❌ Fix failed. Share the output above."
  exit 1
fi

echo ""
echo "✅ All good! Starting LAIA..."
echo ""
exec env BRAIN_EMBEDDINGS_ENABLED=false ANTHROPIC_API_KEY= node "$HOME/laia/bin/laia.js"
