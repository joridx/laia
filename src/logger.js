import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

const LOG_DIR = join(homedir(), '.laia', 'logs');
const TOOL_LOG_DIR = join(homedir(), '.laia', 'logs', 'tool-stats');

/** Generate a short random ID (8 hex chars) */
export function generateId() {
  return randomBytes(4).toString('hex');
}

export function createLogger(config) {
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = join(LOG_DIR, `${sessionId}.jsonl`);
  let _turnId = null;

  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

  /** Start a new turn — generates and returns a fresh turnId */
  function startTurn() {
    _turnId = generateId();
    return _turnId;
  }

  function getTurnId() { return _turnId; }

  function write(level, event, data) {
    const entry = { ts: Date.now(), level, event, ...((_turnId) ? { turnId: _turnId } : {}), ...data };
    if (config.verbose || level === 'error') {
      process.stderr.write(`[${level}] ${event}\n`);
    }
    try { appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch {}
  }

  // Tool output stats logger (lightweight — just sizes and truncation)
  const toolStatsFile = join(TOOL_LOG_DIR, `${sessionId}.jsonl`);
  try { mkdirSync(TOOL_LOG_DIR, { recursive: true }); } catch {}

  function logToolStats({ tool, bytesIn, bytesOut, truncated, rawFile, exitCode, durationMs }) {
    const entry = { ts: Date.now(), ...((_turnId) ? { turnId: _turnId } : {}), tool, bytesIn, bytesOut, truncated, rawFile, exitCode, durationMs };
    try { appendFileSync(toolStatsFile, JSON.stringify(entry) + '\n'); } catch {}
  }

  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    debug: (event, data) => { if (config.verbose) write('debug', event, data); },
    logToolStats,
    startTurn,
    getTurnId,
    sessionId,
    logFile,
    toolStatsFile,
  };
}
