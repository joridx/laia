import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Legacy migration ────────────────────────────────────────────────────────
// Called ONCE from bin/laia.js at startup. No side effects at import time.

export function migrateLegacyConfig() {
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

const DEFAULTS = {
  model: 'claude-opus-4.6',
  maxTurns: 8,
  contextThreshold: 0.8,
  workspaceRoot: process.cwd(),
  brainPath: process.env.LAIA_BRAIN_PATH || join(homedir(), 'laia-data'),
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

  const envModel = process.env.LAIA_MODEL;

  return {
    ...DEFAULTS,
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
