/**
 * Tests for P4.4 PageRank — pure computation, integration with scoring and graph expansion.
 */

import {
  computePageRank, computeStructuralBoostPR, computeStructuralBoost,
  scoreLearning, scoreFile, DEFAULT_SIGNAL_WEIGHTS
} from "../scoring.js";
import { tokenize } from "../utils.js";
import { createSuite } from "./harness.js";

const t = createSuite("pagerank");

// ─── computePageRank — basic graphs ─────────────────────────────────────────

t.section("computePageRank — basic");

// Empty graph
const prEmpty = computePageRank({});
t.assert(prEmpty.size === 0, "Empty concepts → empty map");
t.assert(computePageRank(null).size === 0, "null concepts → empty map");
t.assert(computePageRank(undefined).size === 0, "undefined → empty map");

// Single node with no edges
const prSingle = computePageRank({ "alpha": { related_to: [], children: [] } });
t.assert(prSingle.size === 1, "Single node → 1 entry");
t.assert(prSingle.get("alpha") === 0.5, "Single node → 0.5 (uniform)");

// Two bidirectional nodes
const prPair = computePageRank({
  "a": { related_to: ["b"] },
  "b": { related_to: ["a"] }
});
t.assert(prPair.size === 2, "Pair → 2 entries");
t.assertClose(prPair.get("a"), 0.5, 0.01, "Symmetric pair → equal rank (a)");
t.assertClose(prPair.get("b"), 0.5, 0.01, "Symmetric pair → equal rank (b)");

// ─── computePageRank — star topology ────────────────────────────────────────

t.section("computePageRank — star topology");

// Hub pointed to by 4 spokes
const starConcepts = {
  "hub": { related_to: [] },
  "spoke1": { related_to: ["hub"] },
  "spoke2": { related_to: ["hub"] },
  "spoke3": { related_to: ["hub"] },
  "spoke4": { related_to: ["hub"] }
};
const prStar = computePageRank(starConcepts);
t.assert(prStar.size === 5, "Star → 5 nodes");
t.assert(prStar.get("hub") > prStar.get("spoke1"), `Hub has highest rank (${prStar.get("hub").toFixed(3)} > ${prStar.get("spoke1").toFixed(3)})`);
t.assertClose(prStar.get("hub"), 1.0, 0.01, "Hub is max (normalized to 1.0)");

// All spokes should have similar rank
const spokeRanks = ["spoke1", "spoke2", "spoke3", "spoke4"].map(s => prStar.get(s));
const spokeSpread = Math.max(...spokeRanks) - Math.min(...spokeRanks);
t.assert(spokeSpread < 0.05, `Spokes have similar rank (spread=${spokeSpread.toFixed(4)})`);

// ─── computePageRank — ring graph ───────────────────────────────────────────

t.section("computePageRank — ring");

const ringConcepts = {
  "a": { related_to: ["b"] },
  "b": { related_to: ["c"] },
  "c": { related_to: ["d"] },
  "d": { related_to: ["a"] }
};
const prRing = computePageRank(ringConcepts);
t.assert(prRing.size === 4, "Ring → 4 nodes");
// All nodes in a ring should have equal rank (uniform 0.5 after normalization)
for (const node of ["a", "b", "c", "d"]) {
  t.assertClose(prRing.get(node), 0.5, 0.05, `Ring node ${node} → ~0.5`);
}

// ─── computePageRank — hierarchical graph ───────────────────────────────────

t.section("computePageRank — hierarchy");

// parent-child: children link to parent via "parent" field
const hierConcepts = {
  "root": { related_to: [], children: ["child1", "child2"] },
  "child1": { parent: "root", related_to: [] },
  "child2": { parent: "root", related_to: [] }
};
const prHier = computePageRank(hierConcepts);
t.assert(prHier.size === 3, "Hierarchy → 3 nodes");
// root gets pointed to by children (via parent field) AND by itself (via children field)
// children get pointed to by root (via children edge)
// root should have highest rank because it receives from both children
t.assert(prHier.get("root") >= prHier.get("child1"), `Root rank >= child1 (${prHier.get("root").toFixed(3)} vs ${prHier.get("child1").toFixed(3)})`);

// ─── computePageRank — normalization ────────────────────────────────────────

t.section("computePageRank — normalization");

// Non-regular graph: hub-and-spoke + chain (produces rank variance)
const largeConcepts = {};
largeConcepts["hub"] = { related_to: [] };
for (let i = 0; i < 30; i++) {
  largeConcepts[`spoke${i}`] = { related_to: ["hub"] };
}
for (let i = 0; i < 20; i++) {
  largeConcepts[`chain${i}`] = { related_to: [`chain${i + 1}`] };
}
largeConcepts["chain20"] = { related_to: [] }; // terminal
const prLarge = computePageRank(largeConcepts);
t.assert(prLarge.size === 52, "Large graph → 52 nodes");

let minVal = Infinity, maxVal = -Infinity;
for (const v of prLarge.values()) {
  if (v < minVal) minVal = v;
  if (v > maxVal) maxVal = v;
}
t.assert(minVal >= 0, `Min value >= 0 (${minVal.toFixed(4)})`);
t.assert(maxVal <= 1, `Max value <= 1 (${maxVal.toFixed(4)})`);
t.assertClose(maxVal, 1.0, 0.01, "Max normalized to 1.0");
t.assertClose(minVal, 0.0, 0.01, "Min normalized to 0.0");

// Verify hub is top-ranked
t.assert(prLarge.get("hub") === maxVal, "Hub is the highest ranked node");

// Regular graph (uniform degree) → all 0.5 (degenerate normalization)
const regularConcepts = {};
for (let i = 0; i < 20; i++) {
  regularConcepts[`r${i}`] = { related_to: [`r${(i + 1) % 20}`] };
}
const prRegular = computePageRank(regularConcepts);
t.assertClose(prRegular.get("r0"), 0.5, 0.01, "Regular graph → uniform 0.5");

// ─── computePageRank — convergence ──────────────────────────────────────────

t.section("computePageRank — convergence");

// Same result with few vs many iterations (for a simple graph)
const pr10 = computePageRank(starConcepts, { iterations: 10 });
const pr100 = computePageRank(starConcepts, { iterations: 100 });
t.assertClose(pr10.get("hub"), pr100.get("hub"), 0.01, "Converges within 10 iterations");

// Custom damping
const prLowDamp = computePageRank(starConcepts, { damping: 0.5 });
t.assert(prLowDamp.get("hub") > 0.5, `Low damping: hub still highest (${prLowDamp.get("hub").toFixed(3)})`);

// ─── computePageRank — dangling nodes ───────────────────────────────────────

t.section("computePageRank — dangling nodes");

const danglingConcepts = {
  "a": { related_to: ["b", "c"] },
  "b": { related_to: [] },      // dangling: no outbound
  "c": { related_to: ["a"] }
};
const prDangle = computePageRank(danglingConcepts);
t.assert(prDangle.size === 3, "Dangling → 3 nodes");
// All values should be valid numbers in [0, 1]
for (const [node, val] of prDangle) {
  t.assert(val >= 0 && val <= 1, `Dangling node ${node} in [0,1] (${val.toFixed(3)})`);
}

// ─── computePageRank — implicit nodes ───────────────────────────────────────

t.section("computePageRank — implicit nodes");

// Node "z" appears as target but not as a key in concepts
const implicitConcepts = {
  "x": { related_to: ["y", "z"] },
  "y": { related_to: ["z"] }
};
const prImplicit = computePageRank(implicitConcepts);
t.assert(prImplicit.has("z"), "Implicit target node is included");
t.assert(prImplicit.get("z") === 1.0, `Implicit node z is most pointed-to (${prImplicit.get("z")?.toFixed(3)})`);

// ─── computeStructuralBoostPR ───────────────────────────────────────────────

t.section("computeStructuralBoostPR");

t.assert(computeStructuralBoostPR(0) === 1.0, "Centrality 0 → 1.0 (no boost)");
t.assert(computeStructuralBoostPR(0.5) === 1.5, "Centrality 0.5 → 1.5");
t.assert(computeStructuralBoostPR(1.0) === 2.0, "Centrality 1.0 → 2.0 (max boost)");
t.assert(computeStructuralBoostPR(1.5) === 2.0, "Centrality >1 clamped to 2.0");
t.assert(computeStructuralBoostPR(-0.5) === 1.0, "Negative centrality clamped to 1.0");

// Same range as original computeStructuralBoost
t.assert(computeStructuralBoostPR(0) === computeStructuralBoost(0), "PR(0) == inDegree(0) == 1.0");
t.assert(computeStructuralBoostPR(1) === computeStructuralBoost(10), "PR(1) == inDegree(10) == 2.0");

// ─── scoreLearning with pageRankMap ─────────────────────────────────────────

t.section("scoreLearning — PageRank weighting");

const mockLearning = {
  slug: "docker-deployment-guide",
  title: "Docker deployment guide",
  headline: "How to deploy containers in production",
  tags: ["docker", "deployment", "devops"],
  body: "Use Docker Compose for multi-container setups. Configure networking and volumes.",
  type: "pattern"
};
const mockMeta = {
  learnings: {
    "docker-deployment-guide": { hit_count: 5, created_date: "2026-01-01", last_accessed: "2026-03-01" }
  }
};
const mockVitalityMap = new Map([
  ["docker-deployment-guide", { vitality: 0.8, zone: "active", accessCount: 5 }]
]);

// Graph tokens that match the learning (e.g., expanded from a query)
const graphTokens = ["docker", "containers", "devops"];

// Without PageRank: graph score = count of matches
const resNoRank = scoreLearning(
  mockLearning, tokenize("containers networking"), mockMeta, null,
  graphTokens, false, null, mockVitalityMap, null
);
t.assert(resNoRank !== null, "Without PageRank: result exists");
const graphScoreNoRank = resNoRank.rawScores.graph;
t.assert(graphScoreNoRank > 0, `Without PageRank: graph signal > 0 (${graphScoreNoRank})`);

// With PageRank: graph score = weighted sum
const mockPageRank = new Map([
  ["docker", 0.9],
  ["containers", 0.3],
  ["devops", 0.7]
]);
const resWithRank = scoreLearning(
  mockLearning, tokenize("containers networking"), mockMeta, null,
  graphTokens, false, null, mockVitalityMap, mockPageRank
);
t.assert(resWithRank !== null, "With PageRank: result exists");
const graphScoreWithRank = resWithRank.rawScores.graph;
t.assert(graphScoreWithRank > 0, `With PageRank: graph signal > 0 (${graphScoreWithRank})`);

// Graph matches in both cases are "docker" + "devops" (found in tags/body).
// "containers" is in the body too. So 3 matches.
// Without PageRank: score = 3 (count)
// With PageRank: score = (0.5+0.9) + (0.5+0.3) + (0.5+0.7) = 3.4
t.assert(graphScoreWithRank !== graphScoreNoRank, `PageRank changes graph score (${graphScoreWithRank} vs ${graphScoreNoRank})`);

// A high-PageRank match should contribute more
const highPR = new Map([["docker", 0.99], ["containers", 0.01], ["devops", 0.01]]);
const lowPR = new Map([["docker", 0.01], ["containers", 0.01], ["devops", 0.01]]);
const resHigh = scoreLearning(mockLearning, tokenize("containers networking"), mockMeta, null, graphTokens, false, null, mockVitalityMap, highPR);
const resLow = scoreLearning(mockLearning, tokenize("containers networking"), mockMeta, null, graphTokens, false, null, mockVitalityMap, lowPR);
t.assert(resHigh.rawScores.graph > resLow.rawScores.graph,
  `Higher PageRank → higher graph score (${resHigh.rawScores.graph.toFixed(2)} > ${resLow.rawScores.graph.toFixed(2)})`);

// ─── scoreFile with pageRankMap ─────────────────────────────────────────────

t.section("scoreFile — PageRank weighting");

const mockContent = `# Session 2026-03-01
Worked on Docker deployment pipeline.
Fixed networking issues with containers.
Deployed to production successfully.`;

const fileGraphTokens = ["docker", "containers"];

const sfNoRank = scoreFile("memory/sessions/test.md", mockContent, tokenize("pipeline"), fileGraphTokens, false, null);
t.assert(sfNoRank !== null, "scoreFile without PageRank: result exists");

const sfWithRank = scoreFile("memory/sessions/test.md", mockContent, tokenize("pipeline"), fileGraphTokens, false, mockPageRank);
t.assert(sfWithRank !== null, "scoreFile with PageRank: result exists");
t.assert(sfWithRank.score !== sfNoRank.score, `PageRank changes file score (${sfWithRank.score} vs ${sfNoRank.score})`);

// ─── Backward compatibility ──────────────────────────────────────────────────

t.section("Backward compatibility");

// Existing calls without pageRankMap should still work
const backCompat = scoreLearning(
  mockLearning, tokenize("docker production setup"), mockMeta, null, [], false, null, mockVitalityMap
);
t.assert(backCompat !== null, "scoreLearning without 9th param still works");

const backCompatFile = scoreFile("test.md", mockContent, tokenize("docker deployment"));
t.assert(backCompatFile !== null, "scoreFile without 6th param still works");

// ─── Performance ──────────────────────────────────────────────────────────────

t.section("Performance");

// Build a medium-sized graph (600 nodes, ~3000 edges) and verify it completes fast
const perfConcepts = {};
for (let i = 0; i < 600; i++) {
  const related = [];
  for (let j = 0; j < 5; j++) {
    related.push(`node${(i + j * 7 + 1) % 600}`);
  }
  perfConcepts[`node${i}`] = { related_to: related };
}

const t0 = performance.now();
const prPerf = computePageRank(perfConcepts);
const elapsed = performance.now() - t0;

t.assert(prPerf.size === 600, `600-node graph computed (${prPerf.size} nodes)`);
t.assert(elapsed < 500, `PageRank over 600 nodes in ${elapsed.toFixed(1)}ms (< 500ms)`);

// Verify result quality: all values in [0, 1]
let allInRange = true;
for (const v of prPerf.values()) {
  if (v < 0 || v > 1) { allInRange = false; break; }
}
t.assert(allInRange, "All 600 nodes in [0, 1] range");

// ─── Summary ─────────────────────────────────────────────────────────────────

export const results = t.summary();
