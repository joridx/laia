// src/hooks/confirmation-hook.js — Wire confirmation flow into PreToolUse
// Sprint 2 core integration: logs high-risk tool calls via stderr warning
//
// Note: PreToolUse hooks are fire-and-forget (emitSync), so we CANNOT
// block tool execution from a hook. Instead:
//   - Log a ⚠️ warning to stderr for high-risk tools
//   - If Talk is available, send confirmation request to Talk
//   - Future (Sprint 3 daemon): actual blocking via task queue
//
// The REAL blocking path is via permissions.js checkPermission(),
// which already prompts the user. We enhance it with risk awareness.

import { on } from './bus.js';
import { getFlag } from '../config/flags.js';
import { classifyRisk } from '../services/confirmation.js';
import { stderr } from 'process';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const R = '\x1b[0m';

/** Redact secrets before logging */
const REDACT_PATTERNS = [
  /Authorization:\s*\S+(?:\s+\S+)?/gi,
  /Bearer\s+\S+/gi,
  /token[=:]\S+/gi,
  /password[=:]\S+/gi,
  /NC_PASS\S*/gi,
];
function redactForLog(text) {
  let r = text;
  for (const p of REDACT_PATTERNS) r = r.replace(p, '[REDACTED]');
  return r;
}

let _registered = false;
let _unsubscribe = null;

/**
 * Register the confirmation hook on PreToolUse.
 * Call once at session start.
 */
export function registerConfirmationHook() {
  if (_registered) return;
  _registered = true;

  _unsubscribe = on('PreToolUse', async ({ name, args }) => {
    try {
      if (!getFlag('confirmation_enabled')) return;

      const risk = classifyRisk(name, args);

      if (risk === 'high') {
        const raw = name === 'bash' ? (args?.command || '').slice(0, 80) : name;
        const cmd = redactForLog(raw);
        stderr.write(`\n${RED}🔴 HIGH RISK: ${name}${R} → ${DIM}${cmd}${R}\n`);
      }
    } catch {
      // Never throw from hook handler
    }
  }, { label: 'confirmation-hook' });
}

/**
 * Unregister and reset (for tests/hot-reload).
 */
export function resetConfirmationHook() {
  if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
  _registered = false;
}
