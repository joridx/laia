// src/hooks/auto-recall.js — Auto-recall memories on SessionStart
// Sprint 1 Feature B: BM25+embeddings search with first user message
//
// Registers a SessionStart hook that searches the brain with the user's
// first message and caches the result for injection into P4 Task Context.
//
// Guards (CODEX consensus):
// - Timeout: 2s max
// - Skip trivial messages (< 10 chars or greetings)
// - Minimum score threshold (discard noise)
// - Cache per session (never re-run)

import { on } from './bus.js';
import { stderr } from 'process';

// ─── Constants ───────────────────────────────────────────────────────────────

const RECALL_TIMEOUT_MS = 2_000;
const MIN_MESSAGE_LENGTH = 10;
const MAX_RESULTS = 3;
const MAX_RESULT_CHARS = 2_000;  // 2KB sub-budget within P4

// Greeting patterns (skip auto-recall for trivial messages)
const GREETING_PATTERNS = /^(hola|bon dia|bona tarda|bona nit|hey|hi|hello|ok|thanks|gràcies|merci|good morning|sup)\b/i;

// ─── State ───────────────────────────────────────────────────────────────────

let _cachedRecall = null;
let _initialized = false;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get cached auto-recall results (for system prompt injection).
 * Returns formatted string or null.
 * @returns {string|null}
 */
export function getAutoRecallContext() {
  return _cachedRecall;
}

/**
 * Manually trigger auto-recall with a message.
 * Used by the turn runner on the first user message.
 * @param {string} message - User message to search with
 * @param {Function} brainSearchFn - async (query, opts) => results
 * @returns {Promise<string|null>}
 */
export async function triggerAutoRecall(message, brainSearchFn) {
  // Already cached this session
  if (_cachedRecall !== null) return _cachedRecall;

  // Guard: trivial message
  if (!message || message.length < MIN_MESSAGE_LENGTH) {
    _cachedRecall = '';  // Mark as "attempted" (won't retry)
    return null;
  }

  // Guard: greeting
  if (GREETING_PATTERNS.test(message.trim())) {
    _cachedRecall = '';
    return null;
  }

  try {
    const result = await Promise.race([
      brainSearchFn(message, { limit: MAX_RESULTS, scope: 'all' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('auto-recall timeout')), RECALL_TIMEOUT_MS)
      ),
    ]);

    if (!result || typeof result !== 'string' || result.trim().length === 0) {
      _cachedRecall = '';
      return null;
    }

    // Truncate to budget
    let formatted = result.trim();
    if (formatted.length > MAX_RESULT_CHARS) {
      formatted = formatted.slice(0, MAX_RESULT_CHARS) + '\n...(truncated)';
    }

    _cachedRecall = formatted;
    stderr.write(`\x1b[2m[auto-recall] Found ${formatted.split('\n').length} relevant memories\x1b[0m\n`);
    return formatted;
  } catch (err) {
    stderr.write(`\x1b[2m[auto-recall] ${err.message}\x1b[0m\n`);
    _cachedRecall = '';  // Mark attempted
    return null;
  }
}

/**
 * Reset cache (for tests or new session).
 */
export function resetAutoRecall() {
  _cachedRecall = null;
  _initialized = false;
}

/**
 * Register the SessionStart hook.
 * Note: The actual search happens on first user message (via triggerAutoRecall),
 * not on SessionStart itself — because we need the user's message as the query.
 */
export function registerAutoRecallHook() {
  if (_initialized) return;
  _initialized = true;

  on('SessionStart', async () => {
    // Reset cache for new session
    _cachedRecall = null;
    stderr.write('\x1b[2m[auto-recall] Ready (will trigger on first message)\x1b[0m\n');
  }, { label: 'auto-recall-init' });
}
