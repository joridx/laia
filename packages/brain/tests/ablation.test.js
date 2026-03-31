/**
 * Signal Ablation Test — A/B framework per mesurar l'impacte de cada senyal.
 * 
 * Apaga un senyal cada cop i mesura Recall@k, MRR, Precision@3.
 * Si apagar un senyal no fa baixar significativament les mètriques → candidat a eliminar.
 *
 * Run: LAIA_BRAIN_PATH=$HOME/laia-data node tests/ablation.test.js
 */

import * as fs from "fs";

const brainPath = process.env.LAIA_BRAIN_PATH;
if (!brainPath || !fs.existsSync(brainPath)) {
  console.error("LAIA_BRAIN_PATH not set. Run: LAIA_BRAIN_PATH=$HOME/laia-data node tests/ablation.test.js");
  process.exit(1);
}

// ─── Import scoring internals ──────────────────────────────────────────────────

const scoring = await import("../scoring.js");
const { scoredSearch } = await import("../search.js");

// All signal names used in DEFAULT_SIGNAL_WEIGHTS
const ALL_SIGNALS = Object.keys(scoring.DEFAULT_SIGNAL_WEIGHTS);
// tags, title, keywords, project, graph, freshness, bm25, embedding, bridge

// ─── Test cases (same as retrieval.test.js) ─────────────────────────────────

const testCases = JSON.parse(fs.readFileSync(new URL("./ablation-cases.json", import.meta.url), "utf-8"));

// ─── Evaluation function ────────────────────────────────────────────────────

async function evaluate(label, weightOverrides = {}) {
  // Patch the weights temporarily — deep copy originals first
  const origDefault = { ...scoring.DEFAULT_SIGNAL_WEIGHTS };
  const origIntent = {};
  for (const [intent, w] of Object.entries(scoring.INTENT_WEIGHTS)) {
    origIntent[intent] = { ...w };
  }

  // Apply overrides to all weight sets
  for (const [signal, val] of Object.entries(weightOverrides)) {
    scoring.DEFAULT_SIGNAL_WEIGHTS[signal] = val;
    for (const w of Object.values(scoring.INTENT_WEIGHTS)) {
      w[signal] = val;
    }
  }

  let totalExpected = 0;
  let totalFound = 0;
  let mrrSum = 0;
  let p3Sum = 0;

  for (const tc of testCases) {
    const { learnings } = await scoredSearch(tc.query, "learnings", null, false);
    const topK = learnings.slice(0, tc.k);
    const top3 = learnings.slice(0, 3);
    const topSlugs = new Set(topK.map(l => l.slug));

    const found = tc.expectedSlugs.filter(s => topSlugs.has(s));
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
  }

  // Restore original weights (full replacement, not merge)
  for (const key of Object.keys(scoring.DEFAULT_SIGNAL_WEIGHTS)) {
    scoring.DEFAULT_SIGNAL_WEIGHTS[key] = origDefault[key];
  }
  for (const [intent, w] of Object.entries(origIntent)) {
    for (const key of Object.keys(scoring.INTENT_WEIGHTS[intent])) {
      scoring.INTENT_WEIGHTS[intent][key] = w[key];
    }
  }

  const recall = totalFound / totalExpected;
  const mrr = mrrSum / testCases.length;
  const p3 = p3Sum / testCases.length;

  return { label, recall, mrr, p3, found: totalFound, expected: totalExpected };
}

// ─── Run ablation ──────────────────────────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║           SIGNAL ABLATION TEST — A/B Framework                  ║");
console.log("║  Apaga un senyal cada cop i mesura l'impacte en Recall/MRR      ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");

console.log(`Test cases: ${testCases.length}`);
console.log(`Signals:    ${ALL_SIGNALS.join(", ")}\n`);

// 1. Baseline (all signals on)
const baseline = await evaluate("BASELINE (all signals)");
console.log(`\n🟢 BASELINE: Recall=${baseline.recall.toFixed(3)} MRR=${baseline.mrr.toFixed(3)} P@3=${baseline.p3.toFixed(3)} (${baseline.found}/${baseline.expected})\n`);

// 2. Ablation: turn off one signal at a time
const ablationResults = [];

for (const signal of ALL_SIGNALS) {
  const override = { [signal]: 0 };
  const result = await evaluate(`−${signal}`, override);
  
  const recallDelta = result.recall - baseline.recall;
  const mrrDelta = result.mrr - baseline.mrr;
  
  ablationResults.push({ signal, ...result, recallDelta, mrrDelta });
}

// 3. Results table
console.log("┌──────────────┬─────────┬──────────┬─────────┬──────────┬────────────┐");
console.log("│ Signal OFF   │ Recall  │ Δ Recall │ MRR     │ Δ MRR    │ Verdict    │");
console.log("├──────────────┼─────────┼──────────┼─────────┼──────────┼────────────┤");

for (const r of ablationResults) {
  const recallStr = r.recall.toFixed(3).padStart(7);
  const deltaStr = (r.recallDelta >= 0 ? "+" : "") + r.recallDelta.toFixed(3);
  const mrrStr = r.mrr.toFixed(3).padStart(7);
  const mrrDeltaStr = (r.mrrDelta >= 0 ? "+" : "") + r.mrrDelta.toFixed(3);
  
  let verdict;
  if (r.recallDelta <= -0.05) verdict = "🔴 CRITICAL";
  else if (r.recallDelta <= -0.02) verdict = "🟡 USEFUL";
  else if (r.recallDelta <= -0.005) verdict = "🟠 MARGINAL";
  else verdict = "⚪ REMOVABLE";
  
  console.log(`│ ${r.signal.padEnd(12)} │ ${recallStr} │ ${deltaStr.padStart(8)} │ ${mrrStr} │ ${mrrDeltaStr.padStart(8)} │ ${verdict.padEnd(10)} │`);
}

console.log("└──────────────┴─────────┴──────────┴─────────┴──────────┴────────────┘");

// 4. Summary
console.log("\nLegend:");
console.log("  🔴 CRITICAL:  Recall drops > 5%  → DO NOT REMOVE");
console.log("  🟡 USEFUL:    Recall drops 2-5%  → Keep unless major simplification");
console.log("  🟠 MARGINAL:  Recall drops 0.5-2% → Consider removing");
console.log("  ⚪ REMOVABLE: Recall drops < 0.5% → Safe to remove");

// 5. Candidates for removal
const removable = ablationResults
  .filter(r => r.recallDelta > -0.005)
  .sort((a, b) => b.recallDelta - a.recallDelta);

if (removable.length > 0) {
  console.log("\n🗑️  REMOVAL CANDIDATES (ordered by impact):");
  for (const r of removable) {
    const lines = await countSignalLines(r.signal);
    console.log(`  - ${r.signal}: Recall ${(r.recallDelta >= 0 ? "+" : "")}${r.recallDelta.toFixed(3)}, MRR ${(r.mrrDelta >= 0 ? "+" : "")}${r.mrrDelta.toFixed(3)}${lines ? ` (~${lines} lines of code)` : ""}`);
  }
}

// ─── 6. Cumulative ablation: remove signals from least to most impactful ─────
console.log("\n" + "═".repeat(68));
console.log("CUMULATIVE ABLATION — Remove from least to most impactful");
console.log("═".repeat(68) + "\n");

// Sort by recall delta (least impact first = highest/least negative delta)
const sorted = [...ablationResults].sort((a, b) => b.recallDelta - a.recallDelta);
const cumOverrides = {};

for (const r of sorted) {
  cumOverrides[r.signal] = 0;
  
  // For cumulative, apply ALL overrides at once (don't restore between runs)
  // Save originals
  const origDefault = { ...scoring.DEFAULT_SIGNAL_WEIGHTS };
  const origIntent = {};
  for (const [intent, w] of Object.entries(scoring.INTENT_WEIGHTS)) {
    origIntent[intent] = { ...w };
  }
  // Apply all cumulative overrides
  for (const [signal, val] of Object.entries(cumOverrides)) {
    scoring.DEFAULT_SIGNAL_WEIGHTS[signal] = val;
    for (const w of Object.values(scoring.INTENT_WEIGHTS)) {
      w[signal] = val;
    }
  }
  
  let totalExpected = 0, totalFound = 0, mrrSum = 0;
  for (const tc of testCases) {
    const { learnings } = await scoredSearch(tc.query, "learnings", null, false);
    const topK = learnings.slice(0, tc.k);
    const topSlugs = new Set(topK.map(l => l.slug));
    const found = tc.expectedSlugs.filter(s => topSlugs.has(s));
    totalExpected += tc.expectedSlugs.length;
    totalFound += found.length;
    let rr = 0;
    for (const slug of tc.expectedSlugs) {
      const rank = topK.findIndex(l => l.slug === slug);
      if (rank >= 0) rr = Math.max(rr, 1 / (rank + 1));
    }
    mrrSum += rr;
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
  
  const cumRecall = totalFound / totalExpected;
  const cumMrr = mrrSum / testCases.length;
  const recallDelta = cumRecall - baseline.recall;
  const mrrDelta = cumMrr - baseline.mrr;
  
  let verdict;
  if (recallDelta <= -0.05) verdict = "🔴 STOP HERE";
  else if (recallDelta <= -0.02) verdict = "🟡 RISKY";
  else verdict = "🟢 SAFE";
  
  const removed = Object.keys(cumOverrides).join(" + ");
  console.log(`  −[${removed}]`);
  console.log(`    Recall=${cumRecall.toFixed(3)} (${(recallDelta >= 0 ? "+" : "")}${recallDelta.toFixed(3)}) MRR=${cumMrr.toFixed(3)} (${(mrrDelta >= 0 ? "+" : "")}${mrrDelta.toFixed(3)}) → ${verdict}`);
  
  if (recallDelta <= -0.05) {
    console.log(`\n  ⛔ Stopped: removing '${r.signal}' crosses the -5% threshold.`);
    console.log(`  ✅ Safe to remove: ${Object.keys(cumOverrides).filter(s => s !== r.signal).join(", ") || "(none)"}`);
    break;
  }
}

// Rough LOC estimates per signal
async function countSignalLines(signal) {
  const estimates = {
    graph: 150,      // graph.js + PageRank + spreading activation + scoring
    embedding: 200,  // embeddings.js + download-models + semantic.js
    bridge: 30,      // bridge section in scoring
    project: 15,     // project match section
    freshness: 80,   // vitality/ACT-R computation
    bm25: 60,        // FTS5 integration
    tags: 10,        // tag match
    title: 10,       // title match
    keywords: 10,    // body match
  };
  return estimates[signal] || null;
}
