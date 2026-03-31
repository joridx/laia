import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_DIR = join(homedir(), '.laia', 'logs');
const TOOL_LOG_DIR = join(homedir(), '.laia', 'logs', 'tool-stats');

export function createLogger(config) {
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = join(LOG_DIR, `${sessionId}.jsonl`);

  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

  function write(level, event, data) {
    const entry = { ts: Date.now(), level, event, ...data };
    if (config.verbose || level === 'error') {
      process.stderr.write(`[${level}] ${event}\n`);
    }
    try { appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch {}
  }

  // Tool output stats logger (lightweight — just sizes and truncation)
  const toolStatsFile = join(TOOL_LOG_DIR, `${sessionId}.jsonl`);
  try { mkdirSync(TOOL_LOG_DIR, { recursive: true }); } catch {}

  function logToolStats({ tool, bytesIn, bytesOut, truncated, rawFile, exitCode, durationMs }) {
    const entry = { ts: Date.now(), tool, bytesIn, bytesOut, truncated, rawFile, exitCode, durationMs };
    try { appendFileSync(toolStatsFile, JSON.stringify(entry) + '\n'); } catch {}
  }

  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    debug: (event, data) => { if (config.verbose) write('debug', event, data); },
    logToolStats,
    sessionId,
    logFile,
    toolStatsFile,
  };
}
