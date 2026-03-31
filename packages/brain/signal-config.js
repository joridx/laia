/**
 * Signal Pipeline Configuration — toggleable signals for search scoring.
 * 
 * Each signal can be enabled/disabled without deleting code.
 * Disabled signals are "hibernated" — zero cost at runtime, available to re-enable.
 * Signals are a deployment-time decision — toggle here and restart the server.
 * 
 * Based on ablation test results (2026-03-28, 53 queries, 1329 learnings):
 *   - title, tags, keywords: CRITICAL (core signals, always on)
 *   - project, graph, freshness, bm25, embedding, bridge: REMOVABLE (0% recall impact)
 *   - Removing 6 signals: Recall -1.7%, MRR +19.6%, 5× faster (37ms → 7ms/query)
 *
 * Baseline metrics (LEAN 3-signal config):
 *   Recall@10: 0.862 | MRR: 0.708 | Precision@3: 0.714 | Latency: 7ms/query
 *
 * Re-evaluation triggers (revisit quarantined signals when ANY of):
 *   - Recall@10 drops ≥5pp below 0.862, sustained across 2 consecutive runs (≥50 queries)
 *   - Learnings count exceeds 3,000
 *
 * To re-enable a signal: set enabled: true below and restart the server.
 * Full restore docs: docs/search-system-snapshot.md (section 8: Reverse Roadmap)
 */

// ─── Signal Registry ────────────────────────────────────────────────────────

const SIGNAL_REGISTRY = {
  // === Core signals (always on) ===
  tags:       { enabled: true,  phase: "scoring", cost: "trivial",  description: "Tag match against query tokens" },
  title:      { enabled: true,  phase: "scoring", cost: "trivial",  description: "Title/headline token match" },
  keywords:   { enabled: true,  phase: "scoring", cost: "trivial",  description: "Body text token match" },

  // === Quarantined signals (zero runtime cost when disabled) ===
  // @quarantine {
  //   date: "2026-03-28",
  //   owner: "yuri",
  //   evidence: "ablation-test (53q/1329L): 0% recall impact, MRR +19.6% without, 5× faster",
  //   recheck_by: "2026-09-28",
  //   delete_if: "no ablation proves benefit by recheck date"
  // }
  project:    { enabled: true,  phase: "scoring", cost: "trivial",  description: "Active project tag match" },
  graph:      { enabled: true,  phase: "pre",     cost: "moderate", description: "PageRank + spreading activation + query expansion" },
  freshness:  { enabled: false, phase: "scoring", cost: "moderate", description: "ACT-R vitality decay model" },
  bm25:       { enabled: true,  phase: "pre",     cost: "moderate", description: "FTS5 BM25 full-text scoring" },
  embedding:  { enabled: false, phase: "pre",     cost: "heavy",    description: "Semantic embedding similarity" },
  bridge:     { enabled: false, phase: "scoring", cost: "trivial",  description: "Bridge learning connects boost" },

  // === P15.2: Implicit Relevance Feedback (new) ===
  feedback:   { enabled: true,  phase: "scoring", cost: "trivial",  description: "Bayesian hit-rate from implicit usage feedback" },
};

// ─── Public API ─────────────────────────────────────────────────────────────

/** Check if a signal is enabled (deployment-time decision). */
export function signalEnabled(name) {
  return SIGNAL_REGISTRY[name]?.enabled === true;
}

/** Get all enabled signal names. */
export function getEnabledSignals() {
  return Object.entries(SIGNAL_REGISTRY)
    .filter(([_, cfg]) => cfg.enabled)
    .map(([name]) => name);
}

/** Get all signal names (enabled + disabled). */
export function getAllSignals() {
  return Object.keys(SIGNAL_REGISTRY);
}

/** Get full registry (for health/diagnostics). */
export function getSignalRegistry() {
  return { ...SIGNAL_REGISTRY };
}
