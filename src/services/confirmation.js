// src/services/confirmation.js — Risk-based confirmation flow for LAIA
// Sprint 2: Pause on dangerous actions, ask via Talk or CLI
//
// Integrates with:
//   - Hook bus (PreToolUse) — intercept before execution
//   - Talk client — ask user via Nextcloud Talk
//   - CLI readline — ask user interactively
//
// Risk levels:
//   - safe:   auto-approve (read, grep, glob, git_status, git_log, brain_*)
//   - low:    auto-approve with log
//   - medium: warn in output, no block
//   - high:   BLOCK and ask for confirmation

import { stderr } from 'process';

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const YES_PATTERNS = /^(sí|si|yes|y|ok|proceed|continua|endavant|aprovat|approve|dale|va)(?:\s|$)/iu;
const NO_PATTERNS = /^(no|cancel|stop|abort|para|atura|nega|deny)(?:\s|$)/i;

// ─── Risk Classification ────────────────────────────────────────────────────

/** Default risk levels for built-in tools */
const TOOL_RISK = {
  // Safe: read-only operations
  read: 'safe',
  glob: 'safe',
  grep: 'safe',
  git_status: 'safe',
  git_log: 'safe',
  git_diff: 'safe',
  brain_search: 'safe',
  brain_get_context: 'safe',

  // Low: write operations (reversible)
  write: 'low',
  edit: 'low',
  brain_remember: 'low',

  // Medium: system commands (context-dependent)
  bash: 'medium',
  run_command: 'medium',
  agent: 'low',
  api_call: 'medium',
};

/** Dangerous command patterns in bash args */
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[rRf]+\s+|.*--no-preserve-root)/i,
  /\bsudo\b/i,
  /\bdocker\s+(rm|stop|kill|prune)\b/i,
  /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[fdx])/i,
  /\bcurl\b.*\b(-X\s*(DELETE|PUT|POST|PATCH))\b/i,
  /\bsystemctl\s+(stop|restart|disable)\b/i,
  /\bkill\s+-9\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

/**
 * Classify risk level for a tool call.
 * @param {string} toolName
 * @param {Object} args — Tool arguments
 * @returns {'safe'|'low'|'medium'|'high'}
 */
export function classifyRisk(toolName, args = {}) {
  const baseRisk = TOOL_RISK[toolName] || 'medium';

  // Bash: check for dangerous patterns
  if (toolName === 'bash' && args.command) {
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(args.command)) return 'high';
    }
  }

  // api_call: DELETE/PUT are riskier
  if (toolName === 'api_call' && args.method) {
    if (/^(DELETE|PUT|PATCH)$/i.test(args.method)) return 'high';
  }

  return baseRisk;
}

// ─── Confirmation State ──────────────────────────────────────────────────────

/** Pending confirmations (keyed by unique ID) */
const _pending = new Map();
let _confirmationId = 0;

/**
 * Create a pending confirmation.
 * @param {Object} opts
 * @param {string} opts.toolName
 * @param {Object} opts.args
 * @param {string} opts.risk
 * @param {string} [opts.description]
 * @returns {{ id: string, promise: Promise<boolean>, resolve: Function }}
 */
export function createConfirmation({ toolName, args, risk, description, roomToken, userId }) {
  const id = `confirm-${++_confirmationId}`;
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });

  // Auto-timeout
  const timer = setTimeout(() => {
    if (_pending.has(id)) {
      _pending.delete(id);
      resolveFn(false);
      stderr.write(`\x1b[33m[confirmation] ${id} timed out → denied\x1b[0m\n`);
    }
  }, CONFIRMATION_TIMEOUT_MS);

  const entry = {
    id,
    toolName,
    args,
    risk,
    roomToken: roomToken || null,
    userId: userId || null,
    description: description || formatConfirmationMessage(toolName, args, risk),
    createdAt: new Date().toISOString(),
    promise,
    resolve: (approved) => {
      clearTimeout(timer);
      _pending.delete(id);
      resolveFn(!!approved);
    },
  };

  _pending.set(id, entry);
  return entry;
}

/**
 * Resolve a pending confirmation by ID.
 * @param {string} id
 * @param {boolean} approved
 * @returns {boolean} true if found and resolved
 */
export function resolveConfirmation(id, approved) {
  const entry = _pending.get(id);
  if (!entry) return false;
  entry.resolve(approved);
  return true;
}

/**
 * Try to match a Talk message to a pending confirmation.
 * @param {string} text — User's response text
 * @param {Object} [context] — { roomToken, userId } to scope matching
 * @returns {{ id: string, approved: boolean }|null}
 */
export function matchConfirmationResponse(text, context = {}) {
  const trimmed = (text || '').trim();

  // Get pending confirmations, filtered by context if provided
  let entries = [..._pending.values()];
  if (context.roomToken) {
    const scoped = entries.filter(e => e.roomToken === context.roomToken);
    if (scoped.length > 0) entries = scoped;
  }
  if (context.userId) {
    const scoped = entries.filter(e => !e.userId || e.userId === context.userId);
    if (scoped.length > 0) entries = scoped;
  }
  if (entries.length === 0) return null;
  const latest = entries[entries.length - 1];

  if (YES_PATTERNS.test(trimmed)) return { id: latest.id, approved: true };
  if (NO_PATTERNS.test(trimmed)) return { id: latest.id, approved: false };
  return null;
}

/**
 * Get all pending confirmations.
 * @returns {Array<{ id, toolName, args, risk, description, createdAt }>}
 */
export function getPendingConfirmations() {
  return [..._pending.values()].map(({ promise, resolve, ...rest }) => rest);
}

/**
 * Clear all pending confirmations (for cleanup/tests).
 */
export function clearPendingConfirmations() {
  for (const entry of _pending.values()) {
    entry.resolve(false);
  }
  _pending.clear();
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Patterns to redact from confirmation messages */
const SENSITIVE_PATTERNS = [
  /Authorization:\s*\S+(?:\s+\S+)?/gi,  // "Authorization: Bearer TOKEN" or "Authorization: TOKEN"
  /Bearer\s+\S+/gi,
  /token[=:]\S+/gi,
  /password[=:]\S+/gi,
  /secret[=:]\S+/gi,
  /api[_-]?key[=:]\S+/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // long base64 strings (likely tokens)
];

function redactSecrets(text) {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Format a human-readable confirmation message.
 * @param {string} toolName
 * @param {Object} args
 * @param {string} risk
 * @returns {string}
 */
export function formatConfirmationMessage(toolName, args, risk) {
  const emoji = risk === 'high' ? '🔴' : '🟡';
  let detail = '';

  if (toolName === 'bash' && args.command) {
    // Show first 200 chars of command, redacted
    const cmd = redactSecrets(args.command.slice(0, 200));
    detail = `\n\`\`\`\n${cmd}${args.command.length > 200 ? '...' : ''}\n\`\`\``;
  } else if (toolName === 'api_call') {
    detail = `\n${args.method || '?'} ${(args.url || '').slice(0, 100)}`;
  } else {
    detail = `\nArgs: ${JSON.stringify(args).slice(0, 200)}`;
  }

  return `${emoji} **Confirmació requerida** (risk: ${risk})\n\nTool: \`${toolName}\`${detail}\n\nRespon **sí** o **no**`;
}
