#!/usr/bin/env bash
# secrets-manage.sh — Setup, edit, list, rekey secrets for LAIA
# Usage:
#   bash ~/.laia/secrets-manage.sh setup    — first-time: create key + encrypt
#   bash ~/.laia/secrets-manage.sh edit     — decrypt to temp, open editor, re-encrypt
#   bash ~/.laia/secrets-manage.sh list     — show secret keys (no values)
#   bash ~/.laia/secrets-manage.sh get KEY  — get a single secret value
#   bash ~/.laia/secrets-manage.sh rekey    — generate new key, re-encrypt

set -euo pipefail

SECRETS_DIR="${HOME}/.laia"
SECRETS_JSON="${SECRETS_DIR}/.secrets.json"
SECRETS_ENC="${SECRETS_DIR}/.secrets.enc"
SECRETS_KEY="${SECRETS_DIR}/.secrets.key"

# ── Helpers ──────────────────────────────────────────────────────────────

_generate_key() {
  openssl rand -base64 32 > "$SECRETS_KEY"
  chmod 600 "$SECRETS_KEY" 2>/dev/null || true
  if command -v icacls.exe &>/dev/null; then
    icacls.exe "$(cygpath -w "$SECRETS_KEY")" /inheritance:r /grant:r "${USERNAME}:F" 2>/dev/null || true
  fi
  echo "Key generated: $SECRETS_KEY"
}

_resolve_path() {
  local p="$1"
  if [[ "$OSTYPE" == msys* ]] || [[ "$OSTYPE" == mingw* ]] || [[ "$OSTYPE" == cygwin* ]]; then
    cygpath -w "$p" 2>/dev/null || echo "$p"
  else
    echo "$p"
  fi
}

_encrypt() {
  local src="$1"
  local _key_content
  _key_content=$(cat "$SECRETS_KEY")
  MSYS_NO_PATHCONV=1 openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in "$(_resolve_path "$src")" -out "$(_resolve_path "$SECRETS_ENC")" \
    -pass "pass:${_key_content}"
  chmod 600 "$SECRETS_ENC" 2>/dev/null || true
  echo "Encrypted: $SECRETS_ENC"
}

_decrypt_to() {
  local dst="$1"
  local _key_content
  _key_content=$(cat "$SECRETS_KEY")
  MSYS_NO_PATHCONV=1 openssl enc -aes-256-cbc -pbkdf2 -d \
    -in "$(_resolve_path "$SECRETS_ENC")" -out "$(_resolve_path "$dst")" \
    -pass "pass:${_key_content}"
}

_secure_delete() {
  local f="$1"
  if [ -f "$f" ]; then
    dd if=/dev/urandom of="$f" bs=$(stat -c%s "$f" 2>/dev/null || wc -c < "$f") count=1 2>/dev/null || true
    rm -f "$f"
  fi
}

# ── Commands ─────────────────────────────────────────────────────────────

cmd_setup() {
  echo "=== LAIA Secrets Setup ==="

  if [ -f "$SECRETS_ENC" ]; then
    echo "WARNING: $SECRETS_ENC already exists."
    read -p "Overwrite? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
      echo "Aborted."
      exit 0
    fi
  fi

  # Generate key if missing
  if [ ! -f "$SECRETS_KEY" ]; then
    _generate_key
  else
    echo "Key exists: $SECRETS_KEY (reusing)"
  fi

  # Create plaintext JSON if missing
  if [ ! -f "$SECRETS_JSON" ]; then
    echo "Creating $SECRETS_JSON — fill in your secrets, then re-run setup."
    cat > "$SECRETS_JSON" << 'TEMPLATE'
{
  "NEXTCLOUD_URL": "",
  "NEXTCLOUD_USER": "",
  "NEXTCLOUD_PASSWORD": "",
  "GITHUB_TOKEN": "",
  "ANTHROPIC_API_KEY": ""
}
TEMPLATE
    chmod 600 "$SECRETS_JSON" 2>/dev/null || true
    echo ""
    echo "NEXT STEPS:"
    echo "  1. Edit $SECRETS_JSON with your actual secret values"
    echo "  2. Run: bash ~/.laia/secrets-manage.sh setup"
    echo "  3. The plaintext file will be securely deleted after encryption"
    exit 0
  fi

  # Validate JSON
  python3 -c "import json; json.load(open('$SECRETS_JSON'))" 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "ERROR: $SECRETS_JSON is not valid JSON"
    exit 1
  fi

  # Encrypt
  _encrypt "$SECRETS_JSON"

  # Verify decryption works
  local tmp_verify
  tmp_verify=$(mktemp)
  _decrypt_to "$tmp_verify"
  if diff -q "$SECRETS_JSON" "$tmp_verify" >/dev/null 2>&1; then
    echo "Verification: OK (decrypt matches original)"
    _secure_delete "$tmp_verify"
    _secure_delete "$SECRETS_JSON"
    echo ""
    echo "Setup complete. Plaintext file securely deleted."
    echo "Encrypted store: $SECRETS_ENC"
    echo "Key file: $SECRETS_KEY"
    echo ""
    echo "Test with: source ~/.laia/secrets.sh && get_secret NEXTCLOUD_URL"
  else
    echo "ERROR: Decryption verification failed!"
    rm -f "$tmp_verify"
    exit 1
  fi
}

cmd_edit() {
  if [ ! -f "$SECRETS_ENC" ]; then
    echo "No encrypted secrets found. Run: bash ~/.laia/secrets-manage.sh setup"
    exit 1
  fi

  local tmp_edit
  tmp_edit=$(mktemp --suffix=.json 2>/dev/null || mktemp)
  _decrypt_to "$tmp_edit"
  chmod 600 "$tmp_edit" 2>/dev/null || true

  # Determine editor
  local editor="${EDITOR:-${VISUAL:-}}"
  if [ -z "$editor" ]; then
    if command -v nano &>/dev/null; then
      editor="nano"
    elif command -v vim &>/dev/null; then
      editor="vim"
    elif command -v vi &>/dev/null; then
      editor="vi"
    elif command -v code &>/dev/null; then
      editor="code --wait"
    else
      echo "No editor found. Set EDITOR env var."
      _secure_delete "$tmp_edit"
      exit 1
    fi
  fi

  echo "Opening secrets in editor... Save and close when done."
  $editor "$tmp_edit"

  # Validate JSON
  if ! python3 -c "import json; json.load(open('$tmp_edit'))" 2>/dev/null; then
    echo "ERROR: Edited file is not valid JSON. Aborting (no changes saved)."
    _secure_delete "$tmp_edit"
    exit 1
  fi

  # Re-encrypt
  _encrypt "$tmp_edit"
  _secure_delete "$tmp_edit"

  echo "Secrets updated. Run 'secrets_clear_cache' if already sourced in current shell."
}

cmd_list() {
  if [ ! -f "$SECRETS_ENC" ]; then
    echo "No encrypted secrets found."
    exit 1
  fi

  local _key_content
  _key_content=$(cat "$SECRETS_KEY")
  MSYS_NO_PATHCONV=1 openssl enc -aes-256-cbc -pbkdf2 -d \
    -in "$(_resolve_path "$SECRETS_ENC")" -pass "pass:${_key_content}" 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k, v in d.items():
    masked = v[:4] + '...' + v[-4:] if len(v) > 12 else ('****' if v else '(empty)')
    print(f'  {k:30s} {masked}')
"
}

cmd_get() {
  local key="$1"
  if [ -z "$key" ]; then
    echo "Usage: bash secrets-manage.sh get KEY"
    exit 1
  fi
  source "$SECRETS_DIR/secrets.sh"
  get_secret "$key"
}

cmd_rekey() {
  if [ ! -f "$SECRETS_ENC" ]; then
    echo "No encrypted secrets found."
    exit 1
  fi

  echo "Generating new key and re-encrypting..."
  local tmp_plain
  tmp_plain=$(mktemp)
  _decrypt_to "$tmp_plain"

  cp "$SECRETS_KEY" "${SECRETS_KEY}.bak"

  _generate_key
  _encrypt "$tmp_plain"
  _secure_delete "$tmp_plain"

  echo "Re-keyed successfully. Old key backed up at ${SECRETS_KEY}.bak"
  echo "Delete the backup when you're satisfied: rm ${SECRETS_KEY}.bak"
}

# ── Main ─────────────────────────────────────────────────────────────────

case "${1:-help}" in
  setup)  cmd_setup ;;
  edit)   cmd_edit ;;
  list)   cmd_list ;;
  get)    cmd_get "${2:-}" ;;
  rekey)  cmd_rekey ;;
  *)
    echo "Usage: bash secrets-manage.sh {setup|edit|list|get KEY|rekey}"
    echo ""
    echo "  setup  — First-time setup (create key, encrypt secrets)"
    echo "  edit   — Decrypt, edit in editor, re-encrypt"
    echo "  list   — Show keys with masked values"
    echo "  get    — Get a single secret value"
    echo "  rekey  — Generate new key, re-encrypt"
    ;;
esac
