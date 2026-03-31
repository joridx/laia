/**
 * Learnings management for LAIA Brain.
 * CRUD, filtering, vitality computation, hit tracking.
 */

import * as fs from "fs";
import * as path from "path";
import { BRAIN_PATH, LEARNINGS_DIR, NOTES_DIR } from "./config.js";
import { readFile, writeFile, readJSON, getLearningsCache, setLearningsCache } from "./file-io.js";
import { sanitizeTag, normPath, parseLearningFrontmatter, isLearningFile, tokenize, noteSlugFromPath } from "./utils.js";
import {
  computeACTR, computeStructuralBoost, computeStructuralBoostPR, computeAccessSaturation,
  classifyVitalityZone, TYPE_DECAY_RATES, TYPE_VITALITY_FLOORS
} from "./scoring.js";
import { recordHit, getRelatedConcepts, getPageRankMap } from "./graph.js";
import { isDbAvailable, getAllLearningsFromDb, getLearningsByTagsFromDb, getVitalityMapFromDb, loadAllEmbeddings, metaRepo } from "./database.js";
import { isEmbeddingsAvailable, embedText, cosineSimilarity, buildEmbeddingText, blobToEmbedding } from "./embeddings.js";
import { isLlmAvailable, llmCheckDuplicate } from "./llm.js";
import { readMetaWithDirty } from "./meta-io.js";

// ─── P14.1: Meta read helper (SQLite primary, JSON fallback) ─────────────────

/** Read learnings meta. Returns { learnings: { slug: metaObj } } */
function _readMeta() {
  return readMetaWithDirty(() => _metaDirtyRef);
}

// ─── Perf #2: Debounced meta writes ──────────────────────────────────────────
// Multiple functions update learnings-meta.json during a single search.
// Instead of writing to disk each time, we accumulate changes and flush once.

let _metaDirtyRef = null;   // reference to the dirty meta object
let _flushTimer = null;
const META_FLUSH_DELAY = 500; // ms

function _writeMeta(meta, slug) {
  _metaDirtyRef = meta;
  if (slug) _dirtySlugs.add(slug);
  // Trailing debounce: reset timer on each write so flush waits for quiet period
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(_flushMeta, META_FLUSH_DELAY);
}

function _flushMeta() {
  _flushTimer = null;
  if (_metaDirtyRef) {
    writeFile("learnings-meta.json", JSON.stringify(_metaDirtyRef, null, 2));
    // P14.1 dual-write: sync dirty entries to SQLite so reads stay consistent
    _syncDirtyToDb(_metaDirtyRef);
    _metaDirtyRef = null;
  }
}

/** Track which slugs were modified since last flush */
const _dirtySlugs = new Set();

/** Sync only the dirty slugs to SQLite via metaRepo.upsertMeta */
function _syncDirtyToDb(meta) {
  if (_dirtySlugs.size === 0 || !meta?.learnings) return;
  for (const slug of _dirtySlugs) {
    const entry = meta.learnings[slug];
    if (entry) {
      metaRepo.upsertMeta(slug, entry);
    }
  }
  _dirtySlugs.clear();
}

/** Force-flush pending meta writes (call on server shutdown). */
export function flushMetaSync() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _flushMeta();
}

// ─── Get all learnings (cached via file-io) ──────────────────────────────────

export function getAllLearnings() {
  const cached = getLearningsCache();
  if (cached) return cached;

  // Try SQLite first (P4.1)
  if (isDbAvailable()) {
    const dbResult = getAllLearningsFromDb();
    if (dbResult) {
      setLearningsCache(dbResult);
      return dbResult;
    }
  }

  // Fallback: filesystem
  const result = [];

  // Scan memory/learnings/ (flat)
  const dir = path.join(BRAIN_PATH, LEARNINGS_DIR);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue;
      const content = readFile(`${LEARNINGS_DIR}/${f}`);
      const parsed = parseLearningFrontmatter(content);
      if (!parsed) continue;
      result.push({
        file: `${LEARNINGS_DIR}/${f}`,
        slug: f.replace(".md", ""),
        ...parsed.frontmatter,
        body: parsed.body
      });
    }
  }

  // Scan memory/notes/ (recursive — human-created notes)
  const notesDir = path.join(BRAIN_PATH, NOTES_DIR);
  const seenSlugs = new Set(result.map(r => r.slug));
  if (fs.existsSync(notesDir)) {
    const notesDirNorm = normPath(notesDir);
    (function walk(d, depth) {
      if (depth > 5) return;
      for (const entry of fs.readdirSync(d)) {
        if (entry.startsWith("_") || entry.startsWith(".")) continue;
        const fp = path.join(d, entry);
        let stat;
        try { stat = fs.lstatSync(fp); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) { walk(fp, depth + 1); continue; }
        if (!entry.endsWith(".md")) continue;
        const relPath = normPath(fp).replace(normPath(BRAIN_PATH) + "/", "");
        // Derive slug: include subfolder path to avoid collision with learnings/
        const slug = noteSlugFromPath(normPath(fp), notesDirNorm);
        if (seenSlugs.has(slug)) continue; // skip collision
        seenSlugs.add(slug);
        const content = readFile(relPath);
        const parsed = parseLearningFrontmatter(content);
        if (!parsed) continue;
        result.push({
          file: relPath,
          slug,
          ...parsed.frontmatter,
          body: parsed.body
        });
      }
    })(notesDir, 0);
  }

  setLearningsCache(result);
  return result;
}

// ─── Filter by tags ───────────────────────────────────────────────────────────

export function getLearningsByTags(tags, type = null) {
  // Try SQLite first (P4.1) — uses learning_tags join table
  if (isDbAvailable()) {
    const dbResult = getLearningsByTagsFromDb(tags, type);
    if (dbResult) return dbResult;
  }

  // Fallback: filesystem scan + filter
  const all = getAllLearnings();
  const normalizedTags = tags.map(sanitizeTag);

  return all.filter(l => {
    if (type && l.type !== type) return false;
    const learningTags = (l.tags || []).map(sanitizeTag);
    return normalizedTags.some(t => learningTags.includes(t));
  });
}

// ─── Hit tracking ─────────────────────────────────────────────────────────────

export function recordLearningHits(results) {
  if (!results || results.length === 0) return;

  const meta = _readMeta();
  if (!meta || !meta.learnings) return;

  const today = new Date().toISOString().split("T")[0];
  const hitSlugs = new Set();

  for (const r of results) {
    if (!isLearningFile(r.file)) continue;
    const filename = normPath(r.file).split("/").pop();
    const slug = filename.replace(".md", "");
    if (slug && !hitSlugs.has(slug) && meta.learnings[slug]) {
      hitSlugs.add(slug);
      meta.learnings[slug].hit_count = (meta.learnings[slug].hit_count || 0) + 1;
      meta.learnings[slug].last_accessed = today;
    }
  }

  if (hitSlugs.size > 0) {
    for (const s of hitSlugs) _dirtySlugs.add(s);
    _writeMeta(meta);
  }
}

export function recordLearningHitsBySlugs(slugs) {
  if (!slugs || slugs.length === 0) return;

  const meta = _readMeta();
  if (!meta || !meta.learnings) return;

  const today = new Date().toISOString().split("T")[0];
  for (const slug of slugs) {
    if (meta.learnings[slug]) {
      meta.learnings[slug].hit_count = (meta.learnings[slug].hit_count || 0) + 1;
      meta.learnings[slug].last_accessed = today;
      _dirtySlugs.add(slug);
    }
  }
  _writeMeta(meta);
}

// ─── P10.3: Implicit relevance signal ────────────────────────────────────────

// In-memory attribution cache: slug → timestamp (ms) when last returned by brain_search
const _searchAttributionCache = new Map();
const ATTRIBUTION_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Test-only: seed attribution cache entry. */
export function _seedAttributionCache(slug, ts) {
  _searchAttributionCache.set(slug, ts);
}

/**
 * Record that these slugs appeared in brain_search results.
 * Increments `search_appearances` in learnings-meta and sets attribution cache.
 */
export function recordSearchAppearances(slugs) {
  if (!slugs || slugs.length === 0) return;

  const meta = _readMeta();
  if (!meta || !meta.learnings) return;

  const now = Date.now();
  const unique = [...new Set(slugs)];
  let changed = false;
  for (const slug of unique) {
    if (meta.learnings[slug]) {
      meta.learnings[slug].search_appearances = (meta.learnings[slug].search_appearances || 0) + 1;
      changed = true;
      _dirtySlugs.add(slug);
      _searchAttributionCache.set(slug, now);
    }
  }

  // Prune expired entries periodically (every 100 appearances)
  if (changed && _searchAttributionCache.size > 200) {
    for (const [s, ts] of _searchAttributionCache) {
      if (now - ts >= ATTRIBUTION_TTL_MS) _searchAttributionCache.delete(s);
    }
  }

  if (changed) {
    _writeMeta(meta);
  }
}

/**
 * Check if accessed slugs were recently returned by brain_search (within TTL).
 * If so, increment `search_followup_hits` — these are attributed conversions.
 * Each attribution is consumed once (deleted from cache) to prevent overcounting.
 */
export function checkSearchAttribution(slugs) {
  if (!slugs || slugs.length === 0) return;

  const now = Date.now();
  const unique = [...new Set(slugs)];
  const attributed = unique.filter(slug => {
    const ts = _searchAttributionCache.get(slug);
    return ts && (now - ts) < ATTRIBUTION_TTL_MS;
  });
  if (attributed.length === 0) return;

  const meta = _readMeta();
  if (!meta || !meta.learnings) return;

  for (const slug of attributed) {
    if (meta.learnings[slug]) {
      meta.learnings[slug].search_followup_hits = (meta.learnings[slug].search_followup_hits || 0) + 1;

      // P12.3: Increment confirmation_count for principles (attributed = confirmed)
      if (meta.learnings[slug].type === "principle") {
        meta.learnings[slug].confirmation_count = (meta.learnings[slug].confirmation_count || 0) + 1;
        meta.learnings[slug].last_confirmed = new Date().toISOString();
      }
      _dirtySlugs.add(slug);
    }
    // Consume: prevent multiple followup counts for the same appearance
    _searchAttributionCache.delete(slug);
  }
  _writeMeta(meta);
}

/**
 * Compute relevance metrics from learnings-meta.
 * Returns { overallConversion, noiseList, totalAppearances, totalFollowups }.
 */
export function computeRelevanceMetrics(minAppearances = 20) {
  const meta = _readMeta();
  if (!meta || !meta.learnings) return null;

  let totalAppearances = 0;
  let totalFollowups = 0;
  const candidates = [];

  for (const [slug, data] of Object.entries(meta.learnings)) {
    const appearances = data.search_appearances || 0;
    const followups = data.search_followup_hits || 0;
    totalAppearances += appearances;
    totalFollowups += followups;

    if (appearances >= minAppearances) {
      // Bayesian smoothed conversion: (hits + 1) / (appearances + 3)
      const smoothed = (followups + 1) / (appearances + 3);
      candidates.push({ slug, appearances, followups, smoothed, title: data.title || slug });
    }
  }

  // Overall conversion (smoothed)
  const overallConversion = totalAppearances > 0
    ? +((totalFollowups + 1) / (totalAppearances + 3)).toFixed(4)
    : null;

  // Noise: low smoothed conversion, sorted ascending
  const noiseList = candidates
    .filter(c => c.smoothed < 0.15)
    .sort((a, b) => a.smoothed - b.smoothed)
    .slice(0, 5)
    .map(c => ({ slug: c.slug, title: c.title, appearances: c.appearances, followups: c.followups, conversion: +(c.smoothed * 100).toFixed(1) }));

  return { overallConversion, noiseList, totalAppearances, totalFollowups };
}

// ─── Retrieve with full pipeline ──────────────────────────────────────────────

export function retrieveLearningsByTags(tags, type) {
  let allRelated = [];
  for (const tag of tags) {
    recordHit("tag", sanitizeTag(tag));
    allRelated.push(...getRelatedConcepts(tag));
  }
  allRelated = [...new Set(allRelated)];

  const allTags = [...tags, ...allRelated];
  const results = getLearningsByTags(allTags, type || null);

  const seen = new Set();
  const unique = results.filter(r => {
    if (seen.has(r.slug)) return false;
    seen.add(r.slug);
    return true;
  });

  const { active, stale } = filterStaleLearnings(unique);
  recordLearningHitsBySlugs(active.map(r => r.slug));

  return { active, stale, allRelated };
}

// ─── Stale filtering ──────────────────────────────────────────────────────────

export function filterStaleResults(results, vitalityMap = null) {
  if (!results || results.length === 0) return { active: [], stale: [] };

  const meta = _readMeta();
  if (!meta || !meta.learnings) return { active: results, stale: [] };

  const vMap = vitalityMap || computeAllVitalities();
  const active = [];
  const stale = [];

  for (const r of results) {
    if (!isLearningFile(r.file)) {
      active.push(r);
      continue;
    }
    const filename = normPath(r.file).split("/").pop();
    const slug = filename.replace(".md", "");
    const vData = vMap.get(slug);
    const zone = vData?.zone || (meta.learnings[slug]?.stale ? "stale" : "active");
    if (zone === "active") {
      active.push(r);
    } else {
      stale.push({ ...r, vitalityZone: zone });
    }
  }

  return { active, stale };
}

export function filterStaleLearnings(learnings, vitalityMap = null) {
  const meta = _readMeta();
  if (!meta || !meta.learnings) return { active: learnings, stale: [] };

  const vMap = vitalityMap || computeAllVitalities();
  const active = [];
  const stale = [];
  for (const l of learnings) {
    const vData = vMap.get(l.slug);
    const zone = vData?.zone || (meta.learnings[l.slug]?.stale ? "stale" : "active");
    if (zone === "active") {
      active.push(l);
    } else {
      stale.push({ ...l, vitalityZone: zone });
    }
  }
  return { active, stale };
}

// ─── Learning meta ────────────────────────────────────────────────────────────

export function ensureLearningMeta(slug, title, file, type, { agentProfile, protected: isProtected, trigger_intents, preconditions, step_count } = {}) {
  const meta = _readMeta();
  if (!meta || !meta.learnings) return;

  if (!meta.learnings[slug]) {
    const today = new Date().toISOString().split("T")[0];
    // Truncate title to 120 chars to prevent body leaking into title field
    const truncatedTitle = title.length > 120 ? title.slice(0, 117) + "..." : title;
    // Read tags from the file frontmatter (needed for similarity gate)
    let tags = [];
    try {
      const content = readFile(file);
      const parsed = parseLearningFrontmatter(content);
      if (parsed?.frontmatter?.tags) tags = parsed.frontmatter.tags.map(sanitizeTag);
    } catch {}
    meta.learnings[slug] = {
      title: truncatedTitle,
      file,
      type,
      tags,
      hit_count: 0,
      created_date: today,
      last_accessed: null,
      stale: false,
      ...(agentProfile ? { agentProfile } : {}),
      // V4: Sprint 1 fields
      ...(isProtected ? { protected: true } : {}),
      ...(trigger_intents?.length ? { trigger_intents } : {}),
      ...(preconditions?.length ? { preconditions } : {}),
      ...(step_count ? { step_count } : {}),
    };
    _writeMeta(meta, slug);
    invalidateVitalityCache(); // new learning affects vitality map
  }
}

// ─── P14.3: Supersession ────────────────────────────────────────────────────────

/**
 * Mark old learnings as superseded by a new one.
 * Sets superseded_by on old slugs and updates their vitality zone.
 * Returns array of { slug, title, success } for each superseded learning.
 */
export function markSuperseded(newSlug, oldSlugs) {
  if (!oldSlugs || oldSlugs.length === 0) return [];

  const meta = _readMeta();
  if (!meta || !meta.learnings) return [];

  const results = [];
  let changed = false;

  for (const oldSlug of oldSlugs) {
    // P14.3: Guard against self-supersede and cycles
    if (oldSlug === newSlug) {
      results.push({ slug: oldSlug, title: null, success: false, reason: "cannot supersede itself" });
      continue;
    }
    const newEntry = meta.learnings[newSlug];
    if (newEntry?.superseded_by === oldSlug) {
      results.push({ slug: oldSlug, title: null, success: false, reason: `cycle detected: ${newSlug} is already superseded by ${oldSlug}` });
      continue;
    }

    const entry = meta.learnings[oldSlug];
    if (!entry) {
      results.push({ slug: oldSlug, title: null, success: false, reason: "not found" });
      continue;
    }
    if (entry.superseded_by) {
      results.push({ slug: oldSlug, title: entry.title, success: false, reason: `already superseded by ${entry.superseded_by}` });
      continue;
    }

    entry.superseded_by = newSlug;
    entry.vitality = (entry.vitality ?? 0.5) * 0.1; // Accelerated decay
    entry.vitality_zone = "fading";
    entry.vitality_updated = new Date().toISOString().split("T")[0];
    changed = true;
    results.push({ slug: oldSlug, title: entry.title, success: true });
  }

  if (changed) {
    for (const r of results) if (r.success) _dirtySlugs.add(r.slug);
    _writeMeta(meta);
    invalidateVitalityCache(); // supersession changes vitality

  }

  return results;
}

/**
 * Check if a learning is superseded.
 */
export function isSuperseded(slug) {
  const meta = _readMeta();
  return !!(meta?.learnings?.[slug]?.superseded_by);
}

// ─── Similarity gate (P7.1) ───────────────────────────────────────────────────

/**
 * Check if a learning with a similar title already exists.
 * Uses Jaccard similarity on title tokens + tag overlap.
 *
 * Returns:
 *   { level: "block",  slug, similarity, tagOverlap }  — Jaccard >= 0.70
 *   { level: "warn",   slug, similarity, tagOverlap }  — Jaccard >= 0.50 or tagOverlap >= 0.80
 *   null                                                — no similar learning found
 */
/**
 * 3-phase duplicate detection (P9.3):
 *   Phase 1: Embedding pre-filter (free, <1ms) — narrows candidates
 *   Phase 2: Jaccard refinement — title tokens + tag overlap
 *   Phase 3: LLM verification (1 unit) — only for borderline cases
 *
 * Hard gates (Jaccard >= 0.70 → block) are unchanged.
 * LLM results are warn-only until precision is calibrated.
 */
export async function findSimilarLearning(title, tags) {
  const meta = _readMeta();
  if (!meta?.learnings) return null;

  const newTokens = new Set(tokenize(title));
  if (newTokens.size === 0) return null;

  const newTags = new Set((tags || []).map(sanitizeTag));
  const entries = Object.entries(meta.learnings).filter(([, d]) => d.title);

  // ── Phase 1: Embedding pre-filter (narrows scan if available) ────────────
  let embCandidateSlugs = null; // null = no filtering (scan all)
  if (isEmbeddingsAvailable() && isDbAvailable()) {
    try {
      const queryEmb = await embedText(title);
      if (queryEmb) {
        const allEmb = loadAllEmbeddings();
        if (allEmb && allEmb.size > 0) {
          const scored = [];
          for (const [slug, data] of allEmb) {
            try {
              const vec = blobToEmbedding(data.embedding);
              if (!vec || vec.length !== queryEmb.length) continue;
              const sim = cosineSimilarity(queryEmb, vec);
              if (sim > 0.55) scored.push({ slug, embSim: sim });
            } catch { /* skip corrupt embedding row */ }
          }
          scored.sort((a, b) => b.embSim - a.embSim);
          embCandidateSlugs = new Map(scored.slice(0, 8).map(s => [s.slug, s.embSim]));
        }
      }
    } catch { /* embedding failure: fall back to full scan */ }
  }

  // ── Phase 2: Jaccard refinement ──────────────────────────────────────────
  const candidates = [];

  for (const [slug, data] of entries) {
    // If embedding pre-filter active, skip non-candidates (unless Jaccard scan catches them)
    const embSim = embCandidateSlugs?.get(slug) ?? null;
    const inEmbCandidates = embCandidateSlugs === null || embSim !== null;

    // Jaccard on title tokens
    const existingTokens = new Set(tokenize(data.title));
    if (existingTokens.size === 0) continue;

    const intersection = [...newTokens].filter(t => existingTokens.has(t)).length;
    const union = new Set([...newTokens, ...existingTokens]).size;
    const jaccard = intersection / union;

    // Tag overlap
    let existingTagsArr = data.tags;
    if (!existingTagsArr && data.file) {
      try {
        const content = readFile(data.file);
        const parsed = parseLearningFrontmatter(content);
        existingTagsArr = parsed?.frontmatter?.tags;
      } catch {}
    }
    const existingTags = new Set((existingTagsArr || []).map(sanitizeTag));
    const tagIntersection = [...newTags].filter(t => existingTags.has(t)).length;
    const tagOverlap = newTags.size > 0 ? tagIntersection / newTags.size : 0;

    // Collect candidates: Jaccard >= 0.40 OR tagOverlap >= 0.60 OR embedding candidate
    if (jaccard >= 0.40 || tagOverlap >= 0.60 || (inEmbCandidates && embSim !== null)) {
      candidates.push({
        slug, title: data.title,
        similarity: +jaccard.toFixed(3),
        tagOverlap: +tagOverlap.toFixed(3),
        embSim: embSim !== null ? +embSim.toFixed(3) : null
      });
    }
  }

  if (candidates.length === 0) return null;

  // Sort: prefer high Jaccard, then high embedding similarity
  candidates.sort((a, b) => b.similarity - a.similarity || (b.embSim || 0) - (a.embSim || 0));
  const best = candidates[0];

  // Hard gate: Jaccard >= 0.65 → block (V2: lowered from 0.70)
  if (best.similarity >= 0.65) {
    return { level: "block", source: "jaccard", ...best };
  }

  // ── Phase 3: LLM verification (borderline cases only) ───────────────────
  if (isLlmAvailable()) {
    try {
      const llmResult = await llmCheckDuplicate(title, candidates.slice(0, 3));
      if (llmResult && llmResult.slug && llmResult.similarity >= 0.65) {
        const matched = candidates.find(c => c.slug === llmResult.slug);
        if (matched) {
          // LLM results are warn-only until precision is calibrated
          return {
            level: "warn",
            source: "llm",
            slug: matched.slug,
            title: matched.title,
            similarity: +llmResult.similarity.toFixed(3),
            tagOverlap: matched.tagOverlap || 0,
            embSim: matched.embSim || null,
            reason: llmResult.reason
          };
        }
      }
    } catch { /* LLM failure: fall through to Jaccard-only gates */ }
  }

  // Jaccard/tag soft gates (existing behavior)
  if (best.similarity >= 0.50 || best.tagOverlap >= 0.80) {
    return { level: "warn", source: "jaccard", ...best };
  }

  // Embedding-only warn: high embedding similarity but low Jaccard
  if (best.embSim !== null && best.embSim >= 0.75 && best.similarity < 0.50) {
    return { level: "warn", source: "embedding", ...best };
  }

  return null;
}

// ─── Vitality computation (ACT-R cognitive model) ─────────────────────────────

// ─── Perf #3: Vitality cache with TTL ──────────────────────────────────────
let _vitalityCache = null;
let _vitalityCacheTime = 0;
const VITALITY_TTL = 60_000; // 60 seconds

/** Invalidate vitality cache (call after writes that affect vitality). */
export function invalidateVitalityCache() {
  _vitalityCache = null;
  _vitalityCacheTime = 0;
}

export function computeAllVitalities({ forceRecompute = false, meta: providedMeta = null } = {}) {
  // Perf #3: Return cached result if within TTL
  const now = Date.now();
  if (!forceRecompute && _vitalityCache && (now - _vitalityCacheTime) < VITALITY_TTL) {
    return _vitalityCache;
  }

  // Try precomputed vitality from SQLite (P4.1) — synced at session start
  // V2: Skip cache when forceRecompute (needed after decay parameter changes)
  if (!forceRecompute && isDbAvailable()) {
    const dbMap = getVitalityMapFromDb();
    if (dbMap && dbMap.size > 0) {
      _vitalityCache = dbMap;
      _vitalityCacheTime = now;
      return dbMap;
    }
  }

  // Fallback: recompute from JSON files
  // Perf E2: use provided meta if available (avoids duplicate metaRepo.getAll())
  const meta = providedMeta || _readMeta();
  if (!meta?.learnings) return new Map();

  // P4.4: Compute PageRank-based centrality for each learning via its tags
  const pageRankMap = getPageRankMap();
  const slugCentrality = new Map();
  if (pageRankMap.size > 0) {
    const allLearnings = getAllLearnings();
    for (const l of allLearnings) {
      const tags = (l.tags || []).map(t => t.toLowerCase());
      let maxPR = 0;
      for (const tag of tags) {
        const pr = pageRankMap.get(tag) || 0;
        if (pr > maxPR) maxPR = pr;
      }
      slugCentrality.set(l.slug, maxPR);
    }
  }

  // Fallback inDegree map (used when PageRank unavailable)
  const inDegreeMap = new Map();
  if (pageRankMap.size === 0) {
    const relations = readJSON("relations.json"); // P14.1: read-only, cached via file-io
    if (relations?.concepts) {
      for (const [_, data] of Object.entries(relations.concepts)) {
        for (const rel of (data.related_to || [])) {
          inDegreeMap.set(rel, (inDegreeMap.get(rel) || 0) + 1);
        }
        for (const child of (data.children || [])) {
          inDegreeMap.set(child, (inDegreeMap.get(child) || 0) + 1);
        }
      }
    }
  }

  // V4 Auto-promotion thresholds for Golden Suite
  const AUTO_PROMOTE_HITS = 10;
  const AUTO_PROMOTE_APPEARANCES = 20;

  const result = new Map();
  const promotions = [];  // Track auto-promoted slugs for meta update

  for (const [slug, data] of Object.entries(meta.learnings)) {
    // V4 Golden Suite: protected learnings always have vitality 1.0, zone "active"
    if (data.protected || data.type === "principle") {
      result.set(slug, { vitality: 1.0, zone: "active", accessCount: data.hit_count || 0, inDegree: inDegreeMap.get(slug.toLowerCase()) || 0, pageRank: slugCentrality.get(slug) || 0, protected: true });
      continue;
    }

    // V4 Auto-promotion: frequently accessed learnings become protected
    const hitCount = data.hit_count || 0;
    const appearances = data.search_appearances || 0;
    if (hitCount >= AUTO_PROMOTE_HITS && appearances >= AUTO_PROMOTE_APPEARANCES) {
      data.protected = true;
      data.promoted_at = new Date().toISOString();
      data.promoted_reason = `auto:hits=${hitCount},appearances=${appearances}`;
      promotions.push(slug);
      result.set(slug, { vitality: 1.0, zone: "active", accessCount: hitCount, inDegree: inDegreeMap.get(slug.toLowerCase()) || 0, pageRank: slugCentrality.get(slug) || 0, protected: true });
      continue;
    }

    const accessCount = data.hit_count || 0;
    const created = data.created_date;
    const lifetimeDays = created
      ? Math.max(1, (Date.now() - new Date(created).getTime()) / (1000 * 60 * 60 * 24))
      : 1;

    const effectiveDecay = 0.5 * 1.0;
    let vitality = computeACTR(accessCount, lifetimeDays, effectiveDecay);

    // P4.4: Use PageRank centrality if available, fallback to inDegree
    const centrality = slugCentrality.get(slug) || 0;
    if (centrality > 0) {
      vitality *= computeStructuralBoostPR(centrality);
    } else {
      const inDegree = inDegreeMap.get(slug.toLowerCase()) || 0;
      vitality *= computeStructuralBoost(inDegree);
    }

    const saturation = computeAccessSaturation(accessCount, 10);
    vitality *= (0.5 + 0.5 * saturation);

    // V2: Type-aware idle decay multiplier
    const type = data.type || 'learning';
    const lastAccessed = data.last_accessed;
    if (lastAccessed) {
      const lastDate = new Date(lastAccessed);
      const monthsIdle = Math.max(0, (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
      if (monthsIdle > 0) {
        const decayRate = TYPE_DECAY_RATES[type] || 0.05;
        const decayMultiplier = Math.max(0.1, 1.0 - (monthsIdle * decayRate));
        vitality *= decayMultiplier;
      }
    } else if (lifetimeDays > 90) {
      // Never accessed + old → apply aggressive decay
      const monthsAlive = lifetimeDays / 30.44;
      const decayRate = TYPE_DECAY_RATES[type] || 0.05;
      const decayMultiplier = Math.max(0.1, 1.0 - (monthsAlive * decayRate));
      vitality *= decayMultiplier;
    }

    // V2: Apply type floor (prevents principles from archiving)
    const floor = TYPE_VITALITY_FLOORS[type] || 0.10;
    vitality = Math.max(vitality, floor);

    vitality = Math.max(0, Math.min(1, vitality));
    const zone = classifyVitalityZone(vitality, data.archived);

    result.set(slug, { vitality, zone, accessCount, inDegree: inDegreeMap.get(slug.toLowerCase()) || 0, pageRank: centrality, protected: false });
  }

  // Cache the computed result
  _vitalityCache = result;
  _vitalityCacheTime = Date.now();

  // V4: Persist auto-promotions to meta (outside the loop to batch)
  if (promotions.length > 0) {
    _writeMeta(meta);
  }

  return result;
}

// ─── WikiLinks for Obsidian (P3.2) ──────────────────────────────────────────

/**
 * Generate a "## Related" section with WikiLinks for a new learning.
 * Finds top-5 most related learnings via Jaccard on tag sets (>= 0.25).
 * @param {string} slug - The new learning's slug (to exclude from results)
 * @param {string[]} tags - The new learning's tags
 * @returns {string} Markdown section to append, or empty string if no related
 */
export function generateRelatedSection(slug, tags) {
  if (!tags || tags.length === 0) return "";

  const newTags = new Set(tags.map(sanitizeTag));
  const all = getAllLearnings();
  if (!all || all.length === 0) return "";

  const scored = [];
  for (const l of all) {
    if (l.slug === slug) continue;
    const existingTags = new Set((l.tags || []).map(sanitizeTag));
    if (existingTags.size === 0) continue;

    const intersection = [...newTags].filter(t => existingTags.has(t)).length;
    if (intersection === 0) continue;
    const union = new Set([...newTags, ...existingTags]).size;
    const jaccard = intersection / union;

    if (jaccard >= 0.25) {
      scored.push({ slug: l.slug, jaccard, sharedTags: intersection });
    }
  }

  if (scored.length === 0) return "";

  scored.sort((a, b) => b.jaccard - a.jaccard || b.sharedTags - a.sharedTags);
  const top = scored.slice(0, 5);

  const links = top.map(s => `- [[${s.slug}]]`).join("\n");
  return `\n\n## Related\n${links}\n`;
}

// ─── P12.1: Write-time consolidation (append-only merge) ────────────────────

const MAX_MERGE_COUNT = 5; // After 5 merges, force new note (avoid bucket notes)

/**
 * Classify whether a warn-level similarity result is safe to auto-merge.
 * Returns "merge_safe" or "warn_only".
 *
 * merge_safe criteria (conservative — requires multi-signal confirmation):
 *   1. LLM-verified + sim >= 0.55
 *   2. Embedding >= 0.82 + Jaccard >= 0.45
 *   3. Jaccard >= 0.58 + tagOverlap >= 0.50
 */
export function classifyMergeAction(similar) {
  if (!similar || similar.level !== "warn") return "warn_only";

  // Check existing note's merge_count — don't merge into bloated notes
  const meta = _readMeta();
  const existingMeta = meta?.learnings?.[similar.slug];
  if (existingMeta?.merge_count >= MAX_MERGE_COUNT) return "warn_only";

  // Criteria 1: LLM confirmed
  if (similar.source === "llm" && similar.similarity >= 0.55) return "merge_safe";

  // Criteria 2: High embedding + reasonable Jaccard (V2: relaxed, min token check)
  if (similar.embSim !== null && similar.embSim >= 0.80 && similar.similarity >= 0.42) return "merge_safe";

  // Criteria 3: Solid Jaccard + tag overlap (V2: relaxed from 0.58/0.50)
  if (similar.similarity >= 0.55 && similar.tagOverlap >= 0.40) return "merge_safe";

  return "warn_only";
}

/**
 * Append-only merge: adds new information to existing learning without rewriting.
 * Safe, reversible, no information loss risk.
 *
 * @param {string} existingSlug - slug of the existing learning
 * @param {object} incoming - { title, description, type, tags }
 * @param {object} similar - { similarity, tagOverlap, source, embSim }
 * @returns {{ success: boolean, slug: string, mergeInfo: string }}
 */
export function mergeLearningAppend(existingSlug, incoming, similar) {
  const meta = _readMeta();
  if (!meta?.learnings?.[existingSlug]) {
    return { success: false, reason: "existing learning not found in meta" };
  }

  const existingMeta = meta.learnings[existingSlug];
  const existingFile = existingMeta.file;
  const content = readFile(existingFile);
  if (!content) {
    return { success: false, reason: `file not found: ${existingFile}` };
  }

  const parsed = parseLearningFrontmatter(content);
  if (!parsed) {
    return { success: false, reason: "could not parse existing learning frontmatter" };
  }

  const fm = parsed.frontmatter;
  const today = new Date().toISOString().split("T")[0];

  // 1. Union tags (deduplicated, normalized)
  const existingTags = new Set((fm.tags || []).map(sanitizeTag));
  const incomingTags = (incoming.tags || []).map(sanitizeTag);
  const addedTags = incomingTags.filter(t => !existingTags.has(t));
  for (const t of addedTags) existingTags.add(t);

  // 2. Type precedence: principle > warning > pattern > learning
  const TYPE_RANK = { principle: 4, warning: 3, pattern: 2, learning: 1 };
  const existingRank = TYPE_RANK[fm.type] || 0;
  const incomingRank = TYPE_RANK[incoming.type] || 0;
  if (incomingRank > existingRank) {
    fm.type = incoming.type;
  }

  // 3. Build merge entry
  const mergeEntry = [
    `### ${today}`,
    `- **From:** "${incoming.title}"`,
    `- **Type:** ${incoming.type || "learning"}`,
    `- **Similarity:** ${similar.similarity?.toFixed?.(2) ?? "?"} (${similar.source || "jaccard"})`,
    `- **New info:** ${incoming.description}`,
    ...(addedTags.length ? [`- **Added tags:** ${addedTags.join(", ")}`] : []),
  ].join("\n");

  // 4. Append to body
  let body = parsed.body || "";
  if (body.includes("## Merged Updates")) {
    // Append under existing section
    body = body.trimEnd() + "\n\n" + mergeEntry;
  } else {
    body = body.trimEnd() + "\n\n## Merged Updates\n\n" + mergeEntry;
  }

  // 5. Update frontmatter
  fm.tags = [...existingTags];
  fm.last_merged = today;
  fm.merge_count = (parseInt(fm.merge_count) || 0) + 1;

  // 6. Reconstruct file (preserve YAML format from buildLearningMarkdown)
  const newContent = rebuildLearningFile(fm, body);

  // 7. Write
  writeFile(existingFile, newContent);

  // 8. Update meta
  existingMeta.hit_count = (existingMeta.hit_count || 0) + 1;
  existingMeta.last_accessed = today;
  existingMeta.tags = fm.tags;
  existingMeta.merge_count = fm.merge_count;
  _writeMeta(meta, existingSlug);
  invalidateVitalityCache(); // merge changes hit_count/last_accessed

  // 9. Invalidate caches (SQLite write hooks handle DB sync)
  setLearningsCache(null);

  return {
    success: true,
    slug: existingSlug,
    mergeCount: fm.merge_count,
    mergeInfo: `Merged into "${existingMeta.title}" (sim: ${similar.similarity?.toFixed?.(2) ?? "?"}, source: ${similar.source || "jaccard"}). Merge #${fm.merge_count}`
  };
}

/**
 * Rebuild a learning .md file from frontmatter object + body string.
 * Mirrors the format produced by buildLearningMarkdown().
 */
function rebuildLearningFile(fm, body) {
  let md = "---\n";
  // Ordered keys matching buildLearningMarkdown output
  const orderedKeys = ["title", "headline", "type", "created", "tags", "slug", "last_merged", "merge_count", "source_type", "source_session", "source_context", "created_by", "source_ref"];
  const written = new Set();

  for (const key of orderedKeys) {
    if (fm[key] === undefined) continue;
    md += formatFrontmatterField(key, fm[key]) + "\n";
    written.add(key);
  }
  // Write any extra keys not in orderedKeys
  for (const [key, value] of Object.entries(fm)) {
    if (written.has(key)) continue;
    md += formatFrontmatterField(key, value) + "\n";
  }

  md += "---\n\n";
  md += body + "\n";
  return md;
}

function formatFrontmatterField(key, value) {
  if (key === "tags" && Array.isArray(value)) {
    return `tags: [${value.join(", ")}]`;
  }
  if (typeof value === "string" && (value.includes('"') || value.includes(":") || value.includes("#"))) {
    return `${key}: "${value.replace(/"/g, '\\"')}"`;
  }
  if (typeof value === "string" && key === "title") {
    return `${key}: "${value.replace(/"/g, '\\"')}"`;
  }
  if (typeof value === "string" && key === "headline") {
    return `${key}: "${value.replace(/"/g, '\\"')}"`;
  }
  return `${key}: ${value}`;
}
