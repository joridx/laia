/**
 * Multi-signal scored search for LAIA Brain.
 * Combines learnings search (with RRF + intent + BM25) and file search (sessions/knowledge).
 */

import * as fs from "fs";
import * as path from "path";
import { BRAIN_PATH, LEARNINGS_DIR } from "./config.js";
import { readFile, readJSON, getCachedFiles } from "./file-io.js";
import { tokenize, parseLearningFrontmatter } from "./utils.js";
import { stem } from "./semantic.js";
import {
  classifyIntent, INTENT_WEIGHTS, INTENT_SCOPE_BOOST,
  scoreLearning, scoreFile, fuseRRF, TYPE_PRIOR, getTypePrior
} from "./scoring.js";
import { getAllLearnings, computeAllVitalities } from "./learnings.js";
import { filterByDateRange, extractSessionDate } from "./temporal.js";
import { expandQueryTokensWithGraph, getPageRankMap, getActivationMap } from "./graph.js";
import { getOrBuildIndex } from "./semantic.js";
import { isDbAvailable, searchLearningsFts, searchFilesFts, loadAllEmbeddings, metaRepo } from "./database.js";
import {
  isEmbeddingsAvailable, embedText, cosineSimilarity, findTopK,
  buildEmbeddingText, computeEmbeddingHash, blobToEmbedding
} from "./embeddings.js";
import { signalEnabled, getEnabledSignals } from "./signal-config.js";

// In-memory embedding cache (loaded from SQLite once, updated on remember)
let _embeddingMap = null; // Map<slug, Float32Array>
let _embeddingMapLoaded = false;

function getEmbeddingMap() {
  if (_embeddingMapLoaded) return _embeddingMap;
  _embeddingMapLoaded = true;
  const dbData = loadAllEmbeddings();
  if (!dbData || dbData.size === 0) { _embeddingMap = null; return null; }
  _embeddingMap = new Map();
  for (const [slug, data] of dbData) {
    try {
      _embeddingMap.set(slug, blobToEmbedding(data.embedding));
    } catch { /* skip corrupt entries */ }
  }
  return _embeddingMap;
}

/** Invalidate cached embedding map (call when embeddings are updated). */
export function invalidateEmbeddingCache() {
  _embeddingMap = null;
  _embeddingMapLoaded = false;
}

/** Update a single entry in the in-memory cache (call after embedding a new learning). */
export function updateEmbeddingCacheEntry(slug, embedding) {
  if (!_embeddingMap) _embeddingMap = new Map();
  _embeddingMapLoaded = true;
  _embeddingMap.set(slug, embedding);
}

// ─── Perf #5: Cached archive scan ────────────────────────────────────────────
// Archived learnings rarely change. Cache the parsed list with a 5-minute TTL
// to avoid sync I/O (existsSync, readdirSync, statSync, readFile) on every search.

let _archiveCache = null;
let _archiveCacheTime = 0;
const ARCHIVE_TTL = 300_000; // 5 minutes

function _getCachedArchive() {
  const now = Date.now();
  if (_archiveCache && (now - _archiveCacheTime) < ARCHIVE_TTL) {
    return _archiveCache;
  }

  const result = [];
  const archiveDir = path.join(BRAIN_PATH, LEARNINGS_DIR, "_archive");
  try {
    if (!fs.existsSync(archiveDir)) {
      _archiveCache = result;
      _archiveCacheTime = now;
      return result;
    }
    for (const backupEntry of fs.readdirSync(archiveDir)) {
      const backupPath = path.join(archiveDir, backupEntry);
      if (!fs.statSync(backupPath).isDirectory() || !backupEntry.startsWith("_backup_")) continue;
      for (const f of fs.readdirSync(backupPath)) {
        if (!f.endsWith(".md")) continue;
        const slug = f.replace(".md", "");
        const content = readFile(`${LEARNINGS_DIR}/_archive/${backupEntry}/${f}`);
        const parsed = parseLearningFrontmatter(content);
        if (!parsed) continue;
        result.push({ file: `${LEARNINGS_DIR}/_archive/${backupEntry}/${f}`, slug, ...parsed.frontmatter, body: parsed.body, archived: true });
      }
    }
  } catch (e) {
    // If archive dir has issues, return empty (don't crash search)
    if (e.code !== 'ENOENT') console.error(`[search] archive scan error: ${e.message}`);
  }

  _archiveCache = result;
  _archiveCacheTime = now;
  return result;
}

/** Invalidate archive cache (call after archive/prune operations). */
export function invalidateArchiveCache() {
  _archiveCache = null;
  _archiveCacheTime = 0;
}

// Perf E1: Iterative max — avoids stack overflow with large collections (Math.max(...spread) limit ~65k)
function iterMax(iterable, fallback = 0) {
  let max = fallback;
  for (const v of iterable) {
    if (v > max) max = v;
  }
  return max;
}


export async function scoredSearch(query, scope = "all", activeProject = null, showAll = false, { limit = 0, offset = 0, agentContext = null, since = null, until = null, totalQueries = 0 } = {}) {
  const _t0 = performance.now();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { learnings: [], files: [], graphExpanded: [], intent: null, timing: {} };

  const intent = classifyIntent(query);
  const intentWeights = INTENT_WEIGHTS[intent.intent];
  const scopeBoost = INTENT_SCOPE_BOOST[intent.intent];

  // P4.4 + P4.6: Combine PageRank and Spreading Activation [hibernatable: graph]
  let graphTokens = [];
  let conceptMap = new Map();
  if (signalEnabled("graph")) {
    const pageRankMap = getPageRankMap();
    const activationMap = getActivationMap();
    conceptMap = new Map(pageRankMap);
    if (activationMap.size > 0) {
      for (const [concept, activation] of activationMap) {
        const pr = conceptMap.get(concept) || 0;
        conceptMap.set(concept, pr + activation * 0.3);
      }
    }
    graphTokens = expandQueryTokensWithGraph(queryTokens, conceptMap).expanded;
  }
  const _tGraph = performance.now();

  // P14.1: Read meta from SQLite (30× faster than JSON parse)
  const _metaAll = metaRepo.getAll();
  const meta = _metaAll ? { learnings: _metaAll } : readJSON("learnings-meta.json");
  const scoredLearnings = [];
  const scoredFiles = [];

  // Perf E2: pass meta to avoid duplicate metaRepo.getAll() in fallback path [hibernatable: freshness]
  const vitalityMap = signalEnabled("freshness") ? computeAllVitalities({ meta }) : new Map();
  const _tVitality = performance.now();

  // ─── BM25 scores: FTS5 (P4.1) with in-memory fallback [hibernatable: bm25] ───
  const allLearnings = (scope === "all" || scope === "learnings") ? getAllLearnings() : [];

  let bm25Scores = new Map();

  if (signalEnabled("bm25")) {
    const useFts5 = isDbAvailable();

    if (useFts5) {
      // FTS5 path: query SQLite for BM25 scores (no need to load all files into memory)
      const ftsLearnings = searchLearningsFts(queryTokens, { limit: 200, includeArchived: true });
      if (ftsLearnings && ftsLearnings.length > 0) {
        // Normalize: FTS5 BM25 can return negative scores for low-relevance matches.
        // Shift all scores so the minimum becomes 0.1 (any FTS5 hit is a signal).
        const minScore = Math.min(...ftsLearnings.map(r => r.bm25Score));
        const shift = minScore < 0 ? Math.abs(minScore) + 0.1 : 0;
        for (const r of ftsLearnings) {
          bm25Scores.set(`learning:${r.slug}`, r.bm25Score + shift);
        }
      }
      const ftsScope = scope === "sessions" ? "sessions" : scope === "knowledge" ? "knowledge" : scope === "notes" ? "notes" : "all";
      const ftsFiles = searchFilesFts(queryTokens, { limit: 100, scope: ftsScope });
      if (ftsFiles && ftsFiles.length > 0) {
        const minFileScore = Math.min(...ftsFiles.map(r => r.bm25Score));
        const fileShift = minFileScore < 0 ? Math.abs(minFileScore) + 0.1 : 0;
        for (const r of ftsFiles) {
          bm25Scores.set(`file:${r.relPath}`, r.bm25Score + fileShift);
        }
      }
    } else {
      // Fallback: in-memory BM25 index (needs all files loaded)
      const allCachedFiles = [];
      const fileDirs = [];
      if (scope === "all" || scope === "sessions") fileDirs.push("memory/sessions");
      if (scope === "all" || scope === "knowledge") fileDirs.push("knowledge");
      if (scope === "all" || scope === "notes") fileDirs.push("memory/notes");
      for (const dir of fileDirs) {
        allCachedFiles.push(...getCachedFiles(dir));
      }
      const bm25Index = getOrBuildIndex(allLearnings, allCachedFiles);
      bm25Scores = bm25Index.search(queryTokens);
    }
  }
  const _tBM25 = performance.now();

  // ─── Embedding scores (P9.2) [hibernatable: embedding] ───────────────────
  let embeddingScores = null; // Map<slug, similarity>
  if (signalEnabled("embedding") && isEmbeddingsAvailable() && (scope === "all" || scope === "learnings")) {
    const embMap = getEmbeddingMap();
    if (embMap && embMap.size > 0) {
      const queryEmb = await embedText(query);
      if (queryEmb) {
        embeddingScores = new Map();
        const topK = findTopK(queryEmb, embMap, 100);
        for (const { slug, similarity } of topK) {
          embeddingScores.set(slug, similarity);
        }
      }
    }
  }

  // Precompute global max BM25 once (used by rescue logic for both learnings and files)
  const globalMaxBm25 = iterMax(bm25Scores.values(), 0);

  // ─── 1. Scored search in learnings ─────────────────────────────────────────
  if (scope === "all" || scope === "learnings") {

    // Perf #6: Build candidate whitelist from fast signals (respects signal config)
    // Only learnings in this set go through full scoring.
    // showAll bypasses the whitelist (needs all learnings).
    let candidateSet = null;
    if (!showAll) {
      candidateSet = new Set();

      // 6a. BM25 candidates [hibernatable: bm25]
      if (signalEnabled("bm25")) {
        for (const [key] of bm25Scores) {
          if (key.startsWith('learning:')) candidateSet.add(key.slice(9));
        }
      }

      // 6b. Embedding candidates [hibernatable: embedding]
      if (signalEnabled("embedding") && embeddingScores) {
        for (const [slug] of embeddingScores) candidateSet.add(slug);
      }

      // 6c+6d+6e. Single pass over allLearnings for tag/project/graph candidates
      // Stem-aware: expand query tokens with stems + prefix matching
      const queryTokenLower = new Set(queryTokens.map(t => t.toLowerCase()));
      // Add stemmed variants to query set for candidate matching
      for (const t of [...queryTokenLower]) {
        const s = stem(t);
        if (s && s !== t && s.length >= 3) queryTokenLower.add(s);
      }
      // Prefix-match helper: checks if any queryToken/stem is prefix of tag or vice versa (min 5 chars)
      const stemPrefixMatch = (tag) => {
        for (const qt of queryTokenLower) {
          if (tag === qt) return true;
          const shorter = qt.length <= tag.length ? qt : tag;
          const longer = qt.length <= tag.length ? tag : qt;
          if (shorter.length >= 5 && longer.startsWith(shorter)) return true;
        }
        return false;
      };
      const pSlug = (signalEnabled("project") && activeProject) ? activeProject.toLowerCase() : null;
      const graphSet = (signalEnabled("graph") && graphTokens.length > 0) ? new Set(graphTokens) : null;
      for (const l of allLearnings) {
        if (candidateSet.has(l.slug)) continue; // already a candidate
        const lTags = (l.tags || []).map(t => t.toLowerCase());
        // Expand learning tags with stems too
        const lTagsExpanded = new Set(lTags);
        for (const t of lTags) {
          const s = stem(t);
          if (s && s !== t && s.length >= 3) lTagsExpanded.add(s);
        }
        if ([...lTagsExpanded].some(t => stemPrefixMatch(t))  // 6c: tag match (stem + prefix-aware)
            || (pSlug && lTags.includes(pSlug))             // 6d: project match [hibernatable]
            || (graphSet && [...lTagsExpanded].some(t => graphSet.has(t))) // 6e: graph match [hibernatable]
        ) {
          candidateSet.add(l.slug);
        }

        // 6f: bridge connects match [hibernatable: bridge]
        if (signalEnabled("bridge") && l.type === 'bridge' && Array.isArray(l.connects) && l.connects.length > 0) {
          const connectTokens = l.connects.map(c => c.toLowerCase());
          if (connectTokens.some(c => queryTokenLower.has(c))) {
            candidateSet.add(l.slug);
          }
        }
      }

      // Adaptive fallback: if whitelist covers >80% of total, skip it (overhead > benefit)
      if (candidateSet.size > allLearnings.length * 0.8) {
        candidateSet = null;
      }
    }
    const _tWhitelist = performance.now();


    for (const l of allLearnings) {
      // P14.3: Skip superseded learnings by default
      if (!showAll && meta?.learnings?.[l.slug]?.superseded_by) continue;

      // Perf #6: Skip learnings not in candidate whitelist
      if (candidateSet && !candidateSet.has(l.slug)) continue;

      const result = scoreLearning(l, queryTokens, meta, activeProject, graphTokens, showAll, intentWeights, vitalityMap, conceptMap);
      if (result) {
        // Inject BM25 score (only when signal active)
        if (signalEnabled("bm25")) {
          const bm25Score = bm25Scores.get(`learning:${l.slug}`) || 0;
          result.rawScores.bm25 = +bm25Score.toFixed(3);
          if (bm25Score > 0) result.signals.bm25 = +bm25Score.toFixed(2);
        }

        // Inject embedding score (P9.2, only when signal active)
        if (signalEnabled("embedding")) {
          const embScore = embeddingScores?.get(l.slug) || 0;
          result.rawScores.embedding = +embScore.toFixed(4);
          if (embScore > 0.1) { result.signals.embedding = +embScore.toFixed(2); result.activeSignals++; }
        }

        result.score = +(result.score * (scopeBoost.learnings || 1)).toFixed(2);
        scoredLearnings.push({ ...l, ...result });
      }
      // Note: BM25 rescue removed (Perf E3) — with whitelist (#6), BM25 candidates
      // are pre-included and always pass the >=2 signal gate (BM25 + vitality).
    }

    // Also search archived learnings (skip slugs already scored to prevent RRF collision)
    // Perf #5: Cache archive scan with TTL (archive rarely changes)
    const archivedLearnings = _getCachedArchive();
    if (archivedLearnings.length > 0) {
      const scoredSlugs = new Set(scoredLearnings.map(l => l.slug));
      for (const l of archivedLearnings) {
        if (scoredSlugs.has(l.slug)) continue; // active version already scored
        const result = scoreLearning(l, queryTokens, meta, activeProject, graphTokens, showAll, intentWeights, vitalityMap, conceptMap);
        if (result) {
          // Enrich archived learnings with BM25 + embedding scores (only when signals active)
          if (signalEnabled("bm25")) {
            const bm25Score = bm25Scores.get(`learning:${l.slug}`) || 0;
            result.rawScores.bm25 = +bm25Score.toFixed(3);
            if (bm25Score > 0) result.signals.bm25 = +bm25Score.toFixed(2);
          }
          if (signalEnabled("embedding")) {
            const embScore = embeddingScores?.get(l.slug) || 0;
            result.rawScores.embedding = +embScore.toFixed(4);
            if (embScore > 0.1) { result.signals.embedding = +embScore.toFixed(2); result.activeSignals++; }
          }

          result.score = +(result.score * (scopeBoost.learnings || 1)).toFixed(2);
          scoredLearnings.push({ ...l, ...result });
        }
      }
    }
  }

  // ─── RRF fusion (now includes bm25 signal) ────────────────────────────────
  if (scoredLearnings.length > 1) {
    const signalNames = getEnabledSignals();
    const signalRankings = signalNames.map(name => {
      const scores = new Map();
      for (const l of scoredLearnings) {
        scores.set(l.slug, l.rawScores?.[name] || 0);
      }
      return { name, scores };
    });

    const fusedScores = fuseRRF(signalRankings, intentWeights);

    const maxFused = iterMax(fusedScores.values(), 0) || 1;
    let maxOriginal = 0;
    for (const l of scoredLearnings) { if (l.score > maxOriginal) maxOriginal = l.score; }
    maxOriginal = maxOriginal || 1;
    const scale = maxOriginal / maxFused;

    for (const l of scoredLearnings) {
      const rrfScore = fusedScores.get(l.slug) || 0;
      l.rrfRaw = +rrfScore.toFixed(4);
      l.score = +(rrfScore * scale).toFixed(2);
    }
  }

  // P7.4 + P12.3 + P12.5: Apply type prior boost (dynamic for principles, with dominance penalty)
  for (const l of scoredLearnings) {
    const learningMeta = meta?.learnings?.[l.slug];
    const prior = getTypePrior(l.type, learningMeta, totalQueries);
    if (prior !== 1.0) l.score = +(l.score * prior).toFixed(2);
  }

  // V2b: Agent context boost — boost learnings tagged with agent:<profile>
  if (agentContext) {
    const agentTag = `agent:${agentContext}`.toLowerCase();
    for (const l of scoredLearnings) {
      const lTags = (l.tags || []).map(t => t.toLowerCase());
      if (lTags.includes(agentTag)) {
        l.score = +(l.score + 0.15).toFixed(2);
        l.agentBoosted = true;
      }
    }
  }

  scoredLearnings.sort((a, b) => b.score - a.score);

  // Zero-result diagnostic logging (search-refactor-spec.md §4)
  // Logs queries that return 0 results for monitoring whether quarantined signals should be re-evaluated.
  if (scoredLearnings.length === 0 && (scope === "all" || scope === "learnings")) {
    console.warn(`[search] zero-results: query="${query}" tokens=${queryTokens.join(",")} scope=${scope}`);
  }

  // ─── Temporal filter (learnings) ──────────────────────────────────────────
  if (since || until) {
    const metaLearnings = meta?.learnings || {};

    const filtered = filterByDateRange(scoredLearnings, l => {
      const m = metaLearnings[l.slug];
      return m?.created_date || null;
    }, since, until);
    const preFilterCount = scoredLearnings.length;
    scoredLearnings.length = 0;
    scoredLearnings.push(...filtered);

    // Post-temporal-filter zero-result diagnostic (Codex review feedback)
    if (scoredLearnings.length === 0 && preFilterCount > 0) {
      console.warn(`[search] zero-results-post-filter: query="${query}" preFilter=${preFilterCount} since=${since || ""} until=${until || ""}`);
    }
  }
  const _tLearnings = performance.now();

  // ─── 2. Scored search in files (sessions, knowledge) ──────────────────────
  const dirs = [];
  if (scope === "all" || scope === "sessions") dirs.push({ dir: "memory/sessions", boost: scopeBoost.sessions || 1 });
  if (scope === "all" || scope === "knowledge") dirs.push({ dir: "knowledge", boost: scopeBoost.knowledge || 1 });
  if (scope === "all" || scope === "notes") dirs.push({ dir: "memory/notes", boost: scopeBoost.notes || 0.8 });

  for (const { dir, boost } of dirs) {
    const cachedFiles = getCachedFiles(dir);
    for (const { relPath, content } of cachedFiles) {
      const result = scoreFile(relPath, content, queryTokens, graphTokens, showAll, conceptMap);
      if (result) {
        // Boost file score with BM25 (only when signal active)
        if (signalEnabled("bm25")) {
          const bm25Score = bm25Scores.get(`file:${relPath}`) || 0;
          if (bm25Score > 0) {
            result.score += +(bm25Score * 1.5).toFixed(2);
            result.bm25 = +bm25Score.toFixed(2);
          }
        }
        result.score = +(result.score * boost).toFixed(2);
        scoredFiles.push(result);
      } else if (!showAll && signalEnabled("bm25")) {
        // BM25 rescue for files: if keyword scoring rejected but BM25 found it
        const bm25Score = bm25Scores.get(`file:${relPath}`) || 0;
        if (bm25Score > 0 && bm25Score >= globalMaxBm25 * 0.3) {
          scoredFiles.push({
            file: relPath,
            score: +(bm25Score * 1.5 * boost).toFixed(2),
            snippets: [],
            bm25: +bm25Score.toFixed(2),
            rescued: true
          });
        }
      }
    }
  }
  scoredFiles.sort((a, b) => b.score - a.score);

  // ─── Temporal filter (files — sessions have date in filename) ─────────────
  if (since || until) {

    const filtered = filterByDateRange(scoredFiles, f => {
      return extractSessionDate(f.file || "");
    }, since, until);
    scoredFiles.length = 0;
    scoredFiles.push(...filtered);
  }
  const _tEnd = performance.now();

  const timing = {
    total: +(_tEnd - _t0).toFixed(1),
    graph: +(_tGraph - _t0).toFixed(1),
    vitality: +(_tVitality - _tGraph).toFixed(1),
    bm25: +(_tBM25 - _tVitality).toFixed(1),
    learnings: +(_tLearnings - _tBM25).toFixed(1),
    files: +(_tEnd - _tLearnings).toFixed(1)
  };

  // ─── Pagination ─────────────────────────────────────────────────────────────
  const totalLearnings = scoredLearnings.length;
  const totalFiles = scoredFiles.length;
  const paginatedLearnings = limit > 0 ? scoredLearnings.slice(offset, offset + limit) : scoredLearnings;
  const paginatedFiles = limit > 0 ? scoredFiles.slice(offset, offset + limit) : scoredFiles;

  return {
    learnings: paginatedLearnings,
    files: paginatedFiles,
    graphExpanded: graphTokens,
    intent,
    timing,
    ...(limit > 0 ? { pagination: { limit, offset, totalLearnings, totalFiles } } : {})
  };
}
