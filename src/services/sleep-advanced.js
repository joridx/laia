// src/services/sleep-advanced.js — Advanced sleep cycle (Sprint 5 partial)
// Extends the basic sleep cycle with:
//   1. Learning dedup: detect clusters → merge near-duplicates → mark superseded
//   2. URI verification: check nc:// attachments still exist in Nextcloud
//   3. Report: summary of all consolidation actions
//
// Designed to run manually (/sleep --advanced) or via cron/daemon.
// No LLM required for dedup (token similarity). LLM optional for merge synthesis.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BRAIN_DATA = join(homedir(), 'laia-data');
const LEARNINGS_DIR = join(BRAIN_DATA, 'memory', 'learnings');

const DIM = '\x1b[2m';
const R = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

// ─── Brain Module Loader ─────────────────────────────────────────────────────

/**
 * Load a brain package module by filename (async ESM import).
 * @param {string} filename
 * @returns {Promise<Object>}
 */
async function loadBrainModule(filename) {
  const paths = [
    join(homedir(), 'laia', 'packages', 'brain', filename),
    join(process.cwd(), 'packages', 'brain', filename),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return await import(p);
    }
  }
  throw new Error(`Brain module not found: ${filename}`);
}

// ─── 1. Learning Deduplication ───────────────────────────────────────────────

/**
 * Detect and merge near-duplicate learnings.
 * Uses brain's detectClusters() for similarity, then merges high-similarity pairs.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=true] — If true, only report without modifying
 * @param {number} [opts.mergeThreshold=0.65] — Min similarity to auto-merge
 * @returns {Promise<{ clusters: Array, merged: Array, errors: string[], stats: Object }>}
 */
export async function deduplicateLearnings({ dryRun = true, mergeThreshold = 0.65 } = {}) {
  let detectClusters, markSuperseded;
  try {
    const maint = await loadBrainModule('maintenance.js');
    const learn = await loadBrainModule('learnings.js');
    detectClusters = maint.detectClusters;
    markSuperseded = learn.markSuperseded;
  } catch (err) {
    return { clusters: [], merged: [], errors: [`Failed to load brain modules: ${err.message}`], stats: {} };
  }

  const { clusters, stats } = detectClusters({ minSimilarity: 0.35 });
  const merged = [];
  const errors = [];

  for (const cluster of clusters) {
    if (cluster.suggested_action !== 'merge' || cluster.max_similarity < mergeThreshold) continue;
    if (cluster.slugs.length < 2) continue;

    // Pick the best learning as the "keeper" (most content, most recent)
    const keeper = pickKeeper(cluster.slugs);
    if (!keeper) {
      errors.push(`Could not pick keeper for cluster: ${cluster.titles.join(', ')}`);
      continue;
    }

    // Filter out already-superseded or protected learnings from superseded list
    const superseded = cluster.slugs.filter(s => {
      if (s === keeper.slug) return false;
      const file = join(LEARNINGS_DIR, `${s}.md`);
      if (!existsSync(file)) return false;
      const content = readFileSync(file, 'utf-8');
      // Skip protected learnings
      if (/^protected:\s*true/m.test(content)) {
        errors.push(`Skipping protected: ${s}`);
        return false;
      }
      return true;
    });

    if (dryRun) {
      merged.push({
        action: 'would_merge',
        keeper: keeper.slug,
        keeperTitle: keeper.title,
        superseded,
        similarity: cluster.max_similarity,
      });
    } else {
      try {
        const results = markSuperseded(keeper.slug, superseded);
        const successCount = results.filter(r => r.success).length;

        merged.push({
          action: 'merged',
          keeper: keeper.slug,
          keeperTitle: keeper.title,
          superseded,
          supersededCount: successCount,
          similarity: cluster.max_similarity,
        });
      } catch (err) {
        errors.push(`Merge failed for ${keeper.slug}: ${err.message}`);
      }
    }
  }

  return {
    clusters: clusters.map(c => ({
      titles: c.titles,
      size: c.size,
      similarity: c.max_similarity,
      action: c.suggested_action,
    })),
    merged,
    errors,
    stats,
  };
}

/**
 * Pick the best learning from a cluster to keep.
 * Prefers: most content > most recent > first alphabetically.
 *
 * @param {string[]} slugs
 * @returns {{ slug: string, title: string } | null}
 */
function pickKeeper(slugs) {
  let best = null;
  let bestScore = -1;

  for (const slug of slugs) {
    const file = join(LEARNINGS_DIR, `${slug}.md`);
    if (!existsSync(file)) continue;

    const content = readFileSync(file, 'utf-8');
    const bodyMatch = content.match(/^---[\s\S]*?---\s*([\s\S]*)/);
    const body = bodyMatch ? bodyMatch[1].trim() : '';
    const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
    const title = titleMatch ? titleMatch[1] : slug;

    // Score: body length (content richness) + recency bonus
    const createdMatch = content.match(/^created:\s*(\S+)/m);
    const created = createdMatch ? new Date(createdMatch[1]).getTime() : 0;
    const recencyBonus = created > 0 ? (created / 1e13) : 0;

    const score = body.length + recencyBonus;

    if (score > bestScore) {
      bestScore = score;
      best = { slug, title };
    }
  }

  return best;
}

// ─── 2. nc:// URI Verification ───────────────────────────────────────────────

/**
 * Verify all nc:// URIs referenced in learnings still exist in Nextcloud.
 * Uses HTTP HEAD requests to WebDAV.
 *
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=5000] — Per-request timeout
 * @param {number} [opts.concurrency=3] — Max parallel requests
 * @returns {Promise<{ checked: number, valid: number, broken: Array, errors: string[] }>}
 */
export async function verifyNcUris({ timeoutMs = 5000, concurrency = 3 } = {}) {
  const { resolveNcUri, getNcConfig } = await import('../nc/uri-resolver.js');
  const config = getNcConfig();

  if (!config.hasAuth) {
    return { checked: 0, valid: 0, broken: [], errors: ['NC_USER/NC_PASS not configured'] };
  }

  const uriMap = collectNcUris();
  if (uriMap.size === 0) {
    return { checked: 0, valid: 0, broken: [], errors: [] };
  }

  const broken = [];
  const errors = [];
  let valid = 0;

  const auth = Buffer.from(`${process.env.NC_USER}:${process.env.NC_PASS}`).toString('base64');
  const entries = [...uriMap.entries()];

  // Process in batches for bounded concurrency
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async ([uri, slugs]) => {
        const webdavUrl = resolveNcUri(uri);
        const response = await fetchWithTimeout(webdavUrl, {
          method: 'HEAD',
          headers: { 'Authorization': `Basic ${auth}` },
        }, timeoutMs);
        return { uri, slugs, ok: response.ok, status: response.status };
      })
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const [uri, slugs] = batch[j];
      if (result.status === 'fulfilled') {
        const r = result.value;
        if (r.ok) {
          valid++;
        } else {
          broken.push({ uri: r.uri, slugs: r.slugs, status: r.status, error: `HTTP ${r.status}` });
        }
      } else {
        const err = result.reason;
        if (err?.message === 'Request timed out') {
          errors.push(`Timeout checking ${uri}`);
        } else {
          broken.push({ uri, slugs, status: 0, error: err?.message || 'Unknown error' });
        }
      }
    }
  }

  return { checked: uriMap.size, valid, broken, errors };
}

/**
 * Scan all learnings for nc:// URIs.
 * @returns {Map<string, string[]>} URI → [slug, ...]
 */
function collectNcUris() {
  const uriMap = new Map();

  let files;
  try {
    files = readdirSync(LEARNINGS_DIR).filter(f => f.endsWith('.md'));
  } catch {
    return uriMap;
  }

  const NC_URI_RE = /nc:\/\/\/[^\s)>\]"']+/g;
  const TRAILING_PUNCT = /[.,;:!?]+$/;

  for (const file of files) {
    try {
      const content = readFileSync(join(LEARNINGS_DIR, file), 'utf-8');
      const matches = content.match(NC_URI_RE);
      if (!matches) continue;

      const slug = file.replace(/\.md$/, '');
      for (const rawUri of new Set(matches)) {
        const uri = rawUri.replace(TRAILING_PUNCT, ''); // Strip trailing punctuation
        if (!uriMap.has(uri)) uriMap.set(uri, []);
        uriMap.get(uri).push(slug);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return uriMap;
}

/**
 * Fetch with timeout.
 */
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 3. Combined Advanced Sleep Cycle ────────────────────────────────────────

/**
 * Run the full advanced sleep cycle.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=true] — Report only, no changes
 * @param {boolean} [opts.skipBasic=false] — Skip basic sleep cycle
 * @param {boolean} [opts.verifyUris=true] — Check nc:// URIs
 * @returns {Promise<Object>} Combined report
 */
export async function runAdvancedSleepCycle({ dryRun = true, skipBasic = false, verifyUris = true, extractTalk = true, config } = {}) {
  const report = { basic: null, dedup: null, uris: null, talkExtract: null, timestamp: new Date().toISOString() };

  // Step 1: Run basic sleep cycle
  if (!skipBasic) {
    try {
      const { runSleepCycle, pruneDailyMemories } = await import('./sleep-cycle.js');
      const result = runSleepCycle();
      const pruned = pruneDailyMemories();
      report.basic = { ...(result || { bullets: 0, sessions: 0, bytes: 0 }), pruned };
    } catch (err) {
      report.basic = { error: err.message };
    }
  }

  // Step 2: Deduplicate learnings
  try {
    report.dedup = await deduplicateLearnings({ dryRun });
  } catch (err) {
    report.dedup = { clusters: [], merged: [], errors: [err.message], stats: {} };
  }

  // Step 3: Verify nc:// URIs
  if (verifyUris) {
    try {
      report.uris = await verifyNcUris();
    } catch (err) {
      report.uris = { checked: 0, valid: 0, broken: [], errors: [err.message] };
    }
  }

  // Step 4: Extract learnings from Talk conversations
  if (extractTalk && config) {
    try {
      const { extractFromTalk } = await import('./talk-extractor.js');
      report.talkExtract = await extractFromTalk({
        config,
        dryRun,
        save: !dryRun,
      });
    } catch (err) {
      report.talkExtract = { rooms: 0, messagesProcessed: 0, batchesSent: 0, learningsExtracted: [], learningsSaved: 0, errors: [err.message], dryRun };
    }
  }

  return report;
}

/**
 * Format the advanced sleep cycle report for human display.
 * @param {Object} report
 * @returns {string}
 */
export function formatReport(report) {
  const lines = [`\n🌙 Advanced Sleep Cycle Report`, `${DIM}${report.timestamp}${R}`, ''];

  // Basic
  if (report.basic) {
    if (report.basic.error) {
      lines.push(`${YELLOW}⚠ Basic cycle error: ${report.basic.error}${R}`);
    } else {
      lines.push(`${GREEN}✓${R} Basic: ${report.basic.bullets} bullets from ${report.basic.sessions} sessions, ${report.basic.pruned || 0} pruned`);
    }
  }

  // Dedup
  if (report.dedup) {
    const d = report.dedup;
    const clusterCount = d.clusters?.length || 0;
    const mergeCount = d.merged?.length || 0;
    const verb = d.merged?.[0]?.action === 'would_merge' ? 'would merge' : 'merged';
    lines.push(`${GREEN}✓${R} Dedup: ${clusterCount} clusters found, ${mergeCount} ${verb}`);

    if (d.merged?.length > 0) {
      for (const m of d.merged) {
        const icon = m.action === 'merged' ? '🔗' : '🔍';
        lines.push(`  ${icon} Keep "${m.keeperTitle}" → supersede ${m.superseded.length} duplicate(s) (sim: ${m.similarity})`);
      }
    }

    if (d.clusters?.length > 0) {
      const reviewClusters = d.clusters.filter(c => c.action === 'review');
      if (reviewClusters.length > 0) {
        lines.push(`  ${DIM}${reviewClusters.length} cluster(s) need manual review${R}`);
      }
    }

    for (const e of d.errors || []) lines.push(`  ${YELLOW}⚠ ${e}${R}`);
  }

  // URIs
  if (report.uris) {
    const u = report.uris;
    if (u.checked === 0 && (u.errors?.length || 0) === 0) {
      lines.push(`${DIM}⊘ URIs: No nc:// references found${R}`);
    } else if ((u.errors?.length || 0) > 0 && u.checked === 0) {
      lines.push(`${YELLOW}⚠ URIs: ${u.errors[0]}${R}`);
    } else {
      const brokenCount = u.broken?.length || 0;
      const icon = brokenCount > 0 ? YELLOW + '⚠' : GREEN + '✓';
      lines.push(`${icon}${R} URIs: ${u.checked} checked, ${u.valid} valid, ${brokenCount} broken`);

      for (const b of u.broken || []) {
        lines.push(`  ❌ ${b.uri} (${b.error}) — used in: ${b.slugs.join(', ')}`);
      }
    }
  }

  // Talk extraction
  if (report.talkExtract) {
    const t = report.talkExtract;
    if (t.errors?.length > 0 && t.messagesProcessed === 0) {
      lines.push(`${YELLOW}⚠ Talk: ${t.errors[0]}${R}`);
    } else {
      const extracted = t.learningsExtracted?.length || 0;
      const saved = t.learningsSaved || 0;
      const verb = t.dryRun ? 'would extract' : 'extracted';
      const icon = extracted > 0 ? GREEN + '✓' : DIM + '⊘';
      lines.push(`${icon}${R} Talk: ${t.messagesProcessed} messages → ${extracted} ${verb}${saved ? `, ${saved} saved` : ''}`);

      for (const l of (t.learningsExtracted || []).slice(0, 5)) {
        const lIcon = l.type === 'warning' ? '⚠️' : l.type === 'preference' ? '🎯' : '💡';
        lines.push(`  ${lIcon} ${l.title}`);
      }
      if (extracted > 5) lines.push(`  ${DIM}(+${extracted - 5} more)${R}`);

      for (const e of (t.errors || []).slice(0, 2)) lines.push(`  ${YELLOW}⚠ ${e}${R}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
