// src/memory/bridge.js — One-way bridge between typed memory and brain
// Part of V4 Track 1: Memory Unification
//
// Bridge rules (one-way only, never bidirectional):
//   feedback/ confirmed → promote to brain learning (archive, don't delete)
//   Runs at session-end as a reconciliation pass
//
// Transactional promotion:
//   1. Mark feedback as promotion_pending
//   2. Write to brain via brain_remember API
//   3. On ack: mark as promoted + brain_ref
//   4. Archive (rename to .promoted.md)

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { canonicalKey } from './ownership.js';

const MEMORY_DIR = join(homedir(), 'laia-data', 'memory', 'typed');
const FEEDBACK_DIR = join(MEMORY_DIR, 'feedback');
const ARCHIVE_DIR = join(MEMORY_DIR, 'feedback', '.archived');

// ─── Promotion Score ─────────────────────────────────────────────────────────

const PROMOTION_THRESHOLD = 1.0;

/**
 * Calculate promotion score for a feedback memory.
 * Score components:
 *   - explicit_confirm: +0.5 per confirmation
 *   - repeated_success: +0.3 if applied >1 time without correction
 *   - age_bonus: +0.2 if older than 3 days (survived without contradiction)
 *
 * @param {object} frontmatter - Parsed frontmatter fields
 * @returns {number} Promotion score
 */
function promotionScore(frontmatter) {
  let score = 0;

  const confirms = parseInt(frontmatter.confirmations || '0', 10);
  if (isNaN(confirms)) return 0;
  score += confirms * 0.5;

  const applied = parseInt(frontmatter.times_applied || '0', 10);
  if (!isNaN(applied) && applied > 1) score += 0.3;

  if (frontmatter.created) {
    const ageDays = (Date.now() - new Date(frontmatter.created).getTime()) / (1000 * 60 * 60 * 24);
    if (!isNaN(ageDays) && ageDays > 3) score += 0.2;
  }

  return score;
}

// ─── Frontmatter helpers ─────────────────────────────────────────────────────

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw.trim() };

  const fm = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }

  return { frontmatter: fm, content: match[2].trim() };
}

function updateFrontmatter(raw, updates) {
  const { frontmatter, content } = parseFrontmatter(raw);
  Object.assign(frontmatter, updates);

  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined && v !== null) lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n\n${content}\n`;
}

// ─── Promotion Pipeline ──────────────────────────────────────────────────────

/**
 * Scan feedback memories and promote those that meet the threshold.
 * Uses a transactional approach to avoid data loss.
 *
 * @param {object} opts
 * @param {function} opts.brainRemember - async function to save to brain (brain_remember API)
 * @param {object} [opts.stderr] - output stream for logging
 * @returns {Promise<{ promoted: string[], skipped: string[], errors: string[] }>}
 */
export async function promoteFeedback({ brainRemember, stderr } = {}) {
  const result = { promoted: [], skipped: [], errors: [] };

  if (!existsSync(FEEDBACK_DIR)) return result;
  if (!brainRemember) {
    result.errors.push('No brainRemember function provided');
    return result;
  }

  // Ensure archive dir
  if (!existsSync(ARCHIVE_DIR)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const files = readdirSync(FEEDBACK_DIR).filter(f => f.endsWith('.md') && !f.startsWith('.'));

  for (const file of files) {
    const filePath = join(FEEDBACK_DIR, file);

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { frontmatter, content } = parseFrontmatter(raw);

      // Skip already promoted; retry pending if older than 5 minutes
      if (frontmatter.promotion_state === 'promoted') {
        result.skipped.push(file);
        continue;
      }
      if (frontmatter.promotion_state === 'pending') {
        // Recovery: if pending for >5 min, reset and retry
        const pendingAt = frontmatter.pending_at ? new Date(frontmatter.pending_at) : null;
        const pendingMinutes = pendingAt ? (Date.now() - pendingAt.getTime()) / 60_000 : Infinity;
        if (pendingMinutes < 5) {
          result.skipped.push(file);
          continue;
        }
        // Stale pending — reset and retry
        const resetRaw = updateFrontmatter(raw, { promotion_state: undefined, pending_at: undefined });
        writeFileSync(filePath, resetRaw, 'utf-8');
      }

      // Check score
      const score = promotionScore(frontmatter);
      if (score < PROMOTION_THRESHOLD) {
        result.skipped.push(file);
        continue;
      }

      // Step 1: Mark as pending with timestamp
      const pendingRaw = updateFrontmatter(raw, { promotion_state: 'pending', pending_at: new Date().toISOString() });
      writeFileSync(filePath, pendingRaw, 'utf-8');

      // Step 2: Write to brain
      const title = frontmatter.name || basename(file, '.md');
      const ckey = canonicalKey(title, 'feedback');

      let brainId;
      try {
        const brainResult = await brainRemember({
          type: 'learning',
          title: `[promoted] ${title}`,
          description: content,
          tags: ['promoted-feedback', `canonical:${ckey}`],
        });
        brainId = brainResult?.id || (brainResult?.stored ? ckey : null);
      } catch (err) {
        // Rollback: remove pending state
        const rollbackRaw = updateFrontmatter(raw, { promotion_state: undefined, pending_at: undefined });
        writeFileSync(filePath, rollbackRaw, 'utf-8');
        result.errors.push(`${file}: brain write failed — ${err.message}`);
        continue;
      }

      // Step 3: Mark as promoted + archive
      const promotedRaw = updateFrontmatter(pendingRaw, {
        promotion_state: 'promoted',
        brain_ref: brainId || ckey,
        promoted_at: new Date().toISOString(),
      });
      writeFileSync(filePath, promotedRaw, 'utf-8');

      // Step 4: Move to archive
      const archivePath = join(ARCHIVE_DIR, file);
      try {
        renameSync(filePath, archivePath);
      } catch {
        // Not critical — file is already marked as promoted
      }

      result.promoted.push(file);

      if (stderr) {
        stderr.write(`\x1b[32m  ✅ Promoted feedback → brain: ${title}\x1b[0m\n`);
      }
    } catch (err) {
      result.errors.push(`${file}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Session-end reconciliation pass.
 * Runs promoteFeedback and logs results.
 *
 * @param {object} opts
 * @param {function} opts.brainRemember
 * @param {object} [opts.stderr]
 */
export async function syncOnSessionEnd({ brainRemember, stderr } = {}) {
  try {
    const result = await promoteFeedback({ brainRemember, stderr });

    if (stderr && (result.promoted.length > 0 || result.errors.length > 0)) {
      const DIM = '\x1b[2m';
      const R = '\x1b[0m';
      if (result.promoted.length > 0) {
        stderr.write(`${DIM}[memory-bridge] Promoted ${result.promoted.length} feedback → brain${R}\n`);
      }
      if (result.errors.length > 0) {
        stderr.write(`${DIM}[memory-bridge] ${result.errors.length} errors during sync${R}\n`);
      }
    }

    return result;
  } catch (err) {
    if (stderr) {
      stderr.write(`\x1b[2m[memory-bridge] Sync failed: ${err.message}\x1b[0m\n`);
    }
    return { promoted: [], skipped: [], errors: [err.message] };
  }
}
