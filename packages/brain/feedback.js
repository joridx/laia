/**
 * P15.2: Implicit Relevance Feedback (IRF) for brain search.
 *
 * Tracks which search results are actually "used" by the agent in responses.
 * Feeds back into scoring as a 5th RRF signal to make ranking adaptive.
 *
 * Detection tiers:
 *   Tier 1 (high):   Substring match on learning title/slug in agent output
 *   Tier 2 (medium): Trigram Jaccard similarity > 0.6 on title
 *   Tier 3 (low):    Keyword overlap (TF-lite) — content words in common
 *
 * Safeguards:
 *   - Anti-agent-bias: if ≥2 hits detected, don't count misses for remaining
 *   - Min-impressions: learnings with < 5 feedback appearances get neutral score
 *   - Bayesian smoothing: (hits+1)/(hits+misses+2) prevents extreme scores
 *   - Exploration slot: 1 random result from positions 6-20 injected into results
 *   - Timestamp on hits for future temporal decay
 *
 * Pure functions — no I/O. Caller handles persistence.
 * Note: recordFeedback() mutates meta in place (stateful update helper).
 */

import { tokenize } from "./utils.js";

// ─── Stop words (common English + Catalan, excluded from keyword overlap) ────

const STOP_WORDS = new Set([
  // English
  "the", "is", "at", "which", "on", "in", "to", "for", "of", "and", "or",
  "not", "with", "as", "by", "an", "be", "this", "that", "from", "it",
  "was", "are", "were", "been", "has", "have", "had", "but", "if", "can",
  "will", "do", "does", "did", "its", "you", "we", "they", "he", "she",
  "all", "each", "any", "no", "so", "too", "very", "just", "about", "more",
  "also", "then", "than", "when", "how", "what", "who", "where", "why",
  // Catalan
  "el", "la", "els", "les", "un", "una", "de", "del", "al", "amb", "per",
  "que", "es", "en", "no", "si", "com", "hem", "han", "ser", "fer",
]);

// ─── Tier 1: Substring match ────────────────────────────────────────────────

/**
 * Check if learning title or slug appears as substring in agent output.
 * @param {string} title - Learning title
 * @param {string} slug - Learning slug
 * @param {string} output - Agent response text
 * @returns {boolean}
 */
export function substringMatch(title, slug, output) {
  if (!title || !output) return false;
  const lower = output.toLowerCase();
  // Check slug (e.g., "vitality-decay-fix")
  if (slug && slug.length >= 5 && lower.includes(slug)) return true;
  // Check title (e.g., "Vitality decay fix")
  const titleLower = title.toLowerCase();
  if (titleLower.length >= 5 && lower.includes(titleLower)) return true;
  return false;
}

// ─── Tier 2: Trigram Jaccard similarity ─────────────────────────────────────

/**
 * Generate character trigrams from text.
 * @param {string} text
 * @returns {Set<string>}
 */
export function trigrams(text) {
  const s = new Set();
  const t = (text || "").toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i <= t.length - 3; i++) {
    s.add(t.slice(i, i + 3));
  }
  return s;
}

/**
 * Jaccard similarity between two trigram sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0-1
 */
export function trigramJaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Check if any sentence/chunk of agent output has trigram similarity > threshold
 * with the learning title.
 * @param {string} title - Learning title
 * @param {string} output - Agent response text
 * @param {number} threshold - Jaccard threshold (default 0.6)
 * @returns {boolean}
 */
export function trigramMatch(title, output, threshold = 0.6) {
  if (!title || !output || title.length < 5) return false;
  const titleTri = trigrams(title);
  // Check against chunks of output (sentences / lines)
  const chunks = output.split(/[.\n!?]+/).filter(c => c.trim().length > 5);
  for (const chunk of chunks) {
    const chunkTri = trigrams(chunk.trim());
    if (trigramJaccard(titleTri, chunkTri) >= threshold) return true;
  }
  return false;
}

// ─── Tier 3: Keyword overlap (TF-lite) ─────────────────────────────────────

/**
 * Extract content words from text (tokenize + remove stop words).
 * @param {string} text
 * @returns {Set<string>}
 */
export function contentWords(text) {
  const tokens = tokenize(text);
  return new Set(tokens.filter(t => t.length >= 3 && !STOP_WORDS.has(t)));
}

/**
 * Check keyword overlap between a learning's content and agent output.
 * Requires at least `minOverlap` shared content words.
 * @param {string} learningText - Title + body of learning
 * @param {string} output - Agent response text
 * @param {number} minOverlap - Minimum shared keywords (default 3)
 * @returns {boolean}
 */
export function keywordOverlapMatch(learningText, output, minOverlap = 3) {
  if (!learningText || !output) return false;
  const learningWords = contentWords(learningText);
  const outputWords = contentWords(output);
  let overlap = 0;
  for (const w of learningWords) {
    if (outputWords.has(w)) {
      overlap++;
      if (overlap >= minOverlap) return true;
    }
  }
  return false;
}

// ─── Combined "used" detection ──────────────────────────────────────────────

/**
 * Determine which search results were likely "used" by the agent.
 * Returns array of slugs that were used.
 *
 * @param {Array<{slug: string, title: string, body?: string, headline?: string}>} results - Search results
 * @param {string} agentOutput - The agent's response text
 * @returns {string[]} slugs of used learnings
 */
export function detectUsedLearnings(results, agentOutput) {
  if (!results || results.length === 0 || !agentOutput) return [];

  const used = [];
  for (const r of results) {
    // Tier 1: Substring
    if (substringMatch(r.title, r.slug, agentOutput)) {
      used.push(r.slug);
      continue;
    }
    // Tier 2: Trigram
    if (trigramMatch(r.title, agentOutput)) {
      used.push(r.slug);
      continue;
    }
    // Tier 3: Keyword overlap
    const learningText = [r.title, r.headline, r.body].filter(Boolean).join(" ");
    if (keywordOverlapMatch(learningText, agentOutput)) {
      used.push(r.slug);
      continue;
    }
  }
  return used;
}

// ─── Feedback recording ─────────────────────────────────────────────────────

/**
 * Record feedback for a set of search results given used slugs.
 * Applies anti-agent-bias: if ≥2 used, don't count misses for remaining.
 *
 * @param {object} meta - learnings-meta.json content (mutated in place)
 * @param {string[]} resultSlugs - All slugs returned by search (ordered by rank)
 * @param {string[]} usedSlugs - Slugs detected as "used"
 * @returns {{ hits: string[], misses: string[], forgiven: string[] }}
 */
export function recordFeedback(meta, resultSlugs, usedSlugs) {
  if (!meta?.learnings) return { hits: [], misses: [], forgiven: [] };

  const usedSet = new Set(usedSlugs);
  const hits = [];
  const misses = [];
  const forgiven = [];
  const now = Date.now();

  // Anti-agent-bias: if ≥2 used, forgive the rest
  const applyForgiveness = usedSet.size >= 2;

  for (const slug of resultSlugs) {
    const entry = meta.learnings[slug];
    if (!entry) continue;

    // Initialize feedback fields if missing
    if (entry.feedback_hits == null) entry.feedback_hits = 0;
    if (entry.feedback_misses == null) entry.feedback_misses = 0;
    if (entry.feedback_appearances == null) entry.feedback_appearances = 0;

    entry.feedback_appearances++;

    if (usedSet.has(slug)) {
      entry.feedback_hits++;
      entry.feedback_last_hit = now;
      hits.push(slug);
    } else if (applyForgiveness) {
      // Agent used ≥2 results — don't penalize the rest
      forgiven.push(slug);
    } else {
      entry.feedback_misses++;
      misses.push(slug);
    }
  }

  return { hits, misses, forgiven };
}

// ─── Feedback scoring ───────────────────────────────────────────────────────

/** Minimum appearances before feedback affects scoring. */
export const MIN_IMPRESSIONS = 5;

/**
 * Compute Bayesian-smoothed hit rate for a learning.
 * Formula: (hits + 1) / (hits + misses + 2)
 * Returns 0.5 (neutral) if below MIN_IMPRESSIONS threshold.
 *
 * @param {object} metaEntry - Meta entry for a learning
 * @returns {number} 0-1 (0.5 = neutral)
 */
export function computeFeedbackScore(metaEntry) {
  if (!metaEntry) return 0.5;
  const appearances = metaEntry.feedback_appearances || 0;
  if (appearances < MIN_IMPRESSIONS) return 0.5; // Not enough data

  const hits = metaEntry.feedback_hits || 0;
  const misses = metaEntry.feedback_misses || 0;
  return (hits + 1) / (hits + misses + 2);
}

// ─── Exploration slot ───────────────────────────────────────────────────────

/**
 * Inject 1 exploration result from positions 6-20 into the top results.
 * Prevents rich-get-richer collapse by giving unseen learnings a chance.
 *
 * @param {Array} results - Sorted search results (best first)
 * @param {number} topK - Number of top results to return (default 10)
 * @returns {Array} Results with 1 exploration slot injected at last position
 */
export function injectExplorationSlot(results, topK = 10) {
  if (!results || results.length <= topK) return results;

  const top = results.slice(0, topK);
  const exploreCandidates = results.slice(topK, Math.min(results.length, 20));

  if (exploreCandidates.length === 0) return top;

  // Random pick from exploration candidates
  const idx = Math.floor(Math.random() * exploreCandidates.length);
  const exploration = { ...exploreCandidates[idx], _exploration: true };

  // Replace last position in top results with exploration slot
  top[topK - 1] = exploration;
  return top;
}

// ─── Rank delta metric (debug) ──────────────────────────────────────────────

/**
 * Compute rank delta for each learning: how much feedback changes its position.
 * Used to validate that feedback remains a tiebreaker, not a dominant signal.
 *
 * @param {Array<{slug: string, score: number}>} withFeedback - Results ranked with feedback signal
 * @param {Array<{slug: string, score: number}>} withoutFeedback - Results ranked without feedback signal
 * @returns {{ deltas: Map<string, number>, avgDelta: number }}
 */
export function computeRankDelta(withFeedback, withoutFeedback) {
  const rankWith = new Map(withFeedback.map((r, i) => [r.slug, i]));
  const rankWithout = new Map(withoutFeedback.map((r, i) => [r.slug, i]));
  const deltas = new Map();
  let totalDelta = 0;
  let count = 0;

  for (const [slug, rankW] of rankWith) {
    const rankWO = rankWithout.get(slug);
    if (rankWO !== undefined) {
      const delta = rankWO - rankW; // positive = feedback boosted it
      deltas.set(slug, delta);
      totalDelta += Math.abs(delta);
      count++;
    }
  }

  return {
    deltas,
    avgDelta: count > 0 ? +(totalDelta / count).toFixed(2) : 0
  };
}
