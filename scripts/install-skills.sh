#!/usr/bin/env bash
# Install LAIA skills and secrets system from repo to ~/.laia/
# Usage: ./scripts/install-skills.sh
#
# Installs:
#   - skills/*/SKILL.md  →  ~/.laia/skills/*/SKILL.md
#   - secrets/secrets.sh →  ~/.laia/secrets.sh
#   - secrets/secrets-manage.sh → ~/.laia/secrets-manage.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
TARGET_DIR="${HOME}/.laia"

mkdir -p "$TARGET_DIR"

# ── Install skills ───────────────────────────────────────────────────────

REPO_SKILLS="${REPO_ROOT}/skills"
SKILLS_TARGET="${TARGET_DIR}/skills"

if [ -d "$REPO_SKILLS" ]; then
  mkdir -p "$SKILLS_TARGET"
  installed=0
  for skill_dir in "$REPO_SKILLS"/*/; do
    [ ! -d "$skill_dir" ] && continue
    skill_name="$(basename "$skill_dir")"

    if [ ! -f "${skill_dir}SKILL.md" ]; then
      echo "⚠  Skipping ${skill_name}/ — no SKILL.md found"
      continue
    fi

    mkdir -p "${SKILLS_TARGET}/${skill_name}"
    cp -r "${skill_dir}"* "${SKILLS_TARGET}/${skill_name}/"
    echo "✅ skill: ${skill_name}"
    installed=$((installed + 1))
  done
  echo "   ${installed} skill(s) installed"
else
  echo "⚠  No skills/ directory in repo"
fi

# ── Install secrets system ───────────────────────────────────────────────

REPO_SECRETS="${REPO_ROOT}/secrets"

if [ -d "$REPO_SECRETS" ]; then
  cp "${REPO_SECRETS}/secrets.sh" "${TARGET_DIR}/secrets.sh"
  chmod 700 "${TARGET_DIR}/secrets.sh"
  echo "✅ secrets.sh"

  cp "${REPO_SECRETS}/secrets-manage.sh" "${TARGET_DIR}/secrets-manage.sh"
  chmod 700 "${TARGET_DIR}/secrets-manage.sh"
  echo "✅ secrets-manage.sh"

  # Check if secrets are already configured
  if [ -f "${TARGET_DIR}/.secrets.enc" ] && [ -f "${TARGET_DIR}/.secrets.key" ]; then
    echo "   Secrets already configured ✓"
  else
    echo ""
    echo "⚠  Secrets not configured yet. Run:"
    echo "   bash ~/.laia/secrets-manage.sh setup"
  fi
else
  echo "⚠  No secrets/ directory in repo"
fi

echo ""
echo "Done! Installed to ${TARGET_DIR}"
