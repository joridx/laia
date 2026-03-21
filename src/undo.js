// Undo stack — tracks file snapshots before write/edit so /undo can restore them.
// Each "turn" groups all file changes together. /undo reverts the most recent turn.

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'fs';
import { resolve, normalize } from 'path';

const MAX_TURNS = 10;

export function createUndoStack({ workspaceRoot } = {}) {
  // Stack of turns, each turn = Map<absPath, { content: string|null, mtimeMs: number|null }>
  // content=null means the file didn't exist before (was created)
  const stack = [];
  let currentTurn = null;

  /** Check path is inside workspace root (defense-in-depth) */
  function isInsideWorkspace(absPath) {
    if (!workspaceRoot) return true;
    const norm = normalize(resolve(absPath));
    const root = normalize(resolve(workspaceRoot));
    return norm.startsWith(root);
  }

  return {
    /** Start tracking a new turn. Call before the agent loop processes tools. */
    startTurn() {
      currentTurn = new Map();
    },

    /** 
     * Snapshot a file BEFORE it's modified. Call from write/edit tools.
     * Only captures the first snapshot per file per turn (original state).
     */
    trackFile(absPath) {
      if (!currentTurn) return;
      if (currentTurn.has(absPath)) return; // already captured this turn
      if (!isInsideWorkspace(absPath)) return; // refuse out-of-workspace files
      let content = null;
      let mtimeMs = null;
      try {
        content = readFileSync(absPath, 'utf8');
        mtimeMs = statSync(absPath).mtimeMs;
      } catch { /* new file */ }
      currentTurn.set(absPath, { content, mtimeMs });
    },

    /** Finish the current turn and push to stack (only if files were tracked). */
    commitTurn() {
      if (!currentTurn || currentTurn.size === 0) {
        currentTurn = null;
        return;
      }
      stack.push(currentTurn);
      if (stack.length > MAX_TURNS) stack.shift();
      currentTurn = null;
    },

    /** Discard current turn without committing (for failed/aborted turns). */
    cancelTurn() {
      currentTurn = null;
    },

    /** 
     * Undo the most recent turn: restore all files to their pre-modification state.
     * Returns { restored: string[], deleted: string[], conflicts: string[] } or null if nothing to undo.
     */
    undo() {
      if (stack.length === 0) return null;
      const turn = stack.pop();
      const restored = [];
      const deleted = [];
      const conflicts = [];

      for (const [absPath, { content, mtimeMs }] of turn) {
        try {
          // Conflict detection: if file was modified by user after agent edit, warn
          if (existsSync(absPath) && mtimeMs !== null) {
            const currentMtime = statSync(absPath).mtimeMs;
            if (currentMtime > mtimeMs + 1000) { // 1s tolerance
              conflicts.push(absPath);
              // Still restore (best-effort) but report conflict
            }
          }

          if (content === null) {
            // File was created by the agent — delete it
            if (existsSync(absPath)) {
              unlinkSync(absPath);
              deleted.push(absPath);
            }
          } else {
            // File existed before — restore original content
            writeFileSync(absPath, content, 'utf8');
            restored.push(absPath);
          }
        } catch {
          // Best effort — file might be locked or deleted by user
        }
      }

      return { restored, deleted, conflicts };
    },

    /** Number of turns available to undo. */
    get depth() { return stack.length; },

    /** Peek at what files would be affected by the next /undo. */
    peek() {
      if (stack.length === 0) return null;
      return [...stack[stack.length - 1].keys()];
    },
  };
}
