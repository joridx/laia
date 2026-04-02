// src/services/away-summary.js — Away/idle summary for LAIA V5
// Detects user inactivity and shows summary of what happened (background agents,
// completed tasks) when the user returns.

import { stderr } from 'process';
import { getFlag } from '../config/flags.js';
import { listBackgroundAgents } from '../coordinator/background.js';

const DIM = '\x1b[2m';
const B = '\x1b[1m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const RED = '\x1b[31m';
const C = '\x1b[36m';
const R = '\x1b[0m';

// ─── State ───────────────────────────────────────────────────────────────────

let _lastInputTime = Date.now();
let _lastSummaryTime = 0;
let _snapshotAtIdle = null; // Snapshot of state when user went idle

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;      // 5 minutes
const SUMMARY_COOLDOWN_MS = 2 * 60 * 1000;    // Don't show more than once per 2 min

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Record that the user provided input (call on every prompt submission).
 */
export function recordUserInput() {
  _lastInputTime = Date.now();
}

/**
 * Take a snapshot of current state (called periodically or after each turn).
 * Used to compare against state when user returns.
 */
export function snapshotState() {
  try {
    const agents = listBackgroundAgents();
    _snapshotAtIdle = {
      time: Date.now(),
      // Lightweight: only store taskId → status map (no full details)
      agentDetails: agents.map(a => ({
        taskId: a.taskId,
        status: a.status,
      })),
    };
  } catch {
    _snapshotAtIdle = { time: Date.now(), agentDetails: [] };
  }
}

/**
 * Check if user was idle and generate summary if needed.
 * Call this BEFORE processing user input in the REPL loop.
 * @returns {string|null} Summary text to display, or null
 */
export function checkAndShowAwaySummary() {
  if (!getFlag('away_summary', false)) return null;

  const now = Date.now();
  const idleMs = now - _lastInputTime;

  // Not idle enough
  if (idleMs < IDLE_THRESHOLD_MS) return null;

  // Cooldown: don't spam summaries
  if (now - _lastSummaryTime < SUMMARY_COOLDOWN_MS) return null;

  // No snapshot to compare against
  if (!_snapshotAtIdle) return null;

  // Build summary
  const summary = buildSummary(idleMs);
  if (!summary) return null;

  _lastSummaryTime = now;
  return summary;
}

/**
 * Build the away summary text.
 * @param {number} idleMs - How long the user was idle
 * @returns {string|null}
 */
function buildSummary(idleMs) {
  const parts = [];

  // Time away
  const mins = Math.floor(idleMs / 60000);
  const timeStr = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  parts.push(`${C}⏰ Welcome back!${R} You were away for ${B}${timeStr}${R}.`);

  // Background agents that changed
  try {
    const currentAgents = listBackgroundAgents();
    const snap = _snapshotAtIdle;

    const newCompleted = currentAgents.filter(a =>
      a.status === 'completed' &&
      (snap.agentDetails.find(s => s.taskId === a.taskId)?.status === 'running' ||
       !snap.agentDetails.find(s => s.taskId === a.taskId))  // Task born + completed during absence
    );
    const newFailed = currentAgents.filter(a =>
      a.status === 'failed' &&
      (snap.agentDetails.find(s => s.taskId === a.taskId)?.status === 'running' ||
       !snap.agentDetails.find(s => s.taskId === a.taskId))  // Task born + failed during absence
    );
    const stillRunning = currentAgents.filter(a => a.status === 'running');

    if (newCompleted.length > 0) {
      parts.push(`${G}✅ ${newCompleted.length} agent(s) completed:${R}`);
      for (const a of newCompleted) {
        const dur = a.durationMs ? ` (${(a.durationMs / 1000).toFixed(1)}s)` : '';
        parts.push(`   ${G}•${R} ${a.description}${DIM}${dur}${R}`);
      }
    }

    if (newFailed.length > 0) {
      parts.push(`${RED}❌ ${newFailed.length} agent(s) failed:${R}`);
      for (const a of newFailed) {
        parts.push(`   ${RED}•${R} ${a.description}`);
      }
    }

    if (stillRunning.length > 0) {
      parts.push(`${Y}⏳ ${stillRunning.length} agent(s) still running:${R}`);
      for (const a of stillRunning) {
        const elapsed = a.startedAt ? ((Date.now() - a.startedAt) / 1000).toFixed(0) : '?';
        parts.push(`   ${Y}•${R} ${a.description}${DIM} (${elapsed}s)${R}`);
      }
    }

    // If nothing happened, don't show summary
    if (newCompleted.length === 0 && newFailed.length === 0 && stillRunning.length === 0) {
      return null;
    }
  } catch {
    return null;
  }

  parts.push('');
  return parts.join('\n');
}

/**
 * Get idle stats for doctor/diagnostics.
 */
export function getIdleStats() {
  return {
    lastInputMs: Date.now() - _lastInputTime,
    idleThresholdMs: IDLE_THRESHOLD_MS,
    hasSnapshot: _snapshotAtIdle !== null,
  };
}
