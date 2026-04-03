import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Legacy migration ────────────────────────────────────────────────────────
// Called ONCE from bin/laia.js at startup, BEFORE loadConfig().
// No side effects at import time.

export function migrateLegacyConfig() {
  // Load ~/.laia/.env (API keys, secrets) into process.env — before anything reads env vars.
  // Simple key=value parser, no dependencies. Existing env vars are NOT overwritten.
  loadDotEnv(join(homedir(), '.laia', '.env'));

  if (process.env.CLAUDE_BRAIN_PATH && !process.env.LAIA_BRAIN_PATH) {
    process.stderr.write(
      '⚠️  CLAUDE_BRAIN_PATH is deprecated. Set LAIA_BRAIN_PATH instead.\n' +
      '   Falling back to CLAUDE_BRAIN_PATH for this session.\n'
    );
    process.env.LAIA_BRAIN_PATH = process.env.CLAUDE_BRAIN_PATH;
  }

  const oldConfigDir = join(homedir(), '.claudia');
  if (existsSync(oldConfigDir) && !existsSync(join(homedir(), '.laia'))) {
    process.stderr.write(
      `⚠️  Found legacy ~/.claudia/ directory but no ~/.laia/.\n` +
      `   Consider copying your config: cp -r ~/.claudia ~/.laia\n`
    );
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

// DEFAULTS with static values only — brainPath computed at loadConfig() time
// to ensure migrateLegacyConfig() has run first (#12 Codex review fix)
const DEFAULTS = {
  model: 'claude-opus-4.6',
  maxTurns: 8,
  contextThreshold: 0.8,
  workspaceRoot: process.cwd(),
  commandDirs: [
    join(homedir(), '.laia', 'commands'),
  ],
  verbose: false,
};

const VALID_EFFORTS = { low: 'low', medium: 'medium', high: 'high', max: 'high' };
export function normalizeEffort(input) {
  if (!input) return null;
  const key = String(input).toLowerCase().trim();
  if (!VALID_EFFORTS[key]) throw new Error(`Invalid effort '${input}'. Valid: low, medium, high, max`);
  return VALID_EFFORTS[key];
}

export async function loadConfig({ modelOverride, verbose, swarm, autoCommit, planMode, effort, genai } = {}) {
  let fileConfig = {};
  const configPath = join(homedir(), '.laia', 'config.json');
  try {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {}

  // Compute brainPath at call time — after migrateLegacyConfig() has run
  const brainPath = process.env.LAIA_BRAIN_PATH || join(homedir(), 'laia-data');
  const envModel = process.env.LAIA_MODEL;

  return {
    ...DEFAULTS,
    brainPath,
    ...fileConfig,
    ...(envModel ? { model: envModel } : {}),
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(verbose !== undefined ? { verbose } : {}),
    ...(swarm !== undefined ? { swarm } : {}),
    ...(autoCommit !== undefined ? { autoCommit } : {}),
    ...(planMode !== undefined ? { planMode } : {}),
    ...(effort ? { effort: normalizeEffort(effort) } : {}),
    ...(genai ? { genai } : {}),
  };
}

// ─── .env loader ─────────────────────────────────────────────────────────────
// Minimal KEY=VALUE parser. Does NOT overwrite existing env vars.
// Supports: comments (#), quoted values, empty lines. No interpolation.

export function loadDotEnv(filePath) {
  let content;
  try { content = readFileSync(filePath, 'utf8'); } catch { return; }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double)
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Don't overwrite existing env vars (explicit export takes precedence)
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}
