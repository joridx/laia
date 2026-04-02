// src/hooks/events.js — Hook event definitions for LAIA V5
// 8 core events (lite-first approach, expandable later)

/**
 * @typedef {'SessionStart'|'SessionEnd'|'PreToolUse'|'PostToolUse'|'PreCompact'|'PostCompact'|'TaskStarted'|'TaskCompleted'} HookEvent
 */

/** All supported hook events with descriptions */
export const HOOK_EVENTS = {
  SessionStart:   { desc: 'Fired when REPL starts, after brain + tools are ready' },
  SessionEnd:     { desc: 'Fired before REPL closes (before reflection/autosave)' },
  PreToolUse:     { desc: 'Fired before a tool call executes', payload: '{ name, args, turnId }' },
  PostToolUse:    { desc: 'Fired after a tool call completes', payload: '{ name, args, result, success, turnId }' },
  PreCompact:     { desc: 'Fired before context compaction starts', payload: '{ turns, tokens }' },
  PostCompact:    { desc: 'Fired after compaction completes', payload: '{ success, stats }' },
  TaskStarted:    { desc: 'Fired when a background agent task starts', payload: '{ taskId, description }' },
  TaskCompleted:  { desc: 'Fired when a background agent completes', payload: '{ taskId, description, success, durationMs }' },
};

export const EVENT_NAMES = /** @type {HookEvent[]} */ (Object.keys(HOOK_EVENTS));
