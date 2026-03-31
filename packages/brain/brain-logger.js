/**
 * brain-logger.js — Structured logging for Brain LLM operations.
 * Replaces raw console.error("LLM: ...") with JSONL structured entries.
 *
 * Writes to ~/laia-data/.brain-llm.log (JSONL, rotated by size).
 * Also forwards to stderr when BRAIN_QUIET !== '1'.
 *
 * Log entry schema:
 * { ts, level, event, provider?, task?, model?, latencyMs?, chars?, error?, detail? }
 */

import { appendFileSync, statSync, renameSync, mkdirSync } from "fs";
import * as path from "path";
import { BRAIN_PATH } from "./config.js";

const LOG_FILE = ".brain-llm.log";
const MAX_LOG_SIZE = 512 * 1024; // 512KB, then rotate

const quiet = () => process.env.BRAIN_QUIET === '1';

// Ensure BRAIN_PATH exists on first import
try { mkdirSync(BRAIN_PATH, { recursive: true }); } catch { /* non-fatal */ }

function logPath() {
  return path.join(BRAIN_PATH, LOG_FILE);
}

function rotateIfNeeded() {
  try {
    const st = statSync(logPath());
    if (st.size > MAX_LOG_SIZE) {
      renameSync(logPath(), logPath() + '.old');
    }
  } catch { /* file doesn't exist yet — ok */ }
}

/**
 * Write a structured log entry.
 * @param {'info'|'warn'|'error'} level
 * @param {string} event - Event name (e.g. 'llm_call', 'circuit_breaker', 'config_load')
 * @param {object} [data] - Structured fields
 */
export function brainLog(level, event, data = {}) {
  const entry = { ts: Date.now(), level, event, ...data };

  // Write to JSONL file
  try {
    rotateIfNeeded();
    appendFileSync(logPath(), JSON.stringify(entry) + '\n');
  } catch { /* non-fatal */ }

  // Forward to stderr (for agent verbose mode, piped from brain child process)
  if (!quiet()) {
    const compact = formatCompact(level, event, data);
    console.error(compact);
  }
}

/** Compact one-line format for stderr (human-readable) */
function formatCompact(level, event, data) {
  const parts = [`LLM ${event}`];
  if (data.provider) parts.push(data.provider);
  if (data.task) parts.push(`task=${data.task}`);
  if (data.model) parts.push(data.model);
  if (data.latencyMs != null) parts.push(`${data.latencyMs}ms`);
  if (data.chars != null) parts.push(`${data.chars} chars`);
  if (data.error) parts.push(`error: ${data.error}`);
  if (data.detail) parts.push(data.detail);
  return parts.join(' | ');
}

// Convenience helpers
export const llmInfo = (event, data) => brainLog('info', event, data);
export const llmWarn = (event, data) => brainLog('warn', event, data);
export const llmError = (event, data) => brainLog('error', event, data);
