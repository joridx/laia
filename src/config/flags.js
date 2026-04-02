// src/config/flags.js — Feature flags for LAIA V5
// Simple, local-first feature flags with env var overrides.
// File: ~/.laia/flags.json
// Env: LAIA_FLAG_<UPPER_SNAKE> (e.g. LAIA_FLAG_HOOKS_ENABLED=false)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Default flags ───────────────────────────────────────────────────────────

const DEFAULTS = {
  // V5 Sprint 1
  hooks_enabled: true,            // Hook bus active
  hooks_trust_workspace: false,   // Allow .laia/hooks.js from workspace (security)
  doctor_enabled: true,           // /doctor command
  telemetry_local: true,          // Local telemetry (daily.jsonl)

  // V5 Sprint 2 (prepared, off by default)
  skill_hot_reload: false,        // Chokidar watcher for skills
  skill_auto_improvement: false,  // LLM side-channel skill improvement
  skillify_enabled: true,         // /skillify command

  // V5 Sprint 3
  memory_rerank: 'auto',          // off | auto | always
  away_summary: false,            // Show summary after idle

  // V5 Sprint 4
  magic_docs: false,              // Auto-update MAGIC DOC headers
  reactive_compaction: false,     // Pre/post compact hooks
};

// ─── Flags file path ─────────────────────────────────────────────────────────

const FLAGS_DIR = join(homedir(), '.laia');
const FLAGS_FILE = join(FLAGS_DIR, 'flags.json');

// ─── In-memory cache (loaded once per session) ──────────────────────────────

let _cache = null;

/**
 * Load flags from file + env overrides. Cached per session.
 * @param {boolean} [force=false] - Force reload from disk
 * @returns {object} Merged flags
 */
export function loadFlags(force = false) {
  if (_cache && !force) return { ..._cache };

  // Start with defaults
  let fileFlags = {};
  try {
    if (existsSync(FLAGS_FILE)) {
      fileFlags = JSON.parse(readFileSync(FLAGS_FILE, 'utf8'));
    }
  } catch {
    // Ignore parse errors — use defaults
  }

  // Merge: defaults < file < env
  const merged = { ...DEFAULTS, ...fileFlags };

  // Apply env overrides: LAIA_FLAG_HOOKS_ENABLED=false → hooks_enabled=false
  for (const key of Object.keys(DEFAULTS)) {
    const envKey = `LAIA_FLAG_${key.toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
      // Parse boolean/number/string
      if (envVal === 'true') merged[key] = true;
      else if (envVal === 'false') merged[key] = false;
      else if (!isNaN(Number(envVal))) merged[key] = Number(envVal);
      else merged[key] = envVal;
    }
  }

  _cache = merged;
  return { ...merged };
}

/**
 * Get a single flag value.
 * @param {string} key - Flag name
 * @param {*} [fallback] - Default if not found
 * @returns {*}
 */
export function getFlag(key, fallback) {
  const flags = loadFlags();
  return key in flags ? flags[key] : fallback;
}

/**
 * Set a flag value (persists to disk).
 * @param {string} key
 * @param {*} value
 */
export function setFlag(key, value) {
  // Validate key exists in defaults
  if (!(key in DEFAULTS)) {
    const known = Object.keys(DEFAULTS);
    const close = known.filter(k => k.includes(key) || key.includes(k));
    const hint = close.length ? ` Did you mean: ${close.join(', ')}?` : ` Known flags: ${known.join(', ')}`;
    throw new Error(`Unknown flag '${key}'.${hint}`);
  }

  let fileFlags = {};
  try {
    if (existsSync(FLAGS_FILE)) {
      fileFlags = JSON.parse(readFileSync(FLAGS_FILE, 'utf8'));
    }
  } catch {}

  fileFlags[key] = value;
  mkdirSync(FLAGS_DIR, { recursive: true });
  writeFileSync(FLAGS_FILE, JSON.stringify(fileFlags, null, 2) + '\n');

  // Invalidate cache
  _cache = null;
}

/**
 * Get all flags with their source (default/file/env).
 * Useful for /doctor and debugging.
 * @returns {Array<{ key: string, value: *, source: 'default'|'file'|'env' }>}
 */
export function getFlagsWithSource() {
  let fileFlags = {};
  try {
    if (existsSync(FLAGS_FILE)) {
      fileFlags = JSON.parse(readFileSync(FLAGS_FILE, 'utf8'));
    }
  } catch {}

  const result = [];
  for (const key of Object.keys(DEFAULTS)) {
    const envKey = `LAIA_FLAG_${key.toUpperCase()}`;
    const envVal = process.env[envKey];

    if (envVal !== undefined) {
      result.push({ key, value: loadFlags()[key], source: 'env' });
    } else if (key in fileFlags) {
      result.push({ key, value: fileFlags[key], source: 'file' });
    } else {
      result.push({ key, value: DEFAULTS[key], source: 'default' });
    }
  }
  return result;
}

/**
 * Initialize flags file if it doesn't exist (first run).
 */
export function initFlagsFile() {
  if (existsSync(FLAGS_FILE)) return;
  mkdirSync(FLAGS_DIR, { recursive: true });
  writeFileSync(FLAGS_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
}

/** @internal For tests */
export function _resetCache() { _cache = null; }
