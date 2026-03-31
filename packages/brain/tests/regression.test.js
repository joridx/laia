/**
 * Search Regression Test — Golden queries safety net.
 * 
 * Validates that search quality stays above agreed baselines (search-refactor-spec.md §5).
 * Run on every commit to catch ranking regressions.
 *
 * Baselines (LEAN 3-signal config, 2026-03-28):
 *   Recall@10 floor: ≥ 0.85
 *   MRR floor:       ≥ 0.65
 *   Latency budget:  ≤ 15ms per query (mean, warm cache)
 *
 * Re-evaluation triggers (search-refactor-spec.md §7):
 *   - Recall@10 drops ≥5pp below 0.862, sustained across 2 consecutive runs (≥50 queries)
 *   - Learnings count exceeds 3,000
 *
 * Run: LAIA_BRAIN_PATH=$HOME/laia-data node tests/regression.test.js
 */

import * as fs from "fs";

const brainPath = process.env.LAIA_BRAIN_PATH;
if (!brainPath || !fs.existsSync(brainPath)) {
  console.error("LAIA_BRAIN_PATH not set. Run: LAIA_BRAIN_PATH=$HOME/laia-data node tests/regression.test.js");
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const RECALL_FLOOR = 0.85;
const MRR_FLOOR = 0.65;
const LATENCY_BUDGET_MS = 15;  // per query mean (warm cache)
const WARMUP_RUNS = 1;
const TIMED_RUNS = 3;

// ─── Imports ─────────────────────────────────────────────────────────────────

const { scoredSearch } = await import("../search.js");
const { getAllLearnings } = await import("../learnings.js");

const testCases = JSON.parse(fs.readFileSync(new URL("./ablation-cases.json", import.meta.url), "utf-8"));

// ─── Evaluate ────────────────────────────────────────────────────────────────

async function evaluateQuality() {
  let totalExpected = 0;
  let totalFound = 0;
  let mrrSum = 0;
  let p3Sum = 0;
  const perQueryResults = [];  // Per-query reporting (Codex review feedback)

  for (const tc of testCases) {
    const { learnings } = await scoredSearch(tc.query, "learnings", null, false);
    const topK = learnings.slice(0, tc.k);
    const top3 = learnings.slice(0, 3);
    const topSlugs = new Set(topK.map(l => l.slug));

    const found = tc.expectedSlugs.filter(s => topSlugs.has(s));
    const missed = tc.expectedSlugs.filter(s => !topSlugs.has(s));
    totalExpected += tc.expectedSlugs.length;
    totalFound += found.length;

    // MRR
    let rr = 0;
    for (const slug of tc.expectedSlugs) {
      const rank = topK.findIndex(l => l.slug === slug);
      if (rank >= 0) rr = Math.max(rr, 1 / (rank + 1));
    }
    mrrSum += rr;

    // P@3
    const foundIn3 = tc.expectedSlugs.filter(s => new Set(top3.map(l => l.slug)).has(s)).length;
    p3Sum += top3.length > 0 ? foundIn3 / Math.min(3, tc.expectedSlugs.length) : 0;

    const recall = found.length / tc.expectedSlugs.length;
    perQueryResults.push({ name: tc.name, query: tc.query, recall, rr, found: found.length, expected: tc.expectedSlugs.length, missed });
  }

  return {
    recall: totalFound / totalExpected,
    mrr: mrrSum / testCases.length,
    p3: p3Sum / testCases.length,
    found: totalFound,
    expected: totalExpected,
    perQuery: perQueryResults
  };
}

async function evaluateLatency() {
  // Warmup
  for (let i = 0; i < WARMUP_RUNS; i++) {
    for (const tc of testCases) {
      await scoredSearch(tc.query, "learnings", null, false);
    }
  }

  // Timed runs
  const times = [];
  for (let run = 0; run < TIMED_RUNS; run++) {
    const start = performance.now();
    for (const tc of testCases) {
      await scoredSearch(tc.query, "learnings", null, false);
    }
    times.push(performance.now() - start);
  }

  const avgTotal = times.reduce((a, b) => a + b) / times.length;
  const perQuery = avgTotal / testCases.length;

  return { avgTotal, perQuery, runs: times };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║         SEARCH REGRESSION TEST — Safety Net                     ║");
console.log("║  Golden queries with quality + latency assertions               ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");

const learningsCount = getAllLearnings().length;
console.log(`Learnings:   ${learningsCount}`);
console.log(`Test cases:  ${testCases.length}`);
console.log(`Baselines:   Recall≥${RECALL_FLOOR} MRR≥${MRR_FLOOR} Latency≤${LATENCY_BUDGET_MS}ms/query\n`);

// Quality check
const quality = await evaluateQuality();
console.log("── Quality ──────────────────────────────────────────────────────");
console.log(`  Recall@10:    ${quality.recall.toFixed(3)} (${quality.found}/${quality.expected})`);
console.log(`  MRR:          ${quality.mrr.toFixed(3)}`);
console.log(`  Precision@3:  ${quality.p3.toFixed(3)}`);

// Latency check
const latency = await evaluateLatency();
console.log("\n── Latency ──────────────────────────────────────────────────────");
console.log(`  Mean total:   ${latency.avgTotal.toFixed(1)} ms (${testCases.length} queries)`);
console.log(`  Mean/query:   ${latency.perQuery.toFixed(1)} ms`);
console.log(`  Runs:         ${latency.runs.map(t => t.toFixed(0) + "ms").join(", ")}`);

// Assertions
console.log("\n── Assertions ───────────────────────────────────────────────────");

let failures = 0;

function check(name, actual, threshold, comparator = ">=") {
  const pass = comparator === ">=" ? actual >= threshold : actual <= threshold;
  const icon = pass ? "✅" : "❌";
  const op = comparator === ">=" ? "≥" : "≤";
  console.log(`  ${icon} ${name}: ${actual.toFixed(3)} ${op} ${threshold} ${pass ? "" : "← FAIL"}`);
  if (!pass) failures++;
}

check("Recall@10", quality.recall, RECALL_FLOOR, ">=");
check("MRR", quality.mrr, MRR_FLOOR, ">=");
check("Latency/query", latency.perQuery, LATENCY_BUDGET_MS, "<=");

// Per-query failure details (Codex review feedback)
const failedQueries = quality.perQuery.filter(q => q.recall < 1.0);
if (failedQueries.length > 0) {
  console.log(`\n── Failed Queries (${failedQueries.length}/${testCases.length}) ──────────────────────────────`);
  for (const q of failedQueries) {
    console.log(`  ⚠️  ${q.name}: recall=${q.recall.toFixed(2)} (${q.found}/${q.expected})`);
    if (q.missed.length > 0) {
      console.log(`      missed: ${q.missed.join(", ")}`);
    }
  }
}

// Re-evaluation trigger check
console.log("\n── Re-evaluation Triggers ────────────────────────────────────────");
if (learningsCount > 3000) {
  console.log("  ⚠️  Learnings > 3,000 — consider re-running ablation test with quarantined signals");
}
const recallBaseline = 0.862;
const recallDrop = recallBaseline - quality.recall;
if (recallDrop >= 0.05) {
  console.log(`  ⚠️  Recall dropped ${(recallDrop * 100).toFixed(1)}pp below baseline (0.862) — consider re-enabling quarantined signals`);
  console.log(`     Run: LAIA_BRAIN_PATH=$HOME/laia-data node tests/ablation.test.js`);
} else {
  console.log(`  ✅ Recall within baseline (drop: ${(recallDrop * 100).toFixed(1)}pp < 5pp threshold)`);
}
if (learningsCount <= 3000) {
  console.log(`  ✅ Learnings count (${learningsCount}) below 3,000 threshold`);
}

// Summary
console.log("\n── Summary ──────────────────────────────────────────────────────");
if (failures === 0) {
  console.log("  ✅ ALL CHECKS PASSED — search quality is within baselines");
} else {
  console.log(`  ❌ ${failures} CHECK(S) FAILED — investigate before merging`);
}

process.exit(failures > 0 ? 1 : 0);
