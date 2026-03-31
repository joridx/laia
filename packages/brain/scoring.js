/**
 * Scoring engine for LAIA Brain.
 * Vitality (ACT-R), Intent Classification, RRF fusion, multi-signal scoring.
 * Pure functions — no I/O, no fs, no BRAIN_PATH.
 */

import * as path from "path";
import { tokenize } from "./utils.js";
import { signalEnabled } from "./signal-config.js";
import { computeFeedbackScore } from "./feedback.js";
import { stem } from "./semantic.js";

// ─── Stem-aware matching helpers ─────────────────────────────────────────────
// Expand a list of tokens with their stemmed variants for fuzzy matching.
// Returns a Set containing both originals and stems (deduplicated).
function expandWithStems(tokens) {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const s = stem(t);
    if (s && s !== t && s.length >= 3) expanded.add(s);
  }
  return expanded;
}

// Check if two tokens match considering stems and common-prefix.
// "finances" matches "finance" because stem("finances")="financ" is prefix of "finance"
// and both share a common prefix of length >= 5.
function stemMatch(a, b) {
  if (a === b) return true;
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb) return true;
  if (sa === b || sb === a) return true;
  // Prefix match: if the shorter stem/word is a prefix of the longer one (min 5 chars)
  const shorter = sa.length <= sb.length ? sa : sb;
  const longer = sa.length <= sb.length ? sb : sa;
  if (shorter.length >= 5 && longer.startsWith(shorter)) return true;
  return false;
}

// Count how many query tokens match against target tokens.
// Uses stem + prefix matching for morphological tolerance.
function stemMatchCount(queryTokens, targetTokensArray) {
  let count = 0;
  for (const qt of queryTokens) {
    for (const tt of targetTokensArray) {
      if (stemMatch(qt, tt)) { count++; break; }
    }
  }
  return count;
}

// ─── Vitality (ACT-R cognitive model, P4.2) ──────────────────────────────────

export const VITALITY_ZONES = { active: 0.6, stale: 0.3, cold: 0.15, fading: 0.1 };

// V2: Type-aware idle decay rates (per month without hits)
export const TYPE_DECAY_RATES = {
  warning: 0.08,
  pattern: 0.05,
  learning: 0.05,
  principle: 0.02,
};

// V2: Type floors — minimum effective vitality (prevents critical knowledge from archiving)
export const TYPE_VITALITY_FLOORS = {
  principle: 0.40,
  pattern: 0.15,
  warning: 0.10,
  learning: 0.05,
};

// V2: Cold → archived transition (days idle after entering cold state)
export const COLD_TO_ARCHIVE_DAYS = 60;

/**
 * ACT-R base-level activation: B = ln(n/(1-d)) - d*ln(L)
 * Normalized to 0-1 via sigmoid.
 */
export function computeACTR(accessCount, lifetimeDays, d = 0.5) {
  // Never-accessed: time-based decay from neutral (half-life 60 days)
  if (accessCount <= 0) {
    if (lifetimeDays <= 0) return 0.5;
    return 0.5 * Math.exp(-Math.LN2 * lifetimeDays / 60);
  }
  if (lifetimeDays <= 0) return 1.0;
  const dc = Math.max(0.01, Math.min(d, 0.99));
  const B = Math.log(accessCount / (1 - dc)) - dc * Math.log(lifetimeDays);
  return 1 / (1 + Math.exp(-B));
}

/**
 * Structural boost from incoming graph links.
 * Each link adds ~10% stability, capped at 2x.
 */
export function computeStructuralBoost(inDegree) {
  return 1 + 0.1 * Math.min(inDegree, 10);
}

/**
 * Access frequency saturation with diminishing returns.
 * 10 accesses -> ~63%, 20 -> ~86%, 30 -> ~95%.
 */
export function computeAccessSaturation(accessCount, k = 10) {
  if (accessCount <= 0) return 0;
  return 1 - Math.exp(-accessCount / k);
}

/**
 * Classify vitality score into a zone.
 * V2: Added 'cold' zone between stale and fading.
 */
export function classifyVitalityZone(vitality, isArchived = false) {
  if (isArchived) return "archived";
  if (vitality >= VITALITY_ZONES.active) return "active";
  if (vitality >= VITALITY_ZONES.stale) return "stale";
  if (vitality >= VITALITY_ZONES.cold) return "cold";
  if (vitality >= VITALITY_ZONES.fading) return "fading";
  return "archived";
}

// ─── PageRank (P4.4) ─────────────────────────────────────────────────────────

/**
 * PageRank power iteration over the knowledge graph.
 * Input: concepts object from relations.json
 *   { "node": { related_to: [...], children: [...], parent: "..." } }
 * Output: Map<concept, normalizedScore> where score is [0, 1] (min-max normalized).
 * Pure function — no I/O.
 */
export function computePageRank(concepts, { damping = 0.85, iterations = 30, tolerance = 1e-6 } = {}) {
  if (!concepts || typeof concepts !== "object") return new Map();

  // Build adjacency: outDegree and inbound lists
  const outDegree = new Map();
  const inbound = new Map();   // node → [sources]
  const nodes = new Set();

  for (const [name, data] of Object.entries(concepts)) {
    nodes.add(name);
    const targets = [
      ...(data.related_to || []),
      ...(data.children || []),
      ...(data.parent ? [data.parent] : [])
    ];
    for (const t of targets) nodes.add(t);
    outDegree.set(name, (outDegree.get(name) || 0) + targets.length);
    for (const t of targets) {
      if (!inbound.has(t)) inbound.set(t, []);
      inbound.get(t).push(name);
    }
  }

  const nodeArray = [...nodes];
  const N = nodeArray.length;
  if (N === 0) return new Map();

  // Initialize uniformly
  let pr = new Map();
  for (const node of nodeArray) pr.set(node, 1 / N);

  // Power iteration
  const base = (1 - damping) / N;
  for (let iter = 0; iter < iterations; iter++) {
    const newPr = new Map();
    let diff = 0;
    for (const node of nodeArray) {
      let sum = 0;
      for (const src of (inbound.get(node) || [])) {
        const srcOut = outDegree.get(src) || 1;
        sum += (pr.get(src) || 0) / srcOut;
      }
      const val = base + damping * sum;
      newPr.set(node, val);
      diff += Math.abs(val - (pr.get(node) || 0));
    }
    pr = newPr;
    if (diff < tolerance) break;
  }

  // Normalize to [0, 1] (min-max)
  const values = [...pr.values()];
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal;

  if (range < 1e-12) {
    // All nodes have same rank — return uniform 0.5
    const uniform = new Map();
    for (const node of nodeArray) uniform.set(node, 0.5);
    return uniform;
  }

  const normalized = new Map();
  for (const [node, val] of pr) {
    normalized.set(node, (val - minVal) / range);
  }
  return normalized;
}

/**
 * Structural boost from PageRank centrality (P4.4).
 * Maps centrality [0, 1] to boost [1.0, 2.0], same range as computeStructuralBoost.
 */
export function computeStructuralBoostPR(centrality) {
  return 1 + Math.max(0, Math.min(centrality, 1));
}

// ─── Spreading Activation (P4.6) ────────────────────────────────────────────

/**
 * BFS spreading activation from seed concepts through the knowledge graph.
 * Each hop multiplies the boost by damping factor (0.6).
 * Returns Map<concept, boost> where boost is [0, 1].
 * Pure function — no I/O.
 */
export function computeSpreadingBoosts(seeds, concepts, { damping = 0.6, maxHops = 2 } = {}) {
  if (!seeds || seeds.length === 0 || !concepts) return new Map();

  const boosts = new Map();
  let frontier = new Set(seeds.filter(s => s));

  for (let hop = 0; hop <= maxHops; hop++) {
    const hopBoost = Math.pow(damping, hop);
    const nextFrontier = new Set();

    for (const concept of frontier) {
      const current = boosts.get(concept) || 0;
      boosts.set(concept, Math.min(1.0, current + hopBoost));

      if (hop < maxHops) {
        const data = concepts[concept];
        if (!data) continue;
        const neighbors = [
          ...(data.related_to || []),
          ...(data.children || []),
          ...(data.parent ? [data.parent] : [])
        ];
        for (const n of neighbors) {
          if (!boosts.has(n)) nextFrontier.add(n);
        }
      }
    }
    frontier = nextFrontier;
  }

  return boosts;
}

/**
 * Decay an activation value based on elapsed time and half-life.
 * Pure function.
 */
export function decayActivation(activation, elapsedDays, halfLifeDays = 7) {
  if (activation <= 0 || elapsedDays <= 0) return activation;
  return activation * Math.exp(-Math.LN2 * elapsedDays / halfLifeDays);
}

// ─── Intent Classification (P4.5) ───────────────────────────────────────────

export const INTENT_PATTERNS = {
  procedural: [/how\s+to/i, /steps?\s+for/i, /guide\s+to/i, /tutorial/i, /setup/i, /configure/i, /install/i, /implementar/i, /com\s+fer/i],
  episodic: [/when\s+did/i, /what\s+happened/i, /yesterday/i, /last\s+(week|session|time)/i, /history/i, /què\s+va\s+passar/i, /quan/i],
  decision: [/why\s+did/i, /alternative/i, /trade-?off/i, /should\s+(we|i)/i, /compare/i, /vs\.?$/i, /per\s+què/i, /decidir/i]
};

export const DEFAULT_SIGNAL_WEIGHTS = { tags: 3, title: 4, keywords: 2, project: 2, graph: 1.5, freshness: 2, bm25: 2.5, embedding: 1.8, bridge: 3, feedback: 1 };

export const INTENT_WEIGHTS = {
  procedural: { tags: 3.5, title: 4, keywords: 3, project: 2, graph: 1.5, freshness: 1.5, bm25: 3, embedding: 1.5, bridge: 3, feedback: 1 },
  episodic:   { tags: 2, title: 3, keywords: 2, project: 3, graph: 1, freshness: 4, bm25: 2, embedding: 1.5, bridge: 2, feedback: 0.75 },
  decision:   { tags: 3, title: 4.5, keywords: 3, project: 2, graph: 2, freshness: 1.5, bm25: 3, embedding: 2.0, bridge: 3, feedback: 1 },
  semantic:   DEFAULT_SIGNAL_WEIGHTS
};

export const INTENT_SCOPE_BOOST = {
  procedural: { learnings: 1.2, sessions: 0.8, knowledge: 1.0 },
  episodic:   { learnings: 0.7, sessions: 1.5, knowledge: 0.8 },
  decision:   { learnings: 1.0, sessions: 0.8, knowledge: 1.3 },
  semantic:   { learnings: 1.0, sessions: 1.0, knowledge: 1.0 }
};

export function classifyIntent(query) {
  const scores = { procedural: 0, episodic: 0, decision: 0 };

  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(query)) scores[intent]++;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best[1] >= 2) return { intent: best[0], confidence: "high", matches: best[1] };
  if (best[1] === 1) return { intent: best[0], confidence: "medium", matches: 1 };
  return { intent: "semantic", confidence: "low", matches: 0 };
}

// ─── Reciprocal Rank Fusion (P4.3) ──────────────────────────────────────────

export const RRF_K = 60;

export function fuseRRF(signalRankings, weights) {
  const rankedLists = signalRankings.map(s => {
    const sorted = [...s.scores.entries()]
      .filter(([_, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const rankMap = new Map();
    sorted.forEach(([slug], idx) => rankMap.set(slug, idx));
    return { name: s.name, rankMap, size: sorted.length };
  });

  const allSlugs = new Set();
  for (const rl of rankedLists) {
    for (const slug of rl.rankMap.keys()) allSlugs.add(slug);
  }

  // Precompute signal scores by name for O(1) lookup (avoids .find() in inner loop)
  const scoresByName = new Map(signalRankings.map(s => [s.name, s.scores]));

  const fused = new Map();
  for (const slug of allSlugs) {
    let score = 0;
    for (const rl of rankedLists) {
      const rank = rl.rankMap.get(slug);
      if (rank !== undefined) {
        const w = weights[rl.name] || 1;
        const signalScore = scoresByName.get(rl.name)?.get(slug) || 0;
        score += w * signalScore / (RRF_K + rank + 1);
      }
    }
    fused.set(slug, score);
  }

  return fused;
}

// ─── Type Prior (P7.4 Principle nodes + P12.3 Confirmation scoring) ─────────

export const TYPE_PRIOR = { principle: 1.15, pattern: 1.05, warning: 1.0, learning: 1.0 };

// P12.5: Dominance penalty tunables
const DOMINANCE_THRESHOLD = 0.25;  // fraction of total queries above which penalty kicks in
const DOMINANCE_SLOPE = 1.0;       // penalty per unit of excess dominance
const DOMINANCE_FLOOR = 0.80;      // minimum multiplier even at extreme dominance
const DOMINANCE_MIN_QUERIES = 30;  // require at least this many queries for statistical stability

/**
 * Dynamic type prior for search scoring.
 * Principles get a boost that grows with confirmation count (saturating curve).
 * Other types use static TYPE_PRIOR values.
 *
 * P12.3 formula: 1.15 + 0.20 × (1 - e^(-confirmations/4))
 *   0 confirmations → 1.15 (base)
 *   2 confirmations → 1.178
 *   5 confirmations → 1.286
 *  10 confirmations → 1.337
 *  20 confirmations → 1.349 (asymptote ≈ 1.35)
 *
 * P12.5 Dominance penalty: if a principle appears in > DOMINANCE_THRESHOLD of all queries,
 * apply a soft penalty to prevent dogmatic dominance.
 * penalty = (dominance - threshold) × slope, capped so boost never falls below DOMINANCE_FLOOR.
 * Example at baseBoost=1.15: dominance 30% → 1.10, 50% → 0.90, 70% → capped 0.80.
 * Requires ≥ DOMINANCE_MIN_QUERIES for statistical stability.
 *
 * @param {string} type - learning type
 * @param {object} [learningMeta] - meta entry from learnings-meta.json
 * @param {number} [totalQueries] - total queries from metrics.json (for dominance calc)
 * @returns {number} multiplier
 */
export function getTypePrior(type, learningMeta, totalQueries = 0) {
  if (type === "principle") {
    const raw = learningMeta?.confirmation_count;
    const c = Math.max(0, Number.isFinite(raw) ? raw : (Number.isFinite(Number(raw)) ? Number(raw) : 0));
    const baseBoost = 1.15 + 0.20 * (1 - Math.exp(-c / 4));

    // P12.5: Dominance penalty — prevents over-exposed principles from dominating
    if (totalQueries >= DOMINANCE_MIN_QUERIES) {
      const rawApp = learningMeta?.search_appearances;
      const appearances = Math.max(0, Number.isFinite(rawApp) ? rawApp : (Number.isFinite(Number(rawApp)) ? Number(rawApp) : 0));
      const dominance = Math.min(1, appearances / totalQueries);
      if (dominance > DOMINANCE_THRESHOLD) {
        const penalty = (dominance - DOMINANCE_THRESHOLD) * DOMINANCE_SLOPE;
        return +Math.max(DOMINANCE_FLOOR, baseBoost - penalty).toFixed(4);
      }
    }

    return +baseBoost.toFixed(4);
  }
  return TYPE_PRIOR[type] || 1.0;
}

// ─── Multi-signal scoring (P2.1 + P4.3 RRF + P4.5 Intent) ──────────────────

export function scoreLearning(learning, queryTokens, meta, activeProject, graphTokens = [], showAll = false, intentWeights = null, vitalityMap = null, pageRankMap = null) {
  const signals = {};
  const rawScores = {};

  // S1: Tag match (stem-aware: "finances" matches tag "finance")
  const lTags = (learning.tags || []).map(t => t.toLowerCase());
  const tagMatchCnt = stemMatchCount(queryTokens, lTags);
  rawScores.tags = tagMatchCnt;
  if (tagMatchCnt > 0) signals.tags = tagMatchCnt;

  // S2: Title/headline match (stem-aware)
  const titleTokens = tokenize((learning.title || "") + " " + (learning.headline || ""));
  const titleMatchCnt = stemMatchCount(queryTokens, titleTokens);
  rawScores.title = titleMatchCnt;
  if (titleMatchCnt > 0) signals.title = titleMatchCnt;

  // S3: Keyword match (body, stem-aware)
  const bodyTokens = tokenize(learning.body || "");
  const bodyMatchCnt = stemMatchCount(queryTokens, bodyTokens);
  rawScores.keywords = bodyMatchCnt;
  if (bodyMatchCnt > 0) signals.keywords = bodyMatchCnt;

  // S4: Project match [hibernatable]
  rawScores.project = 0;
  if (signalEnabled("project") && activeProject) {
    const pSlug = activeProject.toLowerCase();
    if (lTags.includes(pSlug)) { signals.project = 1; rawScores.project = 1; }
  }

  // S5: Graph expansion match (P2.3 + P4.4 PageRank weighting) [hibernatable]
  rawScores.graph = 0;
  if (signalEnabled("graph") && graphTokens.length > 0) {
    const allText = [...lTags, ...titleTokens, ...bodyTokens];
    const graphMatches = graphTokens.filter(t => allText.includes(t));
    if (graphMatches.length > 0) {
      if (pageRankMap && pageRankMap.size > 0) {
        // P4.4: Weight each match by 0.5 base + its PageRank (0-1)
        rawScores.graph = graphMatches.reduce((sum, t) => sum + 0.5 + (pageRankMap.get(t) || 0), 0);
      } else {
        rawScores.graph = graphMatches.length;
      }
      signals.graph = +rawScores.graph.toFixed(2);
    }
  }

  // S6: Vitality — ACT-R cognitive model (P4.2, replaces P3.1 freshness) [hibernatable]
  if (signalEnabled("freshness")) {
    const vitalityData = vitalityMap?.get(learning.slug);
    const vitality = vitalityData?.vitality ?? 0.5;
    rawScores.freshness = vitality;
    signals.vitality = +vitality.toFixed(2);
    if (vitalityData?.zone) signals.zone = vitalityData.zone;
  }

  // S7: Bridge connects boost (P14.1) [hibernatable]
  rawScores.bridge = 0;
  if (signalEnabled("bridge") && learning.type === "bridge" && Array.isArray(learning.connects) && learning.connects.length > 0) {
    const connectTokens = learning.connects.map(c => c.toLowerCase());
    const bridgeMatches = queryTokens.filter(t => connectTokens.includes(t));
    if (bridgeMatches.length > 0) {
      rawScores.bridge = bridgeMatches.length * 1.5; // bridge connections are high-signal
      signals.bridge = bridgeMatches.length;
    }
  }

  // S8: Feedback signal (P15.2) — Bayesian hit-rate from implicit usage feedback
  rawScores.feedback = 0;
  if (signalEnabled("feedback") && meta?.learnings) {
    const metaEntry = meta.learnings[learning.slug];
    const fbScore = computeFeedbackScore(metaEntry);
    rawScores.feedback = +fbScore.toFixed(3);
    if (fbScore !== 0.5) signals.feedback = +fbScore.toFixed(2); // Only show if non-neutral
  }

  // S9: Procedure trigger_intents match (V4 Sprint 1A)
  // Boosts procedures whose trigger_intents match the query
  rawScores.procedure = 0;
  if (learning.type === "procedure" && Array.isArray(learning.trigger_intents) && learning.trigger_intents.length > 0) {
    const intentTokens = learning.trigger_intents.map(t => t.toLowerCase().split(/\s+/)).flat();
    const triggerMatches = queryTokens.filter(t => intentTokens.includes(t));
    if (triggerMatches.length > 0) {
      rawScores.procedure = triggerMatches.length * 3.0;
      signals.procedure_trigger = triggerMatches.length;
    }
  }

  // S10: Procedure confidence bonus (V4 Sprint 1A)
  // High success_rate procedures get a scoring boost
  if (learning.type === "procedure" && meta?.learnings) {
    const metaEntry = meta.learnings[learning.slug];
    const usedCount = metaEntry?.used_count || learning.used_count || 0;
    const successCount = metaEntry?.success_count || learning.success_count || 0;
    if (usedCount >= 2) {
      const confidenceBonus = (successCount / usedCount) * 1.5;
      rawScores.procedure = (rawScores.procedure || 0) + confidenceBonus;
      signals.procedure_confidence = +(successCount / usedCount).toFixed(2);
    }
  }

  // Gate: >=2 active signals (freshness always counts as 1)
  const activeSignals = Object.keys(signals).length;
  if (!showAll && activeSignals < 2) return null;

  // P4.3: Compute score via weighted sum using intent-aware weights (P4.5)
  const weights = intentWeights || DEFAULT_SIGNAL_WEIGHTS;
  let score = 0;
  for (const [signal, raw] of Object.entries(rawScores)) {
    score += raw * (weights[signal] || 1);
  }

  return { score: +score.toFixed(2), signals, activeSignals, rawScores };
}

export function scoreFile(filePath, content, queryTokens, graphTokens = [], showAll = false, pageRankMap = null) {
  const contentTokens = tokenize(content);
  // Build a set with originals + stems for O(1) lookup
  const contentSet = expandWithStems(contentTokens);
  // Stem-aware matching: check if query stem or original is in content expanded set
  const matchingTokens = [...new Set(queryTokens.filter(qt => {
    if (contentSet.has(qt)) return true;
    const sq = stem(qt);
    if (sq !== qt && sq.length >= 3 && contentSet.has(sq)) return true;
    // Also check prefix: stem(qt) as prefix of any content token (for finances/finance case)
    if (sq.length >= 5) {
      for (const ct of contentSet) {
        if (ct.startsWith(sq) || sq.startsWith(ct)) return true;
      }
    }
    return false;
  }))];
  const graphMatches = [...new Set(graphTokens.filter(gt => {
    if (contentSet.has(gt)) return true;
    const sg = stem(gt);
    if (sg !== gt && sg.length >= 3 && contentSet.has(sg)) return true;
    if (sg.length >= 5) {
      for (const ct of contentSet) {
        if (ct.startsWith(sg) || sg.startsWith(ct)) return true;
      }
    }
    return false;
  }))];

  const totalDimensions = matchingTokens.length + (graphMatches.length > 0 ? 1 : 0);
  if (!showAll && totalDimensions === 0) return null;
  if (!showAll && queryTokens.length > 1 && totalDimensions < 2) return null;

  let score = matchingTokens.length * 2;

  const viaGraph = [];
  if (graphMatches.length > 0) {
    if (pageRankMap && pageRankMap.size > 0) {
      score += graphMatches.reduce((sum, t) => sum + 0.5 + (pageRankMap.get(t) || 0), 0);
    } else {
      score += graphMatches.length * 1;
    }
    viaGraph.push(...graphMatches);
  }

  const fnTokens = tokenize(path.basename(filePath, ".md"));
  const fnMatchCnt = stemMatchCount(queryTokens, fnTokens);
  score += fnMatchCnt * 3;

  const allSearchTokens = [...queryTokens, ...graphTokens];
  const lines = content.split("\n");
  const snippets = [];
  for (let i = 0; i < lines.length && snippets.length < 3; i++) {
    const lineTokens = tokenize(lines[i]);
    if (allSearchTokens.some(st => lineTokens.some(lt => stemMatch(st, lt)))) {
      snippets.push({ line: i + 1, content: lines[i].trim() });
    }
  }

  return { file: filePath, score, matchingTokens, snippets, viaGraph };
}
