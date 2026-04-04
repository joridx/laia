// src/memory/daily-loader.js — Load daily memories from sleep cycle output
// Sprint 1 Feature A: Auto-inject recent daily memories into P5
//
// Reads ~/laia-data/memory/daily/YYYY-MM-DD.md files (produced by sleep-cycle.js)
// and returns a compact string for injection into unified-view.js (P5 Typed Memory).
// Sub-budget: 1KB within P5's 4KB total.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Constants ───────────────────────────────────────────────────────────────

const DAILY_DIR = join(homedir(), 'laia-data', 'memory', 'daily');
const DEFAULT_MAX_DAYS = 3;
const DAILY_BUDGET_BYTES = 1_024;  // 1KB sub-budget within P5

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the last N date strings in YYYY-MM-DD format, most recent first.
 * @param {number} n
 * @returns {string[]}
 */
function lastNDates(n) {
  const dates = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load daily memories for the last N days.
 * Returns a compact markdown string or null if nothing found.
 *
 * @param {number} [maxDays=3] - How many days back to look
 * @returns {string|null}
 */
export function loadDailyMemories(maxDays = DEFAULT_MAX_DAYS) {
  if (!existsSync(DAILY_DIR)) return null;

  const dates = lastNDates(maxDays);
  const parts = [];
  let totalBytes = 0;

  for (const date of dates) {
    const filePath = join(DAILY_DIR, `${date}.md`);
    if (!existsSync(filePath)) continue;

    try {
      let content = readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;

      // Strip markdown header if present (we add our own)
      content = content.replace(/^#\s+.+\n/, '').trim();

      const entryBytes = Buffer.byteLength(`### ${date}\n${content}\n`);

      // Budget check: stop adding if we'd exceed
      if (totalBytes + entryBytes > DAILY_BUDGET_BYTES) {
        // Try to fit a truncated version
        const remaining = DAILY_BUDGET_BYTES - totalBytes - Buffer.byteLength(`### ${date}\n...(truncated)\n`);
        if (remaining > 50) {
          const truncated = content.slice(0, remaining);
          parts.push(`### ${date}\n${truncated}...(truncated)`);
        }
        break;
      }

      parts.push(`### ${date}\n${content}`);
      totalBytes += entryBytes;
    } catch {
      // Graceful: skip unreadable files
      continue;
    }
  }

  if (parts.length === 0) return null;

  return parts.join('\n\n');
}

/**
 * Check if any daily memories exist.
 * @returns {boolean}
 */
export function hasDailyMemories() {
  if (!existsSync(DAILY_DIR)) return false;
  try {
    return readdirSync(DAILY_DIR).some(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  } catch {
    return false;
  }
}
