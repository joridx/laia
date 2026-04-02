// src/services/magic-docs.js — Magic Docs MVP for LAIA V5
// Files with <!-- MAGIC:auto-update --> header are auto-updated when related files change.
// Trigger: PostToolUse[write/edit] on files related to the magic doc.
// NEVER silently writes — shows diff preview and requires confirmation (via pending queue).

import { stderr } from 'process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { homedir } from 'os';
import { getFlag } from '../config/flags.js';

const DIM = '\x1b[2m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[0m';

const MAGIC_RE = /<!--\s*MAGIC:auto-update\s*-->/;
const SCOPE_RE = /<!--\s*MAGIC:scope\s+([\w./,*\s-]+)\s*-->/;

// Escape regex metacharacters (except *)
const escapeRegex = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// ─── State ──────────────────────────────────────────────────────────────────

let _pendingUpdates = [];  // Queue of pending magic doc updates

/**
 * Scan workspace for magic docs.
 * @param {string} workspaceRoot
 * @returns {Array<{path: string, scopes: string[]}>}
 */
export function scanMagicDocs(workspaceRoot) {
  if (!getFlag('magic_docs', false)) return [];

  const docs = [];
  const candidates = [
    'README.md', 'CHANGELOG.md', 'API.md', 'ARCHITECTURE.md',
    'docs/README.md', 'docs/API.md',
  ];

  for (const rel of candidates) {
    const absPath = join(workspaceRoot, rel);
    if (!existsSync(absPath)) continue;

    try {
      const content = readFileSync(absPath, 'utf8');
      if (!MAGIC_RE.test(content)) continue;

      // Extract scope (which files trigger update)
      const scopeMatch = content.match(SCOPE_RE);
      const scopes = scopeMatch
        ? scopeMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        : ['src/**'];  // Default: any source file change

      docs.push({ path: absPath, scopes });
    } catch {}
  }

  return docs;
}

/**
 * Check if a file change should trigger a magic doc update.
 * @param {string} changedFile - Absolute path of the changed file
 * @param {Array<{path: string, scopes: string[]}>} magicDocs
 * @param {string} workspaceRoot
 * @returns {Array<{path: string}>} Magic docs that need updating
 */
export function matchMagicDocs(changedFile, magicDocs, workspaceRoot) {
  if (!magicDocs || magicDocs.length === 0) return [];

  const relChanged = relative(workspaceRoot, changedFile);
  const matched = [];

  for (const doc of magicDocs) {
    const isMatch = doc.scopes.some(scope => {
      // Simple glob-like matching
      if (scope === '*' || scope === '**') return true;
      if (scope.endsWith('/**')) {
        const prefix = scope.slice(0, -3).replace(/\/$/, '');
        return relChanged === prefix || relChanged.startsWith(prefix + '/');
      }
      if (scope.endsWith('/*')) {
        const prefix = scope.slice(0, -2).replace(/\/$/, '');
        const dir = dirname(relChanged);
        return dir === prefix; // Strict 1-level: only direct children
      }
      if (scope.includes('*')) {
        // Convert simple glob to regex (escaped to prevent ReDoS)
        try {
          const re = new RegExp('^' + escapeRegex(scope).replace(/\*/g, '.*') + '$');
          return re.test(relChanged);
        } catch {
          return false; // Malformed scope, skip
        }
      }
      return relChanged === scope || relChanged.startsWith(scope + '/');
    });

    if (isMatch) matched.push(doc);
  }

  return matched;
}

/**
 * Build a regeneration prompt for a magic doc.
 * @param {string} docPath - Path to the magic doc
 * @param {string} docContent - Current content
 * @param {string} changedFile - File that triggered the update
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function buildRegenerationPrompt(docPath, docContent, changedFile, workspaceRoot) {
  const docName = basename(docPath);
  const relChanged = relative(workspaceRoot, changedFile);

  return `You are updating a documentation file that has a MAGIC:auto-update header.

DOCUMENT: ${docName}
TRIGGER: ${relChanged} was modified

CURRENT CONTENT:
\`\`\`markdown
${docContent.slice(0, 5000)}
\`\`\`

TASK: Regenerate this document to reflect the changes. Keep the same structure and style. Preserve the <!-- MAGIC:auto-update --> and <!-- MAGIC:scope ... --> comments.

Return ONLY the updated markdown content (no explanation, no code fences).`;
}

/**
 * Queue a magic doc update (for user confirmation later).
 * @param {object} update
 * @param {string} update.docPath
 * @param {string} update.newContent
 * @param {string} update.trigger - File that triggered it
 * @param {string} update.reason
 */
export function queueUpdate(update) {
  // Dedupe by docPath
  _pendingUpdates = _pendingUpdates.filter(u => u.docPath !== update.docPath);
  _pendingUpdates.push({
    ...update,
    queuedAt: Date.now(),
  });
}

/**
 * Get pending magic doc updates.
 * @returns {Array}
 */
export function getPendingUpdates() {
  return [..._pendingUpdates];
}

/**
 * Apply a pending update by index.
 * @param {number} index
 * @returns {{ applied: boolean, error?: string }}
 */
export function applyUpdate(index) {
  if (index < 0 || index >= _pendingUpdates.length) {
    return { applied: false, error: 'Invalid update index' };
  }

  const update = _pendingUpdates[index];
  try {
    // Security: ensure docPath is within workspace or home
    const home = homedir();
    if (!update.docPath.startsWith(home) && !update.docPath.startsWith(process.cwd())) {
      return { applied: false, error: 'Doc path outside allowed directories' };
    }
    writeFileSync(update.docPath, update.newContent);
    _pendingUpdates.splice(index, 1);
    stderr.write(`${G}✅ Updated ${basename(update.docPath)}${R}\n`);
    return { applied: true };
  } catch (err) {
    return { applied: false, error: err.message };
  }
}

/**
 * Dismiss a pending update.
 * @param {number} index
 */
export function dismissUpdate(index) {
  if (index >= 0 && index < _pendingUpdates.length) {
    _pendingUpdates.splice(index, 1);
  }
}

/**
 * Dismiss all pending updates.
 */
export function dismissAllUpdates() {
  _pendingUpdates = [];
}

/**
 * Get stats for doctor.
 */
export function getMagicDocStats() {
  return {
    pendingUpdates: _pendingUpdates.length,
  };
}

/** @internal For tests */
export function _reset() {
  _pendingUpdates = [];
}
