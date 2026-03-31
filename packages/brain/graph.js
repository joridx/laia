/**
 * Knowledge graph and metrics for LAIA Brain.
 * Tag hits, concept relations, query expansion via graph neighbors.
 */

import { readJSON, writeFile, getContentGeneration, invalidateJsonCache } from "./file-io.js";
import { sanitizeTag } from "./utils.js";
import { computePageRank, computeSpreadingBoosts, decayActivation } from "./scoring.js";
import { getAllActivationsFromDb, saveActivationsToDb, metricsRepo, graphRepo } from "./database.js";

// ─── P14.1: Read helpers (SQLite primary, JSON fallback) ────────────────────

/** Read relations for read-modify-write (must use JSON — canonical write path) */
function _readRelations() {
  return readJSON("relations.json");
}

/** Read relations for read-only queries.
 *  P14.1: JSON cache is faster than SQLite for full-graph reads (~5ms vs ~15ms).
 *  SQLite graph is kept in sync via dual-write hook for future point queries.
 */
function _readRelationsReadOnly() {
  return readJSON("relations.json");
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export function recordHit(type, key) {
  // Invalidate cache to ensure fresh read after prior writes
  invalidateJsonCache("metrics.json");
  // Read from JSON first (source we write to), SQLite fallback
  const metrics = readJSON("metrics.json") || metricsRepo.getAll() || {};

  if (type === "tag") {
    metrics.tag_hits = metrics.tag_hits || {};
    metrics.tag_hits[key] = (metrics.tag_hits[key] || 0) + 1;
  } else if (type === "search") {
    metrics.search_hits = metrics.search_hits || {};
    metrics.search_hits[key] = (metrics.search_hits[key] || 0) + 1;
  }
  metrics.total_queries = (metrics.total_queries || 0) + 1;
  writeFile("metrics.json", JSON.stringify(metrics, null, 2));
  // Dual-write: sync key metrics to SQLite for read-consistency
  metricsRepo.set("tag_hits", metrics.tag_hits || {});
  metricsRepo.set("search_hits", metrics.search_hits || {});
  metricsRepo.set("total_queries", metrics.total_queries);
}

// ─── Relations ────────────────────────────────────────────────────────────────

export function getRelatedConcepts(concept) {
  const relations = _readRelationsReadOnly();
  if (!relations || !relations.concepts) return [];

  const normalized = concept.toLowerCase().replace("#", "");
  const conceptData = relations.concepts[normalized];
  if (!conceptData) return [];

  const related = [];
  if (conceptData.related_to) related.push(...conceptData.related_to);
  if (conceptData.parent) related.push(conceptData.parent);
  if (conceptData.children) related.push(...conceptData.children);

  return [...new Set(related)];
}

export function addRelation(concept, { related_to, parent, children } = {}) {
  const relations = _readRelations();
  if (!relations) return;
  if (!relations.concepts) relations.concepts = {};

  const normalized = concept.toLowerCase().replace("#", "");
  const conceptData = relations.concepts[normalized] || { related_to: [] };

  if (related_to) {
    const newRelated = related_to.map(r => r.toLowerCase().replace("#", ""));
    conceptData.related_to = [...new Set([...conceptData.related_to, ...newRelated])];
    // Ensure bidirectionality: each target also lists this concept
    for (const target of newRelated) {
      const targetData = relations.concepts[target] || { related_to: [] };
      if (!targetData.related_to.includes(normalized)) {
        targetData.related_to.push(normalized);
      }
      relations.concepts[target] = targetData;
    }
  }
  if (parent) {
    conceptData.parent = parent.toLowerCase().replace("#", "");
  }
  if (children) {
    const newChildren = children.map(c => c.toLowerCase().replace("#", ""));
    conceptData.children = [...new Set([...(conceptData.children || []), ...newChildren])];
  }

  relations.concepts[normalized] = conceptData;
  writeFile("relations.json", JSON.stringify(relations, null, 2));
}

export function addTagCooccurrenceRelations(tags) {
  if (!tags || tags.length < 2) return;
  const clean = [...new Set(tags.map(sanitizeTag))];
  if (clean.length < 2) return;

  const relations = _readRelations();
  if (!relations) return;
  if (!relations.concepts) relations.concepts = {};

  let changed = false;
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      const a = clean[i], b = clean[j];
      if (!relations.concepts[a]) relations.concepts[a] = { related_to: [] };
      if (!relations.concepts[b]) relations.concepts[b] = { related_to: [] };
      if (!relations.concepts[a].related_to.includes(b)) {
        relations.concepts[a].related_to.push(b);
        changed = true;
      }
      if (!relations.concepts[b].related_to.includes(a)) {
        relations.concepts[b].related_to.push(a);
        changed = true;
      }
    }
  }

  if (changed) {
    writeFile("relations.json", JSON.stringify(relations, null, 2));
  }
}

// ─── Bridge graph edges (P14.1) ─────────────────────────────────────────────

/**
 * Add bidirectional edges between all concepts in a bridge's connects array.
 * Each pair of concepts gets a related_to edge if not already present.
 * @param {string[]} connects - 2-5 canonical concept slugs
 */
export function addBridgeGraphEdges(connects) {
  if (!connects || connects.length < 2) return;
  const clean = [...new Set(connects.map(c => c.toLowerCase().replace("#", "")))];
  if (clean.length < 2) return;

  const relations = _readRelations();
  if (!relations) return;
  if (!relations.concepts) relations.concepts = {};

  let changed = false;
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      const a = clean[i], b = clean[j];
      if (!relations.concepts[a]) relations.concepts[a] = { related_to: [] };
      if (!relations.concepts[b]) relations.concepts[b] = { related_to: [] };
      if (!relations.concepts[a].related_to.includes(b)) {
        relations.concepts[a].related_to.push(b);
        changed = true;
      }
      if (!relations.concepts[b].related_to.includes(a)) {
        relations.concepts[b].related_to.push(a);
        changed = true;
      }
    }
  }

  if (changed) {
    writeFile("relations.json", JSON.stringify(relations, null, 2));
    invalidatePageRankCache();
  }
}

// ─── PageRank cache (P4.4) ──────────────────────────────────────────────────

let _pageRankMap = null;
let _pageRankGeneration = -1;

/**
 * Get (or compute) PageRank scores for all concepts in the knowledge graph.
 * Cached per content generation — recomputes only when relations.json changes.
 * Returns Map<concept, normalizedScore> where score is [0, 1].
 */
export function getPageRankMap() {
  const gen = getContentGeneration();
  if (_pageRankMap && _pageRankGeneration === gen) return _pageRankMap;

  const relations = _readRelationsReadOnly();
  _pageRankMap = (relations?.concepts)
    ? computePageRank(relations.concepts)
    : new Map();
  _pageRankGeneration = gen;
  return _pageRankMap;
}

export function invalidatePageRankCache() {
  _pageRankMap = null;
  _pageRankGeneration = -1;
}

// ─── Spreading Activation cache (P4.6) ──────────────────────────────────────

const HALF_LIFE_DAYS = 7;
let _activationMap = null;
let _activationCacheValid = false;

/**
 * Get current activation scores for all concepts, with time-based decay applied.
 * Cached until invalidated by spreadActivation().
 * Returns Map<concept, decayedScore> where score is (0, 1].
 */
export function getActivationMap() {
  if (_activationMap && _activationCacheValid) return _activationMap;

  _activationMap = new Map();
  const dbActivations = getAllActivationsFromDb();
  if (!dbActivations || dbActivations.size === 0) {
    _activationCacheValid = true;
    return _activationMap;
  }

  const now = Date.now();
  for (const [concept, data] of dbActivations) {
    const elapsedDays = (now - new Date(data.lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
    const decayed = decayActivation(data.activation, elapsedDays, HALF_LIFE_DAYS);
    if (decayed > 0.01) _activationMap.set(concept, decayed);
  }

  _activationCacheValid = true;
  return _activationMap;
}

export function invalidateActivationCache() {
  _activationMap = null;
  _activationCacheValid = false;
}

/**
 * Spread activation from accessed learning slugs through the knowledge graph.
 * Decay-before-accumulate: existing activations decay by elapsed time,
 * then new boosts are added, clamped to [0, 1], and persisted to SQLite.
 *
 * @param {string[]} slugs - Slugs of learnings that were accessed
 * @param {Function} getLearningTags - Function that maps slug → tags array
 */
export function spreadActivation(slugs, getLearningTags) {
  if (!slugs || slugs.length === 0) return null;

  const relations = _readRelationsReadOnly();
  if (!relations?.concepts) return null;

  // 1. Resolve slugs to seed concepts (tags)
  const seeds = new Set();
  for (const slug of slugs) {
    const tags = getLearningTags(slug);
    if (tags) {
      for (const tag of tags) seeds.add(tag.toLowerCase());
    }
  }
  if (seeds.size === 0) return null;

  // 2. Compute BFS boosts from seed concepts
  const boosts = computeSpreadingBoosts([...seeds], relations.concepts);

  // 3. Decay existing activations and accumulate new boosts
  const existing = getAllActivationsFromDb();
  const updated = new Map();
  const now = Date.now();

  if (existing) {
    for (const [concept, data] of existing) {
      const elapsedDays = (now - new Date(data.lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
      const decayed = decayActivation(data.activation, elapsedDays, HALF_LIFE_DAYS);
      if (decayed > 0.01) updated.set(concept, decayed);
    }
  }

  // Add new boosts
  let newActivations = 0;
  for (const [concept, boost] of boosts) {
    const current = updated.get(concept) || 0;
    const newVal = Math.min(1.0, current + boost);
    updated.set(concept, newVal);
    if (current === 0) newActivations++;
  }

  // 4. Persist to SQLite
  saveActivationsToDb(updated);

  // 5. Invalidate cache
  invalidateActivationCache();

  return { seeds: seeds.size, boosted: boosts.size, total: updated.size, newActivations };
}

// ─── Hierarchy from tag subsumption ───────────────────────────────────────────

/**
 * Build parent/children hierarchy from tag co-occurrence in learnings.
 * A is parent of B if ≥threshold of B's learnings also have tag A,
 * and A is strictly broader (more learnings).
 *
 * Filters: no cycles, prefer direct parents (remove transitive).
 * Writes parent/children into relations.json.
 *
 * @param {Function} getAllLearningsFn - returns [{slug, tags}...]
 * @param {number} threshold - minimum containment ratio (default 0.80)
 * @param {number} minChildCount - minimum learnings for a tag to be considered (default 3)
 * @returns {{ added, removed, pairs }} stats
 */
export function buildHierarchy(getAllLearningsFn, { threshold = 0.80, minChildCount = 3 } = {}) {
  const relations = _readRelations();
  if (!relations?.concepts) return { added: 0, removed: 0, pairs: [] };

  // 1. Build tag→learnings map from actual learning files
  const tagLearnings = new Map();
  const allLearnings = getAllLearningsFn();
  for (const { slug, tags } of allLearnings) {
    if (!tags) continue;
    for (const raw of tags) {
      const tag = sanitizeTag(raw);
      if (!tag) continue;
      if (!tagLearnings.has(tag)) tagLearnings.set(tag, new Set());
      tagLearnings.get(tag).add(slug);
    }
  }

  // 2. Find subsumption pairs
  const rawPairs = []; // [parent, child, overlap]
  const eligible = [...tagLearnings.entries()].filter(([, s]) => s.size >= minChildCount);

  for (const [child, childSet] of eligible) {
    let bestParent = null;
    let bestOverlap = 0;
    let bestParentSize = Infinity;

    for (const [parent, parentSet] of eligible) {
      if (parent === child || parentSet.size <= childSet.size) continue;
      let overlapCount = 0;
      for (const s of childSet) if (parentSet.has(s)) overlapCount++;
      const overlap = overlapCount / childSet.size;
      if (overlap >= threshold) {
        // Prefer the most specific parent (smallest that still subsumes)
        if (!bestParent || parentSet.size < bestParentSize) {
          bestParent = parent;
          bestOverlap = overlap;
          bestParentSize = parentSet.size;
        }
      }
    }

    if (bestParent) {
      rawPairs.push([bestParent, child, bestOverlap]);
    }
  }

  // 3. Clear old hierarchy
  let removed = 0;
  for (const [, data] of Object.entries(relations.concepts)) {
    if (data.parent) { delete data.parent; removed++; }
    if (data.children?.length > 0) { delete data.children; removed++; }
  }

  // 4. Write new hierarchy
  let added = 0;
  for (const [parent, child] of rawPairs) {
    const parentData = relations.concepts[parent];
    const childData = relations.concepts[child];
    if (!parentData || !childData) continue;

    childData.parent = parent;
    if (!parentData.children) parentData.children = [];
    if (!parentData.children.includes(child)) {
      parentData.children.push(child);
    }
    added++;
  }

  writeFile("relations.json", JSON.stringify(relations, null, 2));
  invalidatePageRankCache();

  return { added, removed, pairs: rawPairs.map(([p, c, o]) => `${p}>${c}(${(o * 100).toFixed(0)}%)`) };
}

// ─── Query expansion via knowledge graph ──────────────────────────────────────

/**
 * Expand query tokens with 1-hop graph neighbors.
 * P4.4: When pageRankMap is provided, neighbors are sorted by PageRank
 * (most central first) and limited to maxExpansion to reduce noise.
 */
export function expandQueryTokensWithGraph(queryTokens, pageRankMap = null, maxExpansion = 15) {
  const relations = _readRelationsReadOnly();
  if (!relations || !relations.concepts) return { original: queryTokens, expanded: [] };

  const originalSet = new Set(queryTokens);
  const expandedSet = new Set();

  for (const token of queryTokens) {
    const conceptData = relations.concepts[token];
    if (!conceptData) continue;

    const neighbors = [
      ...(conceptData.related_to || []),
      ...(conceptData.children || []),
      ...(conceptData.parent ? [conceptData.parent] : [])
    ];
    for (const neighbor of neighbors) {
      if (!originalSet.has(neighbor)) {
        expandedSet.add(neighbor);
      }
    }
  }

  let expandedArray = [...expandedSet];

  // P4.4: Sort by PageRank (most important concepts first) and limit
  if (pageRankMap && pageRankMap.size > 0) {
    expandedArray.sort((a, b) => (pageRankMap.get(b) || 0) - (pageRankMap.get(a) || 0));
  }
  if (expandedArray.length > maxExpansion) {
    expandedArray = expandedArray.slice(0, maxExpansion);
  }

  return { original: queryTokens, expanded: expandedArray };
}
