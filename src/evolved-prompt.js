/**
 * evolved-prompt.js — Compile evolved system prompt sections from brain learnings.
 * V4 Sprint 4: Auto-compiled prompt personalization.
 *
 * Architecture (from Codex review):
 * - Dual-layer: Stable (manually confirmed) + Adaptive (auto-compiled, 30-day expiry)
 * - Compiled from brain learnings, grouped by type
 * - Written to ~/.laia/evolved/*.md
 * - Read by system-prompt.js evolvedSection()
 *
 * Safety:
 * - Max 50 lines per section, max 200 lines total
 * - 4K token cap (≈16K chars) on total evolved context
 * - Adaptive entries expire after 30 days without revalidation
 * - Stable promotion requires 3+ revalidations (hit_count >= 3)
 * - Full audit trail in _evolution-log.jsonl
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Constants ──────────────────────────────────────────────────────────────

const EVOLVED_DIR = join(homedir(), '.laia', 'evolved');
const MAX_LINES_PER_SECTION = 50;
const MAX_LINES_TOTAL = 200;
const MAX_TOTAL_CHARS = 16_000;  // ~4K tokens
const ADAPTIVE_EXPIRY_DAYS = 30;
const STABLE_PROMOTION_HITS = 3;

// Mapping: learning type → evolved file
const TYPE_FILE_MAP = {
  preference: 'user-preferences.md',
  principle: 'user-preferences.md',
  procedure: 'task-patterns.md',
  pattern: 'task-patterns.md',
  warning: 'error-recovery.md',
  learning: 'domain-knowledge.md',
  bridge: 'domain-knowledge.md',
};

const SECTION_TITLES = {
  'user-preferences.md': 'User Preferences',
  'task-patterns.md': 'Task Patterns & Procedures',
  'error-recovery.md': 'Error Recovery & Warnings',
  'domain-knowledge.md': 'Domain Knowledge',
};

// ─── Compilation ────────────────────────────────────────────────────────────

/**
 * Compile evolved prompt from brain learnings.
 * @param {Function} brainGetLearningsFn - async function(opts) → learnings list text
 * @returns {object} { version, added, removed, expired, promoted, files, totalLines }
 */
export async function compileEvolvedPrompt(brainGetLearningsFn) {
  mkdirSync(EVOLVED_DIR, { recursive: true });

  // Load existing stable entries (they persist across compilations)
  const existingStable = loadStableEntries();

  // Load existing adaptive entries (to check expiry)
  const existingAdaptive = loadAdaptiveEntries();

  // Fetch active learnings from brain, grouped by type
  const learnings = await fetchLearningsByType(brainGetLearningsFn);

  const stats = { added: 0, removed: 0, expired: 0, promoted: 0 };

  // Build the four section files
  const fileContents = {};

  for (const [filename, title] of Object.entries(SECTION_TITLES)) {
    const types = Object.entries(TYPE_FILE_MAP)
      .filter(([_, f]) => f === filename)
      .map(([t]) => t);

    const relevantLearnings = learnings.filter(l => types.includes(l.type));

    // Sort by vitality (high first), then hit_count
    relevantLearnings.sort((a, b) => {
      const vDiff = (b.vitality ?? 0.5) - (a.vitality ?? 0.5);
      if (vDiff !== 0) return vDiff;
      return (b.hit_count ?? 0) - (a.hit_count ?? 0);
    });

    // Take top entries
    const topLearnings = relevantLearnings.slice(0, MAX_LINES_PER_SECTION);

    // Build stable + adaptive entries
    const stableEntries = [];
    const adaptiveEntries = [];

    for (const l of topLearnings) {
      const slug = l.slug;
      const line = formatLearningLine(l);

      // Check if already stable
      if (existingStable.has(slug)) {
        stableEntries.push(line);
        continue;
      }

      // Check if should be promoted to stable
      if ((l.hit_count ?? 0) >= STABLE_PROMOTION_HITS) {
        stableEntries.push(line);
        existingStable.set(slug, { line, promoted_at: new Date().toISOString() });
        stats.promoted++;
        continue;
      }

      // Check adaptive expiry
      const existing = existingAdaptive.get(slug);
      if (existing) {
        // If already marked permanently expired, skip
        if (existing.expired) {
          stats.expired++;
          continue;
        }
        const ageMs = Date.now() - new Date(existing.added_at).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > ADAPTIVE_EXPIRY_DAYS && (l.hit_count ?? 0) === 0) {
          // Mark as permanently expired in adaptive state
          existingAdaptive.set(slug, { ...existing, expired: true });
          stats.expired++;
          continue;
        }
      }

      adaptiveEntries.push({ slug, line, added_at: existing?.added_at || new Date().toISOString() });
      if (!existing) stats.added++;
    }

    // Count removed (were in previous adaptive but not in current)
    for (const [slug] of existingAdaptive) {
      if (TYPE_FILE_MAP[learnings.find(l => l.slug === slug)?.type] === filename) {
        if (!adaptiveEntries.find(e => e.slug === slug) && !existingStable.has(slug)) {
          stats.removed++;
        }
      }
    }

    // Compose file content
    let content = `# ${title}\n\n`;

    if (stableEntries.length > 0) {
      content += `## Stable (manually confirmed, never expire)\n`;
      for (const entry of stableEntries) {
        content += `- ${entry}\n`;
      }
      content += '\n';
    }

    if (adaptiveEntries.length > 0) {
      content += `## Adaptive (auto-compiled, expires after ${ADAPTIVE_EXPIRY_DAYS} days without revalidation)\n`;
      const expiryDate = new Date(Date.now() + ADAPTIVE_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];
      for (const entry of adaptiveEntries) {
        content += `- ${entry.line} [expires: ${expiryDate}]\n`;
      }
      content += '\n';
    }

    if (stableEntries.length === 0 && adaptiveEntries.length === 0) {
      content += `_No entries yet._\n`;
    }

    fileContents[filename] = content;
  }

  // Size gate: cap total content
  let totalChars = Object.values(fileContents).reduce((s, c) => s + c.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    // Truncate domain-knowledge first (least critical), then error-recovery
    for (const file of ['domain-knowledge.md', 'error-recovery.md', 'task-patterns.md']) {
      if (totalChars <= MAX_TOTAL_CHARS) break;
      const lines = fileContents[file].split('\n');
      while (lines.length > 5 && totalChars > MAX_TOTAL_CHARS) {
        const removed = lines.pop();
        totalChars -= (removed.length + 1);
      }
      fileContents[file] = lines.join('\n');
    }
  }

  // Write files
  const totalLines = Object.values(fileContents).reduce((s, c) => s + c.split('\n').length, 0);
  for (const [filename, content] of Object.entries(fileContents)) {
    writeFileSync(join(EVOLVED_DIR, filename), content, 'utf8');
  }

  // Save stable entries for next compilation
  saveStableEntries(existingStable);

  // Save adaptive entries
  const allAdaptive = new Map();
  for (const [filename, title] of Object.entries(SECTION_TITLES)) {
    const types = Object.entries(TYPE_FILE_MAP).filter(([_, f]) => f === filename).map(([t]) => t);
    const relevant = learnings.filter(l => types.includes(l.type));
    for (const l of relevant) {
      if (!existingStable.has(l.slug) && (l.hit_count ?? 0) < STABLE_PROMOTION_HITS) {
        const existing = existingAdaptive.get(l.slug);
        allAdaptive.set(l.slug, {
          added_at: existing?.added_at || new Date().toISOString(),
          type: l.type,
        });
      }
    }
  }
  saveAdaptiveEntries(allAdaptive);

  // Version tracking
  const versionFile = join(EVOLVED_DIR, '_version.json');
  let version = 1;
  try {
    const existing = JSON.parse(readFileSync(versionFile, 'utf8'));
    version = (existing.version || 0) + 1;
  } catch { /* first compilation */ }

  const versionData = {
    version,
    compiled_at: new Date().toISOString(),
    entries: {
      stable: existingStable.size,
      adaptive: allAdaptive.size,
    },
    source_learnings: learnings.length,
    total_lines: totalLines,
  };
  writeFileSync(versionFile, JSON.stringify(versionData, null, 2), 'utf8');

  // Append to evolution log
  const logLine = JSON.stringify({
    version,
    timestamp: versionData.compiled_at,
    ...stats,
    total_lines: totalLines,
  });
  appendFileSync(join(EVOLVED_DIR, '_evolution-log.jsonl'), logLine + '\n', 'utf8');

  return {
    version,
    ...stats,
    files: Object.keys(fileContents),
    totalLines,
    stableCount: existingStable.size,
    adaptiveCount: allAdaptive.size,
  };
}

// ─── Brain Integration ──────────────────────────────────────────────────────

/**
 * Fetch learnings from brain, parse and group by type.
 */
async function fetchLearningsByType(brainGetLearningsFn) {
  try {
    const result = await brainGetLearningsFn({ types: ['preference', 'principle', 'procedure', 'pattern', 'warning', 'learning', 'bridge'] });
    if (!result) return [];

    // Parse the result — brain_get_learnings returns markdown-formatted text
    // We need to parse it into structured data
    return parseLearningsFromBrainResult(result);
  } catch (e) {
    console.error(`[evolved-prompt] Failed to fetch learnings: ${e.message}`);
    return [];
  }
}

/**
 * Parse brain_get_learnings result into structured learning objects.
 * Format: "- **Title** [slug] (type:X, vitality:Y, hits:Z)\n  Body..."
 */
export function parseLearningsFromBrainResult(text) {
  if (!text || typeof text !== 'string') return [];

  const learnings = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: "- **Title** [slug] (type:X, ...)"
    const match = line.match(/^-\s+\*\*(.+?)\*\*\s+\[(.+?)\]\s*\((.+?)\)/);
    if (!match) continue;

    const [, title, slug, metaStr] = match;
    const meta = {};
    for (const pair of metaStr.split(',')) {
      const [k, v] = pair.split(':').map(s => s.trim());
      if (k && v) meta[k] = v;
    }

    // Grab body from next lines (indented or until next "- **")
    let body = '';
    let j = i + 1;
    while (j < lines.length && !lines[j].match(/^-\s+\*\*/) && lines[j].trim()) {
      body += lines[j].trim() + ' ';
      j++;
    }

    learnings.push({
      title: title.trim(),
      slug: slug.trim(),
      type: meta.type || 'learning',
      vitality: Number.isFinite(parseFloat(meta.vitality)) ? parseFloat(meta.vitality) : 0.5,
      hit_count: parseInt(meta.hits || meta.hit_count) || 0,
      body: body.trim(),
    });
  }

  return learnings;
}

// ─── Entry Formatting ───────────────────────────────────────────────────────

/**
 * Sanitize text before injecting into system prompt.
 * Strips XML-like role tags that could confuse the model.
 */
function sanitizeForPrompt(text) {
  if (!text) return '';
  return text
    .replace(/<\/?(?:system|user|assistant|human|tool|function_calls|antml)[^>]*>/gi, '')
    .replace(/\n/g, ' ')
    .trim();
}

function formatLearningLine(learning) {
  const title = sanitizeForPrompt(learning.title || '(untitled)').slice(0, 200);
  const body = learning.body
    ? sanitizeForPrompt(learning.body).slice(0, 150)
    : '';

  if (body && body !== title) {
    return `${title}: ${body}`;
  }
  return title;
}

// ─── Persistent State ───────────────────────────────────────────────────────

function loadStableEntries() {
  const file = join(EVOLVED_DIR, '_stable.json');
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveStableEntries(map) {
  const file = join(EVOLVED_DIR, '_stable.json');
  writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
}

function loadAdaptiveEntries() {
  const file = join(EVOLVED_DIR, '_adaptive.json');
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveAdaptiveEntries(map) {
  const file = join(EVOLVED_DIR, '_adaptive.json');
  writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
}

// ─── Read (used by system-prompt.js / prompt-governance.js) ─────────────────

/**
 * Load and return the evolved directory path.
 * Used by tests and commands.
 */
export function getEvolvedDir() {
  return EVOLVED_DIR;
}

/**
 * Get current version info, or null if never compiled.
 */
export function getEvolvedVersion() {
  const file = join(EVOLVED_DIR, '_version.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load evolved content split by stable vs adaptive.
 * Returns { stable: string|null, adaptive: string|null }
 * Used by prompt-governance.js for separate priority levels.
 */
export function loadEvolvedSplit() {
  if (!existsSync(EVOLVED_DIR)) return { stable: null, adaptive: null };

  try {
    const stableParts = [];
    const adaptiveParts = [];

    const files = ['domain-knowledge.md', 'error-recovery.md', 'task-patterns.md', 'user-preferences.md'];

    for (const filename of files) {
      const filePath = join(EVOLVED_DIR, filename);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, 'utf8');
      if (!content.trim()) continue;

      // Split by ## Stable / ## Adaptive headers
      const sections = content.split(/^## /m);
      for (const section of sections) {
        const trimmed = section.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('Stable')) {
          const entries = trimmed.split('\n').slice(1).filter(l => l.trim().startsWith('-'));
          if (entries.length > 0) {
            const title = SECTION_TITLES[filename] || filename;
            stableParts.push(`## ${title} (Stable)\n${entries.join('\n')}`);
          }
        } else if (trimmed.startsWith('Adaptive')) {
          const entries = trimmed.split('\n').slice(1).filter(l => l.trim().startsWith('-'));
          if (entries.length > 0) {
            const title = SECTION_TITLES[filename] || filename;
            adaptiveParts.push(`## ${title} (Adaptive)\n${entries.join('\n')}`);
          }
        }
      }
    }

    return {
      stable: stableParts.length > 0 ? stableParts.join('\n\n') : null,
      adaptive: adaptiveParts.length > 0 ? adaptiveParts.join('\n\n') : null,
    };
  } catch {
    return { stable: null, adaptive: null };
  }
}

/**
 * Load the evolved index (stable + adaptive metadata) for /evolve commands.
 * Returns { stableEntries: Map, adaptiveEntries: Map, version: object|null }
 */
export function loadEvolvedIndex() {
  return {
    stableEntries: loadStableEntries(),
    adaptiveEntries: loadAdaptiveEntries(),
    version: getEvolvedVersion(),
  };
}

/**
 * Promote an adaptive entry to stable.
 * @param {string} slug - Entry slug to promote
 * @returns {boolean} Success
 */
export function promoteEntry(slug) {
  const adaptive = loadAdaptiveEntries();
  const stable = loadStableEntries();

  if (stable.has(slug)) return false; // Already stable

  stable.set(slug, { promoted_at: new Date().toISOString(), manual: true });
  saveStableEntries(stable);

  // Log the promotion
  const logLine = JSON.stringify({
    action: 'promote',
    slug,
    timestamp: new Date().toISOString(),
    manual: true,
  });
  try {
    appendFileSync(join(EVOLVED_DIR, '_evolution-log.jsonl'), logLine + '\n', 'utf8');
  } catch { /* best effort */ }

  return true;
}

/**
 * Demote a stable entry back to adaptive.
 * @param {string} slug - Entry slug to demote
 * @returns {boolean} Success
 */
export function demoteEntry(slug) {
  const stable = loadStableEntries();
  if (!stable.has(slug)) return false;

  stable.delete(slug);
  saveStableEntries(stable);

  const logLine = JSON.stringify({
    action: 'demote',
    slug,
    timestamp: new Date().toISOString(),
  });
  try {
    appendFileSync(join(EVOLVED_DIR, '_evolution-log.jsonl'), logLine + '\n', 'utf8');
  } catch { /* best effort */ }

  return true;
}

/**
 * Expire an adaptive entry (mark as permanently expired).
 * @param {string} slug - Entry slug to expire
 * @returns {boolean} Success
 */
export function expireEntry(slug) {
  const adaptive = loadAdaptiveEntries();
  const entry = adaptive.get(slug);
  if (!entry) return false;

  adaptive.set(slug, { ...entry, expired: true });
  saveAdaptiveEntries(adaptive);

  const logLine = JSON.stringify({
    action: 'expire',
    slug,
    timestamp: new Date().toISOString(),
  });
  try {
    appendFileSync(join(EVOLVED_DIR, '_evolution-log.jsonl'), logLine + '\n', 'utf8');
  } catch { /* best effort */ }

  return true;
}
