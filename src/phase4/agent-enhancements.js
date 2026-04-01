// src/phase4/agent-enhancements.js — Agent tool improvements
// Inspired by Claude Code's AgentTool (subagent_type, run_in_background, description)
// Enhances the existing tools/agent.js with new capabilities.

import { stderr } from 'process';

// ─── Background Agent Registry ───────────────────────────────────────────────
// Tracks agents running in background mode. Results are stored and
// can be polled or notified.

const backgroundAgents = new Map();
let bgCounter = 0;
const MAX_BACKGROUND = 200;

// Auto-cleanup: run on every new background agent start
function autoCleanup() {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
  for (const [id, entry] of backgroundAgents) {
    if (entry.completedAt && entry.completedAt < cutoff) {
      backgroundAgents.delete(id);
    }
  }
  // Hard cap: evict oldest completed if over limit
  if (backgroundAgents.size >= MAX_BACKGROUND) {
    for (const [id, entry] of backgroundAgents) {
      if (entry.status !== 'running') { backgroundAgents.delete(id); break; }
    }
  }
}

/**
 * Run an agent in background mode.
 * Returns immediately with a task ID. Result is stored when complete.
 * @param {Function} executeAgent - The agent execute function
 * @param {object} args - Agent args (prompt, files, etc.)
 * @returns {{ taskId: string, status: 'started' }}
 */
export function runInBackground(executeAgent, args) {
  autoCleanup(); // Periodic cleanup on every new spawn
  const taskId = `bg-${++bgCounter}`;
  const entry = {
    taskId,
    description: args.description || args.prompt?.slice(0, 60) || 'background task',
    status: 'running',
    startedAt: Date.now(),
    result: null,
    error: null,
  };

  backgroundAgents.set(taskId, entry);
  stderr.write(`\x1b[2m[${taskId}] Background agent started: ${entry.description}\x1b[0m\n`);

  // Fire-and-forget: run the agent, store result when done
  executeAgent(args)
    .then(result => {
      entry.status = result.success ? 'completed' : 'failed';
      entry.result = result;
      entry.completedAt = Date.now();
      const dur = ((entry.completedAt - entry.startedAt) / 1000).toFixed(1);
      if (result.success) {
        stderr.write(`\x1b[32m[${taskId}] ✅ Completed in ${dur}s\x1b[0m\n`);
      } else {
        stderr.write(`\x1b[31m[${taskId}] ❌ Failed in ${dur}s: ${result.error}\x1b[0m\n`);
        entry.error = result.error;
      }
    })
    .catch(err => {
      entry.status = 'failed';
      entry.error = err.message || String(err);
      entry.completedAt = Date.now();
      stderr.write(`\x1b[31m[${taskId}] ❌ Error: ${entry.error}\x1b[0m\n`);
    });

  return { taskId, status: 'started', description: entry.description };
}

/**
 * Get background agent status/result.
 */
export function getBackgroundAgent(taskId) {
  return backgroundAgents.get(taskId) || null;
}

/**
 * List all background agents.
 */
export function listBackgroundAgents() {
  return [...backgroundAgents.values()].map(e => ({
    taskId: e.taskId,
    description: e.description,
    status: e.status,
    startedAt: e.startedAt,
    completedAt: e.completedAt,
    durationMs: e.completedAt ? e.completedAt - e.startedAt : Date.now() - e.startedAt,
    hasResult: !!e.result,
  }));
}

/**
 * Get result of a completed background agent.
 */
export function getBackgroundResult(taskId) {
  const entry = backgroundAgents.get(taskId);
  if (!entry) return { error: `Task '${taskId}' not found` };
  if (entry.status === 'running') return { status: 'running', description: entry.description };
  return entry.result || { error: entry.error };
}

/**
 * Clean up old background entries (> 1 hour).
 */
export function cleanupBackground() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, entry] of backgroundAgents) {
    if (entry.completedAt && entry.completedAt < cutoff) {
      backgroundAgents.delete(id);
    }
  }
}

// ─── Enhanced Agent Schema ───────────────────────────────────────────────────

/**
 * Get enhanced agent schema with new params.
 * Merges with base schema from tools/agent.js
 */
export function getEnhancedAgentParams() {
  return {
    description: {
      type: 'string',
      description: 'A short (3-5 word) description of the task for tracking/display',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Run this agent in background mode. Returns immediately with a task ID. Use /tasks to check status.',
    },
  };
}
