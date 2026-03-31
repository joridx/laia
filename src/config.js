import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULTS = {
  model: 'claude-opus-4.6',
  maxTurns: 8,
  contextThreshold: 0.8,
  workspaceRoot: process.cwd(),
  brainPath: process.env.CLAUDE_BRAIN_PATH || join(homedir(), 'claude', 'claude-brain-data'),
  commandDirs: [
    join(homedir(), '.claude', 'commands'),
    join(homedir(), '.claudia', 'commands'),
  ],
  verbose: false,
};

// V2: Normalize effort level (low|medium|high|max → low|medium|high)
const VALID_EFFORTS = { low: 'low', medium: 'medium', high: 'high', max: 'high' };
export function normalizeEffort(input) {
  if (!input) return null;
  const key = String(input).toLowerCase().trim();
  if (!VALID_EFFORTS[key]) throw new Error(`Invalid effort '${input}'. Valid: low, medium, high, max`);
  return VALID_EFFORTS[key];
}

export async function loadConfig({ modelOverride, verbose, swarm, autoCommit, planMode, effort, genai } = {}) {
  let fileConfig = {};
  const configPath = join(homedir(), '.claudia', 'config.json');
  try {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {}

  const envModel = process.env.CLAUDIA_MODEL;

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
