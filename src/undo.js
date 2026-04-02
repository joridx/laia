// Undo stack — tracks file snapshots before write/edit so /undo can restore them.
// Each "turn" groups all file changes together. /undo reverts the most recent turn.
// V6: configurable depth, /undo N, /undo --list with diff stats

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'fs';
import { resolve, normalize, relative, isAbsolute } from 'path';
import { diffLines } from 'diff';

const DEFAULT_MAX_TURNS = 25;

export function createUndoStack({ workspaceRoot, maxTurns = DEFAULT_MAX_TURNS } = {}) {
  // Stack of turns, each turn = { map: Map<absPath, snapshot>, timestamp, turnIndex }
  // snapshot = { content: string|null, mtimeMs: number|null }
  // content=null means the file didn't exist before (was created)
  const stack = [];
  let currentTurn = null;
  let turnCounter = 0;

  /** Check path is inside workspace root (defense-in-depth) */
  function isInsideWorkspace(absPath) {
    if (!workspaceRoot) return true;
    const norm = normalize(resolve(absPath));
    const root = normalize(resolve(workspaceRoot));
    // Use relative() to avoid prefix attack (/home/user/laia-evil vs /home/user/laia)
    const rel = relative(root, norm);
    return !rel.startsWith('..') && !isAbsolute(rel);
  }

  /** Compute diff stats between original content and current file content */
  function computeDiffStats(absPath, originalContent) {
    try {
      let currentContent = null;
      if (existsSync(absPath)) {
        currentContent = readFileSync(absPath, 'utf8');
      }

      // Both null/both same = no change
      if (originalContent === currentContent) return { additions: 0, deletions: 0 };

      // File was created (original was null)
      if (originalContent === null && currentContent !== null) {
        const lines = currentContent.split('\n').length;
        return { additions: lines, deletions: 0 };
      }

      // File was deleted (current is null)
      if (originalContent !== null && currentContent === null) {
        const lines = originalContent.split('\n').length;
        return { additions: 0, deletions: lines };
      }

      // Both exist — diff
      const changes = diffLines(originalContent, currentContent);
      let additions = 0;
      let deletions = 0;
      for (const part of changes) {
        const lineCount = part.count || part.value.split('\n').length;
        if (part.added) additions += lineCount;
        if (part.removed) deletions += lineCount;
      }
      return { additions, deletions };
    } catch {
      return { additions: 0, deletions: 0 };
    }
  }

  return {
    /** Start tracking a new turn. Call before the agent loop processes tools. */
    startTurn() {
      currentTurn = { map: new Map(), timestamp: Date.now(), turnIndex: ++turnCounter };
    },

    /** 
     * Snapshot a file BEFORE it's modified. Call from write/edit tools.
     * Only captures the first snapshot per file per turn (original state).
     */
    trackFile(absPath) {
      if (!currentTurn) return;
      if (currentTurn.map.has(absPath)) return; // already captured this turn
      if (!isInsideWorkspace(absPath)) return; // refuse out-of-workspace files
      let content = null;
      let mtimeMs = null;
      try {
        const st = statSync(absPath);
        // Skip files > 512KB to avoid memory bloat
        if (st.size > 512 * 1024) return;
        content = readFileSync(absPath, 'utf8');
        mtimeMs = st.mtimeMs;
      } catch (err) {
        // Only treat ENOENT as "new file"; other errors (EACCES etc.) → skip
        if (err?.code !== 'ENOENT') return;
      }
      currentTurn.map.set(absPath, { content, mtimeMs });
    },

    /** Finish the current turn and push to stack (only if files were tracked). */
    commitTurn() {
      if (!currentTurn || currentTurn.map.size === 0) {
        currentTurn = null;
        return;
      }
      stack.push(currentTurn);
      if (stack.length > maxTurns) stack.shift();
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
      return restoreTurn(turn);
    },

    /**
     * Undo back to a specific turn index (inclusive).
     * Restores all turns from the top of the stack down to (and including) the target.
     * @param {number} targetIndex - Turn index to rewind to (1-based from list)
     * @returns {{ restored: string[], deleted: string[], conflicts: string[], turnsUndone: number } | null}
     */
    undoTo(targetIndex) {
      if (!Number.isInteger(targetIndex) || targetIndex < 1 || targetIndex > stack.length) return null;
      const actualIdx = stack.length - targetIndex; // convert from display order
      let allRestored = [];
      let allDeleted = [];
      let allConflicts = [];
      let turnsUndone = 0;

      // Pop from top down to actualIdx (inclusive)
      while (stack.length > actualIdx) {
        const turn = stack.pop();
        const result = restoreTurn(turn);
        allRestored = allRestored.concat(result.restored);
        allDeleted = allDeleted.concat(result.deleted);
        allConflicts = allConflicts.concat(result.conflicts);
        turnsUndone++;
      }

      return {
        restored: [...new Set(allRestored)],
        deleted: [...new Set(allDeleted)],
        conflicts: [...new Set(allConflicts)],
        turnsUndone,
      };
    },

    /** Number of turns available to undo. */
    get depth() { return stack.length; },

    /** Peek at what files would be affected by the next /undo. */
    peek() {
      if (stack.length === 0) return null;
      return [...stack[stack.length - 1].map.keys()];
    },

    /**
     * List all turns with diff stats.
     * Returns array of { index, turnIndex, timestamp, files: [{ path, additions, deletions }] }
     * Ordered from most recent (index=1) to oldest.
     */
    list() {
      const result = [];
      for (let i = stack.length - 1; i >= 0; i--) {
        const turn = stack[i];
        const displayIndex = stack.length - i;
        const files = [];
        for (const [absPath, snapshot] of turn.map) {
          const relPath = workspaceRoot
            ? relative(workspaceRoot, absPath).split('\\').join('/')
            : absPath;
          const stats = computeDiffStats(absPath, snapshot.content);
          files.push({ path: relPath, ...stats });
        }
        result.push({
          index: displayIndex,
          turnIndex: turn.turnIndex,
          timestamp: turn.timestamp,
          files,
        });
      }
      return result;
    },

    /** Get the max turns config */
    get maxTurns() { return maxTurns; },
  };

  /** Internal: restore a single turn */
  function restoreTurn(turn) {
    const restored = [];
    const deleted = [];
    const conflicts = [];

    for (const [absPath, { content, mtimeMs }] of turn.map) {
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
  }
}
