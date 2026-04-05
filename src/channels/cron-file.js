// src/channels/cron-file.js — CRON.md parser for LAIA
// Sprint 2: Reads scheduled tasks from a Markdown file with TOML blocks
//
// Format:
//   # Scheduled Jobs
//   ## Job Name
//   ```toml
//   name = "job-name"
//   cron = "0 7 * * 1-5"
//   prompt = "Do something"         # OR command = "bash command"
//   enabled = true                  # optional, default true
//   silent_unless_action = false    # optional
//   ```
//
// Source: Nextcloud WebDAV (nc:///LAIA/CRON.md) or local file
// Execution: Daemon scheduler evaluates cron expressions and dispatches

import { readFileSync, existsSync } from 'fs';
import { stderr } from 'process';

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['name', 'cron'];
const VALID_FIELDS = ['name', 'cron', 'prompt', 'command', 'enabled', 'silent_unless_action', 'user', 'timeout'];

// ─── TOML-lite parser ────────────────────────────────────────────────────────

/**
 * Parse a minimal TOML block (key = "value" | key = true | key = 123).
 * Does NOT support tables, arrays, multiline strings — intentionally simple.
 * @param {string} toml
 * @returns {Record<string, string|boolean|number>}
 */
export function parseTomlLite(toml) {
  const result = {};
  for (const line of toml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    // String: "..." or '...' — extract content, ignore inline comments after closing quote
    if (value.startsWith('"')) {
      const endQuote = value.indexOf('"', 1);
      if (endQuote > 0) value = value.slice(1, endQuote);
      else value = value.slice(1); // unclosed quote
    } else if (value.startsWith("'")) {
      const endQuote = value.indexOf("'", 1);
      if (endQuote > 0) value = value.slice(1, endQuote);
      else value = value.slice(1);
    }
    // Boolean
    else if (value === 'true' || value.startsWith('true ') || value.startsWith('true#')) value = true;
    else if (value === 'false' || value.startsWith('false ') || value.startsWith('false#')) value = false;
    // Number (strip inline comment)
    else {
      const numMatch = value.match(/^(\d+)/);
      if (numMatch) value = parseInt(numMatch[1], 10);
    }

    result[key] = value;
  }
  return result;
}

// ─── Cron Expression Validator ───────────────────────────────────────────────

/**
 * Basic cron expression validator (5-field: min hour dom month dow).
 * Does NOT evaluate next run — just validates format.
 * @param {string} expr
 * @returns {boolean}
 */
export function isValidCron(expr) {
  if (!expr || typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges = [
    [0, 59],   // minute
    [0, 23],   // hour
    [1, 31],   // day of month
    [1, 12],   // month
    [0, 7],    // day of week (0 and 7 = Sunday)
  ];

  for (let i = 0; i < 5; i++) {
    if (!isValidCronField(parts[i], ranges[i][0], ranges[i][1])) return false;
  }
  return true;
}

function isValidCronField(field, min, max) {
  if (field === '*') return true;

  // Handle */N (step on full range)
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && step >= 1 && step <= max;
  }

  // Handle comma-separated values
  for (const part of field.split(',')) {
    // Handle range with optional step: N-M or N-M/S
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const [, aStr, bStr, sStr] = rangeMatch;
      const a = parseInt(aStr, 10);
      const b = parseInt(bStr, 10);
      if (isNaN(a) || isNaN(b) || a < min || b > max || a > b) return false;
      if (sStr !== undefined) {
        const s = parseInt(sStr, 10);
        if (isNaN(s) || s < 1) return false;
      }
      continue;
    }
    // Single number
    const n = parseInt(part, 10);
    if (isNaN(n) || n < min || n > max) return false;
  }
  return true;
}

// ─── CRON.md Parser ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} CronJob
 * @property {string} name
 * @property {string} cron
 * @property {string} [prompt] — LLM prompt to execute
 * @property {string} [command] — Bash command to execute
 * @property {boolean} [enabled]
 * @property {boolean} [silent_unless_action]
 * @property {string} [user]
 * @property {number} [timeout]
 */

/**
 * Parse a CRON.md file content into an array of cron jobs.
 * @param {string} content — Markdown file content
 * @returns {{ jobs: CronJob[], errors: string[] }}
 */
export function parseCronFile(content) {
  if (!content || typeof content !== 'string') {
    return { jobs: [], errors: ['Empty or invalid content'] };
  }

  const jobs = [];
  const errors = [];

  // Extract ```toml ... ``` blocks
  const blockRegex = /```toml\s*\n([\s\S]*?)```/g;
  let match;
  let blockIndex = 0;

  while ((match = blockRegex.exec(content)) !== null) {
    blockIndex++;
    const toml = match[1];

    try {
      const parsed = parseTomlLite(toml);

      // Validate required fields
      for (const field of REQUIRED_FIELDS) {
        if (!parsed[field]) {
          errors.push(`Block ${blockIndex}: missing required field '${field}'`);
        }
      }

      if (!parsed.name || !parsed.cron) continue;

      // Validate cron expression
      if (!isValidCron(parsed.cron)) {
        errors.push(`Block ${blockIndex} (${parsed.name}): invalid cron expression '${parsed.cron}'`);
        continue;
      }

      // Validate mutually exclusive: prompt vs command
      if (parsed.prompt && parsed.command) {
        errors.push(`Block ${blockIndex} (${parsed.name}): 'prompt' and 'command' are mutually exclusive`);
        continue;
      }
      if (!parsed.prompt && !parsed.command) {
        errors.push(`Block ${blockIndex} (${parsed.name}): must have 'prompt' or 'command'`);
        continue;
      }

      // Defaults
      if (parsed.enabled === undefined) parsed.enabled = true;
      if (parsed.silent_unless_action === undefined) parsed.silent_unless_action = false;

      jobs.push(parsed);
    } catch (err) {
      errors.push(`Block ${blockIndex}: parse error: ${err.message}`);
    }
  }

  return { jobs, errors };
}

/**
 * Load and parse a CRON.md file from a path.
 * @param {string} filePath
 * @returns {{ jobs: CronJob[], errors: string[] }}
 */
export function loadCronFile(filePath) {
  if (!existsSync(filePath)) {
    return { jobs: [], errors: [] }; // No file = no jobs (not an error)
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    return parseCronFile(content);
  } catch (err) {
    return { jobs: [], errors: [`Failed to read ${filePath}: ${err.message}`] };
  }
}

// ─── TASKS.md Parser ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} TaskItem
 * @property {string} text — Task description
 * @property {boolean} done — Checkbox state
 * @property {string} [priority] — ! = high, !! = urgent
 * @property {number} line — Line number in source file
 */

/**
 * Parse a TASKS.md file (simple checkbox Markdown).
 *
 * Format:
 *   - [ ] Task to do
 *   - [x] Task completed
 *   - [ ] !! Urgent task
 *   - [ ] ! High priority task
 *
 * @param {string} content
 * @returns {{ tasks: TaskItem[], errors: string[] }}
 */
export function parseTasksFile(content) {
  if (!content || typeof content !== 'string') {
    return { tasks: [], errors: [] };
  }

  const tasks = [];
  const errors = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match: - [ ] text  OR  - [x] text  OR  * [ ] text
    const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!match) continue;

    const done = match[1].toLowerCase() === 'x';
    let text = match[2].trim();
    let priority = 'normal';

    // Extract priority markers
    if (text.startsWith('!! ')) {
      priority = 'urgent';
      text = text.slice(3).trim();
    } else if (text.startsWith('! ')) {
      priority = 'high';
      text = text.slice(2).trim();
    }

    if (!text) continue;

    tasks.push({ text, done, priority, line: i + 1 });
  }

  return { tasks, errors };
}

/**
 * Load and parse TASKS.md from a path.
 * @param {string} filePath
 * @returns {{ tasks: TaskItem[], errors: string[] }}
 */
export function loadTasksFile(filePath) {
  if (!existsSync(filePath)) {
    return { tasks: [], errors: [] };
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    return parseTasksFile(content);
  } catch (err) {
    return { tasks: [], errors: [`Failed to read ${filePath}: ${err.message}`] };
  }
}

/**
 * Get pending (not done) tasks, sorted by priority.
 * @param {TaskItem[]} tasks
 * @returns {TaskItem[]}
 */
export function getPendingTasks(tasks) {
  const priorityOrder = { urgent: 0, high: 1, normal: 2 };
  return tasks
    .filter(t => !t.done)
    .sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));
}

/**
 * Format pending tasks as a compact string for prompt injection.
 * @param {TaskItem[]} tasks
 * @param {number} [maxBytes=500]
 * @returns {string}
 */
export function formatTasksForPrompt(tasks, maxBytes = 500) {
  const pending = getPendingTasks(tasks);
  if (pending.length === 0) return '';

  const lines = pending.map(t => {
    const prefix = t.priority === 'urgent' ? '🔴' : t.priority === 'high' ? '🟡' : '·';
    return `${prefix} ${t.text}`;
  });

  let result = lines.join('\n');
  if (Buffer.byteLength(result) > maxBytes) {
    // Truncate by lines
    while (Buffer.byteLength(result) > maxBytes - 20 && lines.length > 1) {
      lines.pop();
      result = lines.join('\n') + `\n...(+${pending.length - lines.length} more)`;
    }
  }

  return result;
}
