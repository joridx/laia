// src/phase2/session-memory.js — Session notes with 9-section template
// Inspired by Claude Code's src/services/SessionMemory/
// Maintains a running summary of the session, updated periodically.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stderr } from 'process';

const SESSIONS_DIR = join(homedir(), 'laia-data', 'memory', 'sessions');

// ─── Session Notes Template ──────────────────────────────────────────────────

const SESSION_NOTES_TEMPLATE = `# Session Notes

## 1. Primary Request & Intent
_What the user wants to achieve._

## 2. Key Technical Concepts
_Technologies, frameworks, patterns discussed._

## 3. Files & Code
_Files examined, modified, or created._

## 4. Errors & Fixes
_Errors encountered and how they were resolved._

## 5. Problem Solving
_Problems solved and troubleshooting steps._

## 6. User Messages Summary
_Key user messages (not tool results)._

## 7. Pending Tasks
_Tasks explicitly requested but not yet completed._

## 8. Current Work
_What is being worked on right now._

## 9. Next Step
_The immediate next action._
`;

// ─── Session Notes Manager ───────────────────────────────────────────────────

/**
 * Create a session notes manager.
 * @param {string} sessionId - Unique session identifier
 * @returns {object} Session notes controller
 */
export function createSessionNotes(sessionId) {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

  // CRITICAL FIX: sanitize sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100);
  if (!safeId) throw new Error('Invalid session ID');

  const filePath = join(SESSIONS_DIR, `${safeId}.md`);
  let notes = SESSION_NOTES_TEMPLATE;
  let lastUpdateTurn = 0;
  const UPDATE_INTERVAL = 5; // Update every N turns

  // Load existing if resuming
  if (existsSync(filePath)) {
    try {
      notes = readFileSync(filePath, 'utf-8');
    } catch { /* use template */ }
  }

  function save() {
    try {
      writeFileSync(filePath, notes, 'utf-8');
    } catch (err) {
      stderr.write(`\x1b[33m[session-notes] Save failed: ${err.message}\x1b[0m\n`);
    }
  }

  return {
    /**
     * Get the current notes content.
     */
    getNotes() {
      return notes;
    },

    /**
     * Get the file path.
     */
    getPath() {
      return filePath;
    },

    /**
     * Update notes with LLM-generated content.
     * @param {string} updatedNotes - New notes content
     */
    update(updatedNotes) {
      if (updatedNotes && updatedNotes.length > 50) {
        notes = updatedNotes;
        save();
      }
    },

    /**
     * Check if notes should be updated (every N turns).
     * @param {number} currentTurn
     */
    shouldUpdate(currentTurn) {
      return currentTurn > 0 && (currentTurn - lastUpdateTurn) >= UPDATE_INTERVAL;
    },

    /**
     * Mark as updated at a given turn.
     */
    markUpdated(turnNumber) {
      lastUpdateTurn = turnNumber;
    },

    /**
     * Build the prompt for updating session notes.
     * @param {string} recentContext - Recent conversation context
     */
    buildUpdatePrompt(recentContext) {
      return `Update the session notes below based on the recent conversation.
Keep the 9-section structure. Replace placeholder text with actual content.
Be specific: include file names, code snippets, exact error messages.
Keep each section concise but thorough.

## Current Notes
${notes}

## Recent Conversation
${recentContext}

Respond with ONLY the updated notes (starting with "# Session Notes"). Keep all 9 sections.`;
    },

    /**
     * Get notes summary for injection into compaction.
     * Returns a condensed version suitable for system prompt.
     */
    getSummaryForPrompt() {
      // Only inject if notes have real content (not just template)
      if (notes === SESSION_NOTES_TEMPLATE) return null;
      if (notes.includes('_What the user wants to achieve._')) return null;

      // Truncate to ~4KB for prompt injection
      const truncated = notes.slice(0, 4000);
      return truncated.length < notes.length
        ? truncated + '\n...(session notes truncated)'
        : truncated;
    },

    /**
     * Save final notes (called on /exit).
     */
    finalize() {
      save();
    },
  };
}

// ─── Session Notes Prompt for Compaction Integration ─────────────────────────

/**
 * Build session notes section for the compaction prompt.
 * Includes existing notes so the compaction LLM preserves them.
 */
export function buildSessionNotesCompactSection(sessionNotes) {
  if (!sessionNotes) return '';
  const summary = sessionNotes.getSummaryForPrompt();
  if (!summary) return '';

  return `\n\n## Previous Session Notes (preserve and update these)\n${summary}`;
}
