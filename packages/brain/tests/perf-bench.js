/**
 * Search Performance Benchmark — mesura temps amb tots senyals vs només els essencials.
 *
 * Run: LAIA_BRAIN_PATH=$HOME/laia-data node tests/perf-bench.js
 */

import * as fs from "fs";

const brainPath = process.env.LAIA_BRAIN_PATH;
if (!brainPath || !fs.existsSync(brainPath)) {
  console.error("LAIA_BRAIN_PATH not set.");
  process.exit(1);
}

const scoring = await import("../scoring.js");
const { scoredSearch } = await import("../search.js");

const testCases = JSON.parse(fs.readFileSync(new URL("./ablation-cases.json", import.meta.url), "utf-8"));

// ─── Benchmark function ─────────────────────────────────────────────────────

async function benchmark(label, weightOverrides = {}) {
  // Save originals
  const origDefault = { ...scoring.DEFAULT_SIGNAL_WEIGHTS };
  const origIntent = {};
  for (const [intent, w] of Object.entries(scoring.INTENT_WEIGHTS)) {
    origIntent[intent] = { ...w };
  }

  // Apply overrides
  for (const [signal, val] of Object.entries(weightOverrides)) {
    scoring.DEFAULT_SIGNAL_WEIGHTS[signal] = val;
    for (const w of Object.values(scoring.INTENT_WEIGHTS)) {
      w[signal] = val;
    }
  }

  const times = [];

  // Warmup run (discard)
  for (const tc of testCases) {
    await scoredSearch(tc.query, "learnings", null, false);
  }

  // 3 timed runs
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    for (const tc of testCases) {
      await scoredSearch(tc.query, "learnings", null, false);
    }
    times.push(performance.now() - start);
  }

  // Restore originals
  for (const key of Object.keys(scoring.DEFAULT_SIGNAL_WEIGHTS)) {
    scoring.DEFAULT_SIGNAL_WEIGHTS[key] = origDefault[key];
  }
  for (const [intent, w] of Object.entries(origIntent)) {
    for (const key of Object.keys(scoring.INTENT_WEIGHTS[intent])) {
      scoring.INTENT_WEIGHTS[intent][key] = w[key];
    }
  }

  const avg = times.reduce((a, b) => a + b) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const perQuery = avg / testCases.length;

  return { label, avg, min, max, perQuery, times };
}

// ─── Run benchmarks ─────────────────────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║         SEARCH PERFORMANCE BENCHMARK                            ║");
console.log("║  53 queries × 3 runs — warm cache                               ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");

// 1. Baseline: all signals
const full = await benchmark("ALL signals (current)");

// 2. Lean: only tags + title + keywords (disable the 6 removable ones)
const lean = await benchmark("LEAN (tags+title+keywords only)", {
  project: 0, graph: 0, freshness: 0, bm25: 0, embedding: 0, bridge: 0,
});

// 3. Individual signal timing — disable each one to measure its overhead
const signalTimings = [];
const removableSignals = ["project", "graph", "freshness", "bm25", "embedding", "bridge"];

for (const signal of removableSignals) {
  const result = await benchmark(`−${signal}`, { [signal]: 0 });
  signalTimings.push({ signal, ...result });
}

// ─── Results ────────────────────────────────────────────────────────────────

console.log("┌─────────────────────────────────┬──────────┬──────────┬──────────┬──────────┐");
console.log("│ Config                          │ Avg (ms) │ Min (ms) │ Max (ms) │ Per-Q ms │");
console.log("├─────────────────────────────────┼──────────┼──────────┼──────────┼──────────┤");

function row(r) {
  console.log(`│ ${r.label.padEnd(31)} │ ${r.avg.toFixed(1).padStart(8)} │ ${r.min.toFixed(1).padStart(8)} │ ${r.max.toFixed(1).padStart(8)} │ ${r.perQuery.toFixed(1).padStart(8)} │`);
}

row(full);
row(lean);
console.log("├─────────────────────────────────┼──────────┼──────────┼──────────┼──────────┤");
for (const s of signalTimings) {
  row(s);
}
console.log("└─────────────────────────────────┴──────────┴──────────┴──────────┴──────────┘");

// Speedup summary
const speedup = ((full.avg - lean.avg) / full.avg * 100).toFixed(1);
const savedPerQ = (full.perQuery - lean.perQuery).toFixed(1);
const savedTotal = (full.avg - lean.avg).toFixed(0);

console.log(`\n📊 Summary:`);
console.log(`  Full:     ${full.avg.toFixed(0)} ms total (${full.perQuery.toFixed(1)} ms/query)`);
console.log(`  Lean:     ${lean.avg.toFixed(0)} ms total (${lean.perQuery.toFixed(1)} ms/query)`);
console.log(`  Speedup:  ${speedup}% faster (${savedTotal} ms saved over 53 queries, ${savedPerQ} ms/query)`);

// Per-signal overhead estimate
console.log(`\n⏱️  Per-signal overhead (estimated from single-disable):`);
for (const s of signalTimings) {
  const overhead = full.avg - s.avg;
  const pct = (overhead / full.avg * 100).toFixed(1);
  console.log(`  ${s.signal.padEnd(12)}: ${overhead >= 0 ? "+" : ""}${overhead.toFixed(0)} ms (${pct}%)`);
}
