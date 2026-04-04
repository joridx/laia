// src/services/sleep-cycle.js — Nightly memory consolidation
// Sprint 1: Extracts compact daily memories from session notes
//
// Run manually: node -e "import('./src/services/sleep-cycle.js').then(m => m.runSleepCycle())"
// Or via cron:  0 3 * * * cd ~/laia && node -e "import('./src/services/sleep-cycle.js').then(m => m.runSleepCycle())"
//
// What it does:
// 1. Reads today's session notes from ~/laia-data/memory/sessions/
// 2. Synthesizes a compact daily memory (bullets, <1KB)
// 3. Writes to ~/laia-data/memory/daily/YYYY-MM-DD.md
// 4. Prunes daily memories older than MAX_DAILY_DAYS
//
// No LLM needed — uses extraction heuristics from session notes.
// Future: LLM-powered synthesis for richer consolidation.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stderr } from 'process';

// ─── Constants ───────────────────────────────────────────────────────────────

const BRAIN_DATA = join(homedir(), 'laia-data');
const SESSIONS_DIR = join(BRAIN_DATA, 'memory', 'sessions');
const DAILY_DIR = join(BRAIN_DATA, 'memory', 'daily');
const MAX_DAILY_DAYS = 30;        // Keep 30 days of daily memories
const MAX_DAILY_SIZE = 1_024;     // 1KB budget per daily file
const SESSION_SECTIONS = [
  'Primary Request & Intent',
  'Key Technical Concepts',
  'Errors & Fixes',
  'Problem Solving',
  'Pending Tasks',
];

// ─── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract key sections from a session notes file.
 * Session notes follow a 9-section markdown template.
 * @param {string} content - Raw markdown content
 * @returns {string[]} - Array of extracted bullet points
 */
function extractFromSessionNotes(content) {
  const bullets = [];

  for (const section of SESSION_SECTIONS) {
    const re = new RegExp(`## \\d+\\.\\s*${section}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
    const match = content.match(re);
    if (!match) continue;

    const body = match[1].trim();
    // Skip template placeholders
    if (body.startsWith('_') && body.endsWith('_')) continue;
    if (body.length < 5) continue;

    // Extract non-empty lines, skip markdown formatting noise
    const lines = body.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('_') && l.length > 3);

    for (const line of lines.slice(0, 3)) { // Max 3 lines per section
      // Clean up markdown list markers
      const clean = line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
      if (clean.length > 5) {
        bullets.push(`- ${clean.slice(0, 150)}`);
      }
    }
  }

  return bullets;
}

/**
 * Find session files for a specific date.
 * Session files are named: {sessionId}.md where sessionId often starts with date.
 * @param {string} date - YYYY-MM-DD
 * @returns {string[]} - Paths to matching session files
 */
function findSessionsForDate(date) {
  if (!existsSync(SESSIONS_DIR)) return [];

  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.md'));

    // Match files that contain the date in name or modification date
    const matching = [];
    for (const f of files) {
      const path = join(SESSIONS_DIR, f);
      // Check if filename starts with the date
      if (f.startsWith(date)) {
        matching.push(path);
        continue;
      }
      // Fallback: check file modification date
      try {
        const fstat = statSync(path);
        const fileDate = new Date(fstat.mtimeMs).toISOString().slice(0, 10);
        if (fileDate === date) matching.push(path);
      } catch {}
    }

    return matching;
  } catch {
    return [];
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run sleep cycle for a specific date (default: today).
 * Idempotent: overwrites existing daily file if run multiple times.
 *
 * @param {object} [opts]
 * @param {string} [opts.date] - YYYY-MM-DD (default: today)
 * @param {boolean} [opts.force] - Overwrite even if daily file exists
 * @returns {{ date: string, bullets: number, bytes: number, sessions: number } | null}
 */
export function runSleepCycle({ date, force = false } = {}) {
  const targetDate = date || new Date().toISOString().slice(0, 10);

  mkdirSync(DAILY_DIR, { recursive: true });

  const dailyPath = join(DAILY_DIR, `${targetDate}.md`);

  // Skip if already exists (unless force)
  if (existsSync(dailyPath) && !force) {
    stderr.write(`\x1b[2m[sleep-cycle] Daily memory for ${targetDate} already exists\x1b[0m\n`);
    return null;
  }

  // Find and process session files
  const sessionPaths = findSessionsForDate(targetDate);
  if (sessionPaths.length === 0) {
    stderr.write(`\x1b[2m[sleep-cycle] No sessions found for ${targetDate}\x1b[0m\n`);
    return null;
  }

  const allBullets = [];
  for (const path of sessionPaths) {
    try {
      const content = readFileSync(path, 'utf-8');
      const bullets = extractFromSessionNotes(content);
      allBullets.push(...bullets);
    } catch {
      continue;
    }
  }

  if (allBullets.length === 0) {
    stderr.write(`\x1b[2m[sleep-cycle] Sessions found but no extractable content for ${targetDate}\x1b[0m\n`);
    return null;
  }

  // Deduplicate (normalize full line for comparison)
  const seen = new Set();
  const unique = allBullets.filter(b => {
    const key = b.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Build daily memory with budget
  let content = `# ${targetDate}\n\n`;
  let bytes = Buffer.byteLength(content);

  for (const bullet of unique) {
    const entryBytes = Buffer.byteLength(bullet + '\n');
    if (bytes + entryBytes > MAX_DAILY_SIZE) break;
    content += bullet + '\n';
    bytes += entryBytes;
  }

  writeFileSync(dailyPath, content.trim() + '\n', 'utf-8');

  const stats = {
    date: targetDate,
    bullets: unique.length,
    bytes: Buffer.byteLength(content),
    sessions: sessionPaths.length,
  };

  stderr.write(`\x1b[2m[sleep-cycle] Generated daily memory for ${targetDate}: ${stats.bullets} bullets from ${stats.sessions} sessions (${stats.bytes}B)\x1b[0m\n`);

  return stats;
}

/**
 * Prune daily memories older than MAX_DAILY_DAYS.
 * @returns {number} Number of files pruned
 */
export function pruneDailyMemories() {
  if (!existsSync(DAILY_DIR)) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAILY_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let pruned = 0;
  const VALID_DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;
  try {
    for (const f of readdirSync(DAILY_DIR)) {
      if (!VALID_DAILY_FILE.test(f)) continue;
      const dateStr = f.replace('.md', '');
      if (dateStr < cutoffStr) {
        unlinkSync(join(DAILY_DIR, f));
        pruned++;
      }
    }
  } catch {}

  if (pruned > 0) {
    stderr.write(`\x1b[2m[sleep-cycle] Pruned ${pruned} daily memories older than ${MAX_DAILY_DAYS} days\x1b[0m\n`);
  }

  return pruned;
}

/**
 * Run full sleep cycle: consolidate today + prune old.
 * @param {object} [opts]
 * @returns {{ consolidation: object|null, pruned: number }}
 */
export async function runFullSleepCycle(opts = {}) {
  const consolidation = runSleepCycle(opts);
  const pruned = pruneDailyMemories();
  return { consolidation, pruned };
}
