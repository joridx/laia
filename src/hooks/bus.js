// src/hooks/bus.js — Central hook event bus for LAIA V5
// Lite EventEmitter wrapper with error isolation and timing.
// Handlers registered via config (~/.laia/hooks.js) or programmatic API.

import { EventEmitter } from 'events';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stderr } from 'process';
import { pathToFileURL } from 'url';
import { EVENT_NAMES } from './events.js';

// ─── Singleton bus ───────────────────────────────────────────────────────────

const _emitter = new EventEmitter();
_emitter.setMaxListeners(50);  // Allow many hooks per event

// Telemetry counters (per-session, reset on init)
const _stats = {
  emitted: {},     // { [event]: count }
  errors: {},      // { [event]: count }
  totalMs: {},     // { [event]: cumulative handler time }
};

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Register a hook handler for an event.
 * @param {string} event - One of EVENT_NAMES
 * @param {Function} handler - async (payload) => void
 * @param {object} [opts]
 * @param {string} [opts.label] - Human label for debugging
 * @returns {Function} unsubscribe function
 */
export function on(event, handler, opts = {}) {
  if (!EVENT_NAMES.includes(event)) {
    stderr.write(`\x1b[33m[hooks] Warning: unknown event "${event}". Known: ${EVENT_NAMES.join(', ')}\x1b[0m\n`);
  }
  const wrapped = async (payload) => {
    const start = Date.now();
    try {
      // Timeout: 5s per handler to prevent backpressure
      await Promise.race([
        handler(payload),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hook timeout (5s)')), 5000)),
      ]);
    } catch (err) {
      _stats.errors[event] = (_stats.errors[event] || 0) + 1;
      stderr.write(`\x1b[33m[hooks] Handler error on ${event}${opts.label ? ` (${opts.label})` : ''}: ${err?.stack || String(err)}\x1b[0m\n`);
    } finally {
      _stats.totalMs[event] = (_stats.totalMs[event] || 0) + (Date.now() - start);
    }
  };
  wrapped._original = handler;
  wrapped._label = opts.label;
  _emitter.on(event, wrapped);
  return () => _emitter.off(event, wrapped);
}

/**
 * Emit a hook event. All handlers run concurrently (Promise.allSettled).
 * Errors in handlers are caught and logged — never propagate to caller.
 * @param {string} event - Event name
 * @param {object} [payload] - Event payload
 * @returns {Promise<void>}
 */
export async function emit(event, payload = {}) {
  _stats.emitted[event] = (_stats.emitted[event] || 0) + 1;
  const listeners = _emitter.listeners(event);
  if (listeners.length === 0) return;
  // Freeze payload to prevent mutation by hooks
  const frozen = Object.freeze({ ...payload });
  await Promise.allSettled(listeners.map(fn => fn(frozen)));
}

/**
 * Emit synchronously (fire-and-forget). For hot paths where we can't await.
 * @param {string} event
 * @param {object} [payload]
 */
export function emitSync(event, payload = {}) {
  _stats.emitted[event] = (_stats.emitted[event] || 0) + 1;
  const listeners = _emitter.listeners(event);
  // Freeze payload to prevent mutation by hooks
  const frozen = Object.freeze({ ...payload });
  for (const fn of listeners) {
    fn(frozen).catch(() => {});  // Fire and forget
  }
}

/**
 * Remove all handlers for an event (or all events).
 * @param {string} [event] - If omitted, clears all
 */
export function off(event) {
  if (event) {
    _emitter.removeAllListeners(event);
  } else {
    _emitter.removeAllListeners();
  }
}

/**
 * Get hook stats for telemetry/doctor.
 * @returns {{ emitted: object, errors: object, totalMs: object, handlerCounts: object }}
 */
export function getHookStats() {
  const handlerCounts = {};
  for (const event of EVENT_NAMES) {
    handlerCounts[event] = _emitter.listenerCount(event);
  }
  return { ..._stats, handlerCounts };
}

// ─── User hooks loader ──────────────────────────────────────────────────────

/**
 * Load user hooks from ~/.laia/hooks.js (ESM module).
 * Expected export: default function(bus) { bus.on('PreToolUse', ...) }
 * Or named exports: export function onPreToolUse(payload) { ... }
 *
 * Also loads project-level hooks from .laia/hooks.js if present.
 */
export async function loadUserHooks(workspaceRoot) {
  const bus = { on, emit, off, EVENT_NAMES };
  const paths = [
    { path: join(homedir(), '.laia', 'hooks.js'), trusted: true },
  ];

  // Workspace hooks require explicit trust (security: prevents RCE from untrusted repos)
  if (workspaceRoot) {
    const wsHooks = join(workspaceRoot, '.laia', 'hooks.js');
    if (existsSync(wsHooks)) {
      const { getFlag } = await import('../config/flags.js');
      if (getFlag('hooks_trust_workspace', false)) {
        paths.push({ path: wsHooks, trusted: true });
      } else {
        stderr.write(`\x1b[33m[hooks] Skipping workspace hooks (${wsHooks}) — set hooks_trust_workspace=true to enable\x1b[0m\n`);
      }
    }
  }

  for (const { path: hookPath } of paths) {
    if (!existsSync(hookPath)) continue;
    try {
      const mod = await import(pathToFileURL(hookPath).href);
      if (typeof mod.default === 'function') {
        // Default export: function(bus) => void
        await mod.default(bus);
        stderr.write(`\x1b[2m[hooks] Loaded ${hookPath} (default export)\x1b[0m\n`);
      } else {
        // Named exports: onPreToolUse, onPostToolUse, etc.
        let count = 0;
        for (const [name, fn] of Object.entries(mod)) {
          if (typeof fn !== 'function') continue;
          const match = name.match(/^on([A-Z]\w+)$/);
          if (match) {
            on(match[1], fn, { label: `${hookPath}:${name}` });
            count++;
          }
        }
        if (count > 0) {
          stderr.write(`\x1b[2m[hooks] Loaded ${hookPath} (${count} named handlers)\x1b[0m\n`);
        }
      }
    } catch (err) {
      stderr.write(`\x1b[33m[hooks] Failed to load ${hookPath}: ${err.message}\x1b[0m\n`);
    }
  }
}

// ─── Reset (for tests) ──────────────────────────────────────────────────────

export function _reset() {
  _emitter.removeAllListeners();
  for (const key of Object.keys(_stats)) {
    for (const event of Object.keys(_stats[key])) {
      delete _stats[key][event];
    }
  }
}
