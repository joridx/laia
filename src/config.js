import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULTS = {
  model: 'claude-opus-4.6',
  maxTurns: 8,
  contextThreshold: 0.8,
  workspaceRoot: process.cwd(),
  brainPath: 'C:/claude/claude-brain-data',
  commandDirs: [
    join(homedir(), '.claude', 'commands'),
    join(homedir(), '.claudia', 'commands'),
  ],
  verbose: false,
};

export async function loadConfig({ modelOverride, verbose, swarm, autoCommit } = {}) {
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
  };
}
