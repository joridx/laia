// src/services/suggestions.js — Contextual prompt suggestions for LAIA V5
// Shows 1-2 actionable hints before the prompt, based on local state (zero LLM cost).
// Sources: git status, background agents, context usage, pending improvements, magic docs.

import { stderr } from 'process';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const DIM = '\x1b[2m';
const R = '\x1b[0m';

const MAX_SUGGESTIONS = 2;
const COOLDOWN_MS = 5 * 60 * 1000;  // Don't repeat same suggestion within 5 min

// ─── State ──────────────────────────────────────────────────────────────────

const _lastShown = new Map();  // key → timestamp

// ─── Suggestion generators ──────────────────────────────────────────────────

// ─── Git status cache (avoids blocking REPL on every prompt) ────────────────

let _gitStatusCache = null;
let _gitStatusTs = 0;
const GIT_STATUS_TTL_MS = 15_000;  // Cache for 15s

function gitSuggestions(workspaceRoot) {
  const suggestions = [];
  try {
    const now = Date.now();
    let status;
    if (_gitStatusCache !== null && (now - _gitStatusTs) < GIT_STATUS_TTL_MS) {
      status = _gitStatusCache;
    } else {
      status = execSync('git status --porcelain', {
        cwd: workspaceRoot, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      _gitStatusCache = status;
      _gitStatusTs = now;
    }
    if (!status) return suggestions;

    const lines = status.split('\n').filter(Boolean);
    // Parse XY format correctly: X=index, Y=worktree
    // '??' = untracked, ' M' = modified worktree, 'M ' = staged, 'MM' = both
    const staged = lines.filter(l => l.length >= 2 && /[MADRC]/.test(l[0]) && l[0] !== '?').length;
    const unstaged = lines.filter(l => l.length >= 2 && /[MADRC]/.test(l[1])).length;
    const untracked = lines.filter(l => l.startsWith('??')).length;

    if (staged > 0) {
      suggestions.push({ key: 'git-staged', text: `${staged} staged file(s) ready. Try: /commit` });
    } else if (unstaged > 0 && unstaged <= 10) {
      suggestions.push({ key: 'git-unstaged', text: `${unstaged} changed file(s). Try: "commit these changes" or /commit` });
    }
    if (untracked > 3) {
      suggestions.push({ key: 'git-untracked', text: `${untracked} untracked files. Consider adding them or updating .gitignore` });
    }
  } catch {}
  return suggestions;
}

async function backgroundAgentSuggestions() {
  const suggestions = [];
  try {
    const { listBackgroundAgents } = await import('../coordinator/background.js');
    const agents = listBackgroundAgents();
    const completed = agents.filter(a => a.status === 'completed');
    const failed = agents.filter(a => a.status === 'failed');
    const running = agents.filter(a => a.status === 'running');

    if (completed.length > 0) {
      const latest = completed[completed.length - 1];
      suggestions.push({ key: `bg-done-${latest.taskId}`, text: `${completed.length} agent(s) completed. Try: /tasks get ${latest.taskId}` });
    }
    if (failed.length > 0) {
      suggestions.push({ key: 'bg-failed', text: `${failed.length} agent(s) failed. Try: /tasks` });
    }
    if (running.length > 0) {
      suggestions.push({ key: 'bg-running', text: `${running.length} agent(s) running. Try: /tasks` });
    }
  } catch {}
  return suggestions;
}

function contextSuggestions(context) {
  const suggestions = [];
  if (!context) return suggestions;

  try {
    const pct = context.usagePercent();
    const turns = context.turnCount();

    if (pct > 70) {
      suggestions.push({ key: 'ctx-high', text: `Context ${pct}% full. Consider: /compact` });
    } else if (turns > 30) {
      suggestions.push({ key: 'ctx-turns', text: `${turns} turns this session. Consider: /compact or /save` });
    }
  } catch {}
  return suggestions;
}

function projectSuggestions(workspaceRoot) {
  const suggestions = [];

  // No LAIA.md → suggest /init
  const hasProjectMd = existsSync(join(workspaceRoot, 'LAIA.md'))
    || existsSync(join(workspaceRoot, '.laia', 'LAIA.md'));
  if (!hasProjectMd) {
    suggestions.push({ key: 'no-laiamd', text: 'No project LAIA.md found. Try: /init' });
  }

  return suggestions;
}

async function pendingSuggestions() {
  const suggestions = [];
  try {
    const { getPendingImprovement } = await import('../skills/improvement.js');
    const pending = getPendingImprovement();
    if (pending) {
      suggestions.push({ key: 'skill-improve', text: `Skill improvement suggested for ${pending.skillName}. Review with /flags` });
    }
  } catch {}

  try {
    const { getPendingUpdates } = await import('../services/magic-docs.js');
    const updates = getPendingUpdates();
    if (updates.length > 0) {
      suggestions.push({ key: 'magic-update', text: `${updates.length} magic doc update(s) pending` });
    }
  } catch {}

  return suggestions;
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Gather contextual suggestions from all sources.
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {object} [opts.context] - Conversation context (for token/turn counts)
 * @returns {string[]} Formatted suggestion lines (max 2)
 */
export async function gatherSuggestions({ workspaceRoot, context }) {
  const now = Date.now();
  const all = [];

  // Priority order: pending actions > context > git > project
  try { all.push(...await pendingSuggestions()); } catch {}
  try { all.push(...await backgroundAgentSuggestions()); } catch {}
  try { all.push(...contextSuggestions(context)); } catch {}
  try { all.push(...gitSuggestions(workspaceRoot)); } catch {}
  try { all.push(...projectSuggestions(workspaceRoot)); } catch {}

  // Filter by cooldown
  const filtered = all.filter(s => {
    const last = _lastShown.get(s.key);
    return !last || (now - last) >= COOLDOWN_MS;
  });

  // Take top N and record shown time
  const selected = filtered.slice(0, MAX_SUGGESTIONS);
  for (const s of selected) {
    _lastShown.set(s.key, now);
  }

  // Housekeeping: cap _lastShown size (prevent unbounded growth in long sessions)
  if (_lastShown.size > 200) {
    // Delete oldest entries
    const entries = [..._lastShown.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < entries.length - 100; i++) {
      _lastShown.delete(entries[i][0]);
    }
  }

  return selected.map(s => s.text);
}

/**
 * Format and display suggestions to stderr.
 * @param {string[]} suggestions
 */
export function displaySuggestions(suggestions) {
  if (!suggestions || suggestions.length === 0) return;
  for (const s of suggestions) {
    stderr.write(`${DIM}  💡 ${s}${R}\n`);
  }
}

/**
 * Clear cooldown cache (for tests or session reset).
 */
export function _reset() {
  _lastShown.clear();
}
