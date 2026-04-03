#!/usr/bin/env bash
# secrets.sh — Secrets helper for LAIA
# Usage: source ~/.laia/secrets.sh && get_secret NEXTCLOUD_URL
#
# Secrets are stored encrypted in ~/.laia/.secrets.enc
# Key file: ~/.laia/.secrets.key (mode 600)
# Plaintext cache: kept in memory (variable), never written to disk

SECRETS_DIR="${HOME}/.laia"
SECRETS_ENC="${SECRETS_DIR}/.secrets.enc"
SECRETS_KEY="${SECRETS_DIR}/.secrets.key"
_LAIA_SECRETS_CACHE=""

get_secret() {
  local key="$1"
  if [ -z "$key" ]; then
    echo "Usage: get_secret KEY" >&2
    return 1
  fi

  # Decrypt on first call (cache in memory for the session)
  if [ -z "$_LAIA_SECRETS_CACHE" ]; then
    if [ ! -f "$SECRETS_ENC" ]; then
      echo "ERROR: Encrypted secrets not found: $SECRETS_ENC" >&2
      echo "Run: bash ~/.laia/secrets-manage.sh setup" >&2
      return 1
    fi
    if [ ! -f "$SECRETS_KEY" ]; then
      echo "ERROR: Key file not found: $SECRETS_KEY" >&2
      echo "Run: bash ~/.laia/secrets-manage.sh setup" >&2
      return 1
    fi
    local _key_content
    _key_content=$(cat "$SECRETS_KEY")
    local _enc_path="$SECRETS_ENC"
    # Windows compatibility
    if [[ "$OSTYPE" == msys* ]] || [[ "$OSTYPE" == mingw* ]] || [[ "$OSTYPE" == cygwin* ]]; then
      _enc_path=$(cygpath -w "$SECRETS_ENC" 2>/dev/null || echo "$SECRETS_ENC")
    fi
    _LAIA_SECRETS_CACHE=$(MSYS_NO_PATHCONV=1 openssl enc -aes-256-cbc -pbkdf2 -d \
      -in "$_enc_path" -pass "pass:${_key_content}" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$_LAIA_SECRETS_CACHE" ]; then
      echo "ERROR: Failed to decrypt secrets" >&2
      _LAIA_SECRETS_CACHE=""
      return 1
    fi
  fi

  # Extract value by key
  local val
  val=$(echo "$_LAIA_SECRETS_CACHE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    v = d.get('$key', '')
    if v:
        print(v, end='')
    else:
        print('', end='')
        sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null)

  if [ $? -ne 0 ] || [ -z "$val" ]; then
    echo "ERROR: Secret '$key' not found" >&2
    return 1
  fi
  echo "$val"
}

# Invalidate cache (call after secrets-manage.sh edit)
secrets_clear_cache() {
  _LAIA_SECRETS_CACHE=""
}
