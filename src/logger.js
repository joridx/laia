import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_DIR = join(homedir(), '.claudia', 'logs');

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

  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    debug: (event, data) => { if (config.verbose) write('debug', event, data); },
    sessionId,
    logFile,
  };
}
