// src/skills/watcher.js — Skill hot-reload via chokidar
// Watches ~/.laia/skills/ and project skills for changes.
// Debounces reloads (300ms) and logs to stderr.

import { watch } from 'chokidar';
import { join } from 'path';
import { homedir } from 'os';
import { stderr } from 'process';
import { getFlag } from '../config/flags.js';
import { emit } from '../hooks/bus.js';

const DIM = '\x1b[2m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[0m';

let _watcher = null;
let _debounceTimer = null;
let _reloadFn = null;
let _reloadCount = 0;

/**
 * Start watching skill directories for changes.
 * @param {object} opts
 * @param {string} [opts.workspaceRoot] - Project root (for project-level skills)
 * @param {Function} opts.onReload - Called after skills reload: (count) => void
 */
export function startSkillWatcher({ workspaceRoot, onReload }) {
  if (!getFlag('skill_hot_reload', false)) return;
  if (_watcher) return; // Already watching

  _reloadFn = onReload;

  const watchPaths = [
    join(homedir(), '.laia', 'skills'),
    join(homedir(), '.laia', 'commands'),
  ];
  if (workspaceRoot) {
    watchPaths.push(join(workspaceRoot, 'laia-skills'));
  }

  try {
    _watcher = watch(watchPaths, {
      ignoreInitial: true,
      depth: 2,
      // Use polling under Bun to avoid fs.watch deadlocks
      usePolling: typeof Bun !== 'undefined',
      interval: 500,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    _watcher.on('all', (event, path) => {
      // Only react to .md file changes
      if (!path.endsWith('.md')) return;

      // Debounce: batch rapid changes
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        _reloadCount++;
        stderr.write(`${DIM}[skills] Change detected (${event}): ${path} — reloading...${R}\n`);

        try {
          // Invalidate skill cache by calling discoverSkills with force
          // The actual function is passed via onReload callback
          if (_reloadFn) _reloadFn(_reloadCount);

          stderr.write(`${G}[skills] Reloaded (#${_reloadCount})${R}\n`);

          // Emit hook
          emit('PostToolUse', {
            name: '_skill_reload',
            args: { path, event },
            result: { count: _reloadCount },
            success: true,
            turnId: null,
          }).catch(() => {});
        } catch (err) {
          stderr.write(`${Y}[skills] Reload failed: ${err.message}${R}\n`);
        }
      }, 300);
    });

    _watcher.on('error', (err) => {
      stderr.write(`${Y}[skills] Watcher error: ${err.message}${R}\n`);
    });

    stderr.write(`${DIM}[skills] Hot-reload watcher started${R}\n`);
  } catch (err) {
    stderr.write(`${Y}[skills] Failed to start watcher: ${err.message}${R}\n`);
  }
}

/**
 * Stop watching (cleanup on session end).
 */
export async function stopSkillWatcher() {
  if (!_watcher) return;
  try {
    await _watcher.close();
  } catch {}
  _watcher = null;
  _reloadFn = null;
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
}

/**
 * Get watcher stats.
 * @returns {{ active: boolean, reloadCount: number }}
 */
export function getWatcherStats() {
  return {
    active: _watcher !== null,
    reloadCount: _reloadCount,
  };
}
