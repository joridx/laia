// src/services/briefing.js — Daily briefing generator
// Sprint 4 partial: generates a morning summary from multiple data sources
//
// Data sources:
//   1. Session notes from yesterday (~/laia-data/memory/sessions/)
//   2. New learnings created yesterday (~/laia-data/memory/learnings/)
//   3. Pending tasks (TASKS.md)
//   4. Cron jobs (CRON.md)
//   5. nc:// URI health (optional, slow)
//
// Output: formatted Markdown message for Talk or CLI display
// Usage:
//   /briefing                → generate + display in CLI
//   /briefing --send         → generate + send to Talk DM
//   /briefing --date 2026-04-05  → briefing for specific date

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BRAIN_DATA = join(homedir(), 'laia-data');
const SESSIONS_DIR = join(BRAIN_DATA, 'memory', 'sessions');
const LEARNINGS_DIR = join(BRAIN_DATA, 'memory', 'learnings');
const DAILY_DIR = join(BRAIN_DATA, 'memory', 'daily');

// ─── Data Collectors ─────────────────────────────────────────────────────────

/**
 * Collect session summaries for a given date.
 * @param {string} dateStr — YYYY-MM-DD
 * @returns {{ count: number, highlights: string[] }}
 */
export function collectSessions(dateStr) {
  const highlights = [];
  let count = 0;

  if (!existsSync(SESSIONS_DIR)) return { count: 0, highlights };

  const files = readdirSync(SESSIONS_DIR).filter(f => f.startsWith(dateStr) && f.endsWith('.md'));
  count = files.length;

  for (const file of files) {
    try {
      const content = readFileSync(join(SESSIONS_DIR, file), 'utf-8');

      // Extract summary section
      const summaryMatch = content.match(/## Summary\s*\n([\s\S]*?)(?=\n##|$)/);
      if (summaryMatch) {
        const summary = summaryMatch[1].trim();
        if (summary && !summary.startsWith('_')) {
          highlights.push(summary.split('\n')[0].slice(0, 120));
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Also check daily memory for that date
  const dailyFile = join(DAILY_DIR, `${dateStr}.md`);
  if (existsSync(dailyFile) && highlights.length === 0) {
    try {
      const content = readFileSync(dailyFile, 'utf-8');
      const bullets = content.split('\n').filter(l => l.startsWith('- ')).slice(0, 5);
      highlights.push(...bullets.map(b => b.slice(2).slice(0, 120)));
    } catch {
      // Skip
    }
  }

  return { count, highlights };
}

/**
 * Collect learnings created on a given date.
 * @param {string} dateStr — YYYY-MM-DD
 * @returns {{ count: number, titles: string[] }}
 */
export function collectNewLearnings(dateStr) {
  const titles = [];

  if (!existsSync(LEARNINGS_DIR)) return { count: 0, titles };

  const files = readdirSync(LEARNINGS_DIR).filter(f => f.endsWith('.md'));

  for (const file of files) {
    try {
      const content = readFileSync(join(LEARNINGS_DIR, file), 'utf-8');
      const createdMatch = content.match(/^created:\s*(\S+)/m);
      if (!createdMatch || !createdMatch[1].startsWith(dateStr)) continue;

      const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
      const title = titleMatch ? titleMatch[1] : file.replace(/\.md$/, '');
      titles.push(title.slice(0, 100));
    } catch {
      // Skip
    }
  }

  return { count: titles.length, titles };
}

/**
 * Collect pending tasks from TASKS.md.
 * @returns {{ pending: Array, total: number }}
 */
export function collectTasks() {
  const { loadTasksFile, getPendingTasks } = lazyLoadCronFile();
  if (!loadTasksFile) return { pending: [], total: 0 };

  const tasksPath = join(homedir(), '.laia', 'TASKS.md');
  if (!existsSync(tasksPath)) return { pending: [], total: 0 };

  try {
    const { tasks } = loadTasksFile(tasksPath);
    const pending = getPendingTasks(tasks);
    return { pending, total: tasks.length };
  } catch {
    return { pending: [], total: 0 };
  }
}

/**
 * Collect cron job summaries from CRON.md.
 * @returns {{ jobs: Array, count: number }}
 */
export function collectCronJobs() {
  const { loadCronFile } = lazyLoadCronFile();
  if (!loadCronFile) return { jobs: [], count: 0 };

  const cronPath = join(homedir(), '.laia', 'CRON.md');
  if (!existsSync(cronPath)) return { jobs: [], count: 0 };

  try {
    const { jobs } = loadCronFile(cronPath);
    return { jobs, count: jobs.length };
  } catch {
    return { jobs: [], count: 0 };
  }
}

// ─── Briefing Generator ──────────────────────────────────────────────────────

/**
 * Generate a full briefing for a given date.
 *
 * @param {Object} [opts]
 * @param {string} [opts.date] — YYYY-MM-DD (default: yesterday)
 * @param {boolean} [opts.includeUris=false] — Also verify nc:// URIs (slow)
 * @returns {Promise<Object>} Briefing data
 */
export async function generateBriefing({ date, includeUris = false } = {}) {
  const dateStr = date || getYesterday();

  // Ensure lazy modules are loaded
  await initBriefingModules();

  const sessions = collectSessions(dateStr);
  const learnings = collectNewLearnings(dateStr);
  const tasks = collectTasks();
  const cron = collectCronJobs();

  let uris = null;
  if (includeUris) {
    try {
      const { verifyNcUris } = await import('./sleep-advanced.js');
      uris = await verifyNcUris({ timeoutMs: 3000 });
    } catch {
      uris = { checked: 0, valid: 0, broken: [], errors: ['URI verification unavailable'] };
    }
  }

  return {
    date: dateStr,
    sessions,
    learnings,
    tasks,
    cron,
    uris,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format a briefing into a human-readable Markdown message.
 * Designed for Talk (≤4000 chars).
 *
 * @param {Object} briefing — From generateBriefing()
 * @returns {string}
 */
export function formatBriefing(briefing) {
  const MAX_MSG_LENGTH = 3800; // Leave room for Talk's 4000 limit
  const lines = [];
  const dayName = getDayName(briefing.date);

  lines.push(`☀️ **Bon dia!** Resum de ${dayName} (${briefing.date}):`);
  lines.push('');

  // Sessions
  const s = briefing.sessions;
  if (s.count > 0) {
    lines.push(`📊 **Sessions:** ${s.count}`);
    for (const h of s.highlights.slice(0, 5)) {
      lines.push(`  • ${h}`);
    }
  } else {
    lines.push('📊 **Sessions:** Cap sessió registrada');
  }
  lines.push('');

  // Learnings
  const l = briefing.learnings;
  if (l.count > 0) {
    lines.push(`🧠 **Brain:** +${l.count} learnings`);
    for (const t of l.titles.slice(0, 5)) {
      lines.push(`  • ${t}`);
    }
    if (l.count > 5) lines.push(`  _(+${l.count - 5} més)_`);
  } else {
    lines.push('🧠 **Brain:** Cap learning nou');
  }
  lines.push('');

  // Tasks
  const tk = briefing.tasks;
  if (tk.pending.length > 0) {
    lines.push(`📋 **Tasks pendents:** ${tk.pending.length}/${tk.total}`);
    for (const task of tk.pending.slice(0, 7)) {
      const icon = task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟡' : '·';
      lines.push(`  ${icon} ${task.text.slice(0, 100)}`);
    }
    if (tk.pending.length > 7) lines.push(`  _(+${tk.pending.length - 7} més)_`);
  }

  // Cron
  const cr = briefing.cron;
  if (cr.count > 0) {
    lines.push('');
    lines.push(`⏰ **Cron jobs:** ${cr.count}`);
    for (const job of cr.jobs.slice(0, 5)) {
      lines.push(`  • \`${job.cron || job.schedule}\` — ${job.name || job.prompt?.slice(0, 60) || job.command?.slice(0, 60) || '(unnamed)'}`);
    }
  }

  // URIs
  if (briefing.uris) {
    const u = briefing.uris;
    if (u.broken?.length > 0) {
      lines.push('');
      lines.push(`🔗 **nc:// URIs:** ${u.broken.length} trencats de ${u.checked}`);
      for (const b of u.broken.slice(0, 3)) {
        lines.push(`  ❌ ${b.uri}`);
      }
    }
  }

  let result = lines.join('\n');

  // Hard cap: truncate if too long for Talk
  if (result.length > MAX_MSG_LENGTH) {
    result = result.slice(0, MAX_MSG_LENGTH - 20) + '\n\n_(truncat)_';
  }

  return result;
}

/**
 * Generate and optionally send the briefing.
 *
 * @param {Object} [opts]
 * @param {string} [opts.date] — YYYY-MM-DD
 * @param {boolean} [opts.send=false] — Send to Talk DM
 * @param {string} [opts.talkToken] — Talk room token (auto-detects DM if not provided)
 * @param {boolean} [opts.includeUris=false] — Check nc:// URIs
 * @returns {Promise<{ briefing: Object, message: string, sent: boolean, error?: string }>}
 */
export async function briefingCommand({ date, send = false, talkToken, includeUris = false } = {}) {
  const briefing = await generateBriefing({ date, includeUris });
  const message = formatBriefing(briefing);

  let sent = false;
  let error;

  if (send) {
    try {
      const { sendMessage, createOneToOne } = await import('../channels/talk-client.js');

      let token = talkToken;
      if (!token) {
        const dmUser = process.env.NC_BRIEFING_USER || 'jorid';
        const dm = await createOneToOne(dmUser);
        if (!dm?.token) throw new Error(`Failed to create DM with ${dmUser}: no token returned`);
        token = dm.token;
      }

      await sendMessage(token, message);
      sent = true;
    } catch (err) {
      error = err.message;
    }
  }

  return { briefing, message, sent, error };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get yesterday's date as YYYY-MM-DD.
 */
function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  // Use local date (not UTC) to avoid midnight timezone shift
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Get human-friendly day name in Catalan.
 * @param {string} dateStr — YYYY-MM-DD
 * @returns {string}
 */
function getDayName(dateStr) {
  const days = ['diumenge', 'dilluns', 'dimarts', 'dimecres', 'dijous', 'divendres', 'dissabte'];
  const d = new Date(dateStr + 'T12:00:00');
  return days[d.getDay()] || dateStr;
}

/**
 * Lazy loader for cron-file module (avoids circular deps).
 */
function lazyLoadCronFile() {
  try {
    // Sync require workaround not available in ESM; we'll preload in the caller
    // Actually, since collectTasks/collectCronJobs are called from async context,
    // we cache the module on first call.
    if (!_cronFileCache) {
      return { loadTasksFile: null, getPendingTasks: null, loadCronFile: null };
    }
    return _cronFileCache;
  } catch {
    return { loadTasksFile: null, getPendingTasks: null, loadCronFile: null };
  }
}

let _cronFileCache = null;

/**
 * Initialize lazy modules (call once before using collectTasks/collectCronJobs).
 */
export async function initBriefingModules() {
  if (!_cronFileCache) {
    try {
      _cronFileCache = await import('../channels/cron-file.js');
    } catch {
      _cronFileCache = null;
    }
  }
}
