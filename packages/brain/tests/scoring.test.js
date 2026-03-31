/**
 * Tests for scoring.js — vitality, intent, RRF, multi-signal scoring.
 */

import {
  VITALITY_ZONES, computeACTR, computeStructuralBoost, computeAccessSaturation,
  classifyVitalityZone, classifyIntent, fuseRRF, scoreLearning, scoreFile,
  DEFAULT_SIGNAL_WEIGHTS, INTENT_WEIGHTS, RRF_K, TYPE_PRIOR, getTypePrior
} from "../scoring.js";
import { tokenize } from "../utils.js";
import { signalEnabled } from "../signal-config.js";
import { createSuite } from "./harness.js";

const t = createSuite("scoring");

// ─── computeACTR ─────────────────────────────────────────────────────────────

t.section("computeACTR");

// Zero accesses + 30 days: decays from 0.5 with half-life 60 days
const zeroAccess30d = computeACTR(0, 30);
t.assert(zeroAccess30d > 0.3 && zeroAccess30d < 0.5, `Zero accesses, 30d → decayed (${zeroAccess30d.toFixed(3)})`);
t.assert(computeACTR(0, 0) === 0.5, "Zero accesses, 0d → 0.5 (brand new)");
t.assert(computeACTR(5, 0) === 1.0, "Zero lifetime → 1.0 (brand new)");

const fresh = computeACTR(10, 1);
t.assert(fresh > 0.8, `Fresh note (10 hits, 1 day) → high (${fresh.toFixed(3)})`);

const old = computeACTR(1, 365);
t.assert(old < 0.5, `Old note (1 hit, 365 days) → low (${old.toFixed(3)})`);

const a5 = computeACTR(5, 30);
const a20 = computeACTR(20, 30);
t.assert(a20 > a5, `More accesses → higher vitality (${a20.toFixed(3)} > ${a5.toFixed(3)})`);

const d7 = computeACTR(5, 7);
const d90 = computeACTR(5, 90);
t.assert(d7 > d90, `Newer → higher vitality (${d7.toFixed(3)} > ${d90.toFixed(3)})`);

for (const [n, L] of [[1,1], [100,1], [1,1000], [100,1000]]) {
  const v = computeACTR(n, L);
  t.assert(v >= 0 && v <= 1, `ACT-R(${n},${L}) in [0,1] → ${v.toFixed(3)}`);
}

// ─── computeStructuralBoost ──────────────────────────────────────────────────

t.section("computeStructuralBoost");

t.assert(computeStructuralBoost(0) === 1.0, "No links → 1.0 (no boost)");
t.assert(computeStructuralBoost(5) === 1.5, "5 links → 1.5");
t.assert(computeStructuralBoost(10) === 2.0, "10 links → 2.0 (max)");
t.assert(computeStructuralBoost(100) === 2.0, "100 links → 2.0 (capped at 10)");

// ─── computeAccessSaturation ─────────────────────────────────────────────────

t.section("computeAccessSaturation");

t.assert(computeAccessSaturation(0) === 0, "Zero accesses → 0");
t.assertClose(computeAccessSaturation(10), 0.632, 0.01, "10 accesses → ~63%");
t.assertClose(computeAccessSaturation(20), 0.865, 0.01, "20 accesses → ~86%");
const sat30 = computeAccessSaturation(30);
t.assert(sat30 > 0.9 && sat30 < 1.0, `30 accesses → ~95% (${sat30.toFixed(3)})`);

// ─── classifyVitalityZone ────────────────────────────────────────────────────

t.section("classifyVitalityZone");

t.assert(classifyVitalityZone(0.8) === "active", "0.8 → active");
t.assert(classifyVitalityZone(0.6) === "active", "0.6 → active (boundary)");
t.assert(classifyVitalityZone(0.59) === "stale", "0.59 → stale");
t.assert(classifyVitalityZone(0.3) === "stale", "0.3 → stale (boundary)");
t.assert(classifyVitalityZone(0.29) === "cold", "0.29 → cold (between stale 0.30 and fading 0.10)");
t.assert(classifyVitalityZone(0.15) === "cold", "0.15 → cold (boundary)");
t.assert(classifyVitalityZone(0.14) === "fading", "0.14 → fading");
t.assert(classifyVitalityZone(0.10) === "fading", "0.10 → fading (boundary)");
t.assert(classifyVitalityZone(0.09) === "archived", "0.09 → archived");
t.assert(classifyVitalityZone(0.1) === "fading", "0.1 → fading (boundary)");
t.assert(classifyVitalityZone(0.09) === "archived", "0.09 → archived");
t.assert(classifyVitalityZone(0.5, true) === "archived", "Archived flag overrides vitality");

// ─── classifyIntent ──────────────────────────────────────────────────────────

t.section("classifyIntent");

const proc = classifyIntent("how to setup docker containers");
t.assert(proc.intent === "procedural", "Procedural: 'how to setup'");
t.assert(proc.confidence === "high" || proc.confidence === "medium", "Procedural has confidence");

const epis = classifyIntent("what happened last session yesterday");
t.assert(epis.intent === "episodic", "Episodic: 'what happened last session yesterday'");

const deci = classifyIntent("should we compare alternatives trade-off");
t.assert(deci.intent === "decision", "Decision: 'should we compare alternatives'");

const sem = classifyIntent("postgres connection string");
t.assert(sem.intent === "semantic", "Semantic: generic query");
t.assert(sem.confidence === "low", "Semantic has low confidence");

const catProc = classifyIntent("com fer deploy a producció");
t.assert(catProc.intent === "procedural", "Catalan procedural: 'com fer'");

const catEpis = classifyIntent("què va passar amb el deploy");
t.assert(catEpis.intent === "episodic", "Catalan episodic: 'què va passar'");

const catDeci = classifyIntent("per què vam decidir usar docker");
t.assert(catDeci.intent === "decision", "Catalan decision: 'per què decidir'");

// ─── fuseRRF ─────────────────────────────────────────────────────────────────

t.section("fuseRRF");

const signals = [
  { name: "tags", scores: new Map([["a", 3], ["b", 1]]) },
  { name: "title", scores: new Map([["a", 2], ["c", 5]]) },
];
const weights = { tags: 3, title: 4 };
const fused = fuseRRF(signals, weights);

t.assert(fused.has("a"), "RRF: 'a' present in both signals");
t.assert(fused.has("b"), "RRF: 'b' present in tags");
t.assert(fused.has("c"), "RRF: 'c' present in title");
t.assert(fused.get("a") > fused.get("b"), "RRF: 'a' ranked higher than 'b' (multi-signal)");
t.assert(fused.get("a") > 0, "RRF: scores are positive");

const emptyFused = fuseRRF([], {});
t.assert(emptyFused.size === 0, "RRF: empty signals → empty result");

// ─── scoreLearning ───────────────────────────────────────────────────────────

t.section("scoreLearning");

const mockLearning = {
  slug: "test-learning",
  title: "Docker setup for production",
  headline: "Configure Docker containers with proper networking",
  tags: ["docker", "devops", "production"],
  body: "Use docker-compose for multi-container setups. Configure networks and volumes properly.",
  type: "pattern"
};

const mockMeta = {
  learnings: { "test-learning": { hit_count: 5, created_date: "2026-01-01" } }
};

const mockVitalityMap = new Map([["test-learning", { vitality: 0.7, zone: "active" }]]);

const res1 = scoreLearning(
  mockLearning, tokenize("docker production setup"), mockMeta, null, [], false, null, mockVitalityMap
);
t.assert(res1 !== null, "Strong match returns result");
t.assert(res1.score > 0, `Strong match has positive score (${res1.score})`);
t.assert(res1.signals.tags > 0, "Tags signal active");
t.assert(res1.signals.title > 0, "Title signal active");
t.assert(res1.activeSignals >= 3, `Multiple signals active (${res1.activeSignals})`);

const res2 = scoreLearning(
  mockLearning, tokenize("python machine learning"), mockMeta, null, [], false, null, mockVitalityMap
);
if (signalEnabled("freshness")) {
  // Freshness ON: vitality+zone count as signals → passes gate with 2 signals
  t.assert(res2 !== null, "Unrelated query passes gate (vitality+zone = 2 signals)");
  t.assert(res2.signals.tags === undefined, "No tag signal for unrelated query");
  t.assert(res2.signals.title === undefined, "No title signal for unrelated query");
} else {
  // Freshness OFF: no vitality signal → 0 active signals → fails gate → null
  t.assert(res2 === null, "Freshness OFF + unrelated query → null (fails gate)");
}

const res2b = scoreLearning(
  mockLearning, tokenize("python machine learning"), mockMeta, null, [], false, null, null
);
t.assert(res2b === null, "Without vitality, unrelated query fails gate");

const res3 = scoreLearning(
  mockLearning, tokenize("python machine learning"), mockMeta, null, [], true, null, mockVitalityMap
);
t.assert(res3 !== null, "showAll=true bypasses gate filter");

const res4 = scoreLearning(
  mockLearning, tokenize("docker setup"), mockMeta, "devops", [], false, null, mockVitalityMap
);
const res5 = scoreLearning(
  mockLearning, tokenize("docker setup"), mockMeta, null, [], false, null, mockVitalityMap
);
t.assert(res4.score > res5.score, `Project match boosts score (${res4.score} > ${res5.score})`);

const res6 = scoreLearning(
  mockLearning, tokenize("docker setup"), mockMeta, null, [], false, INTENT_WEIGHTS.procedural, mockVitalityMap
);
const res7 = scoreLearning(
  mockLearning, tokenize("docker setup"), mockMeta, null, [], false, INTENT_WEIGHTS.episodic, mockVitalityMap
);
t.assert(res6.score !== res7.score, `Different intents → different scores (proc=${res6.score}, epis=${res7.score})`);

const res8 = scoreLearning(
  mockLearning, tokenize("containers"), mockMeta, null, ["docker", "devops"], false, null, mockVitalityMap
);
t.assert(res8 !== null, "Graph tokens help pass gate");
t.assert(res8.signals.graph > 0, "Graph signal active via expansion");

// ─── scoreFile ───────────────────────────────────────────────────────────────

t.section("scoreFile");

const mockContent = `# Session 2026-03-01
Worked on Docker deployment pipeline.
Fixed networking issues with containers.
Deployed to production successfully.`;

const sf1 = scoreFile("memory/sessions/2026-03-01.md", mockContent, tokenize("docker deployment"));
t.assert(sf1 !== null, "File with matching content returns result");
t.assert(sf1.score > 0, `File score positive (${sf1.score})`);
t.assert(sf1.matchingTokens.length >= 2, "Multiple matching tokens");
t.assert(sf1.snippets.length > 0, "Snippets extracted");

const sf2 = scoreFile("knowledge/docker-guide.md", mockContent, tokenize("docker"));
const sf3 = scoreFile("memory/sessions/random.md", mockContent, tokenize("docker"));
t.assert(sf2.score > sf3.score, `Filename match boosts score (${sf2.score} > ${sf3.score})`);

const sf4 = scoreFile("test.md", mockContent, tokenize("python tensorflow"));
t.assert(sf4 === null, "No match returns null");

const sf5 = scoreFile("test.md", mockContent, tokenize("pipeline"), ["docker", "containers"]);
t.assert(sf5 !== null, "Graph tokens help file matching");
t.assert(sf5.viaGraph.length > 0, "viaGraph populated");

// ─── TYPE_PRIOR (P7.4) ──────────────────────────────────────────────────────

t.section("TYPE_PRIOR");

t.assert(TYPE_PRIOR.principle === 1.15, "Principle prior = 1.15 (15% boost)");
t.assert(TYPE_PRIOR.pattern === 1.05, "Pattern prior = 1.05 (5% boost)");
t.assert(TYPE_PRIOR.warning === 1.0, "Warning prior = 1.0 (no boost)");
t.assert(TYPE_PRIOR.learning === 1.0, "Learning prior = 1.0 (no boost)");

// Verify principle > pattern > warning/learning
t.assert(TYPE_PRIOR.principle > TYPE_PRIOR.pattern, "Principle prior > Pattern prior");
t.assert(TYPE_PRIOR.pattern > TYPE_PRIOR.learning, "Pattern prior > Learning prior");
t.assert(TYPE_PRIOR.warning === TYPE_PRIOR.learning, "Warning and learning have same prior");

// Verify boost is moderate (not excessive — respects ACT-R dynamics)
t.assert(TYPE_PRIOR.principle <= 1.2, "Principle boost is moderate (<=1.2)");
t.assert(TYPE_PRIOR.pattern <= 1.1, "Pattern boost is moderate (<=1.1)");

// ─── getTypePrior P12.5 Dominance penalty ───────────────────────────────────

t.section("getTypePrior dominance penalty (P12.5)");

// Below threshold: no penalty
const metaLow = { confirmation_count: 0, search_appearances: 5 };
const priorLow = getTypePrior("principle", metaLow, 100); // dominance = 5% < 25%
t.assert(priorLow === 1.15, `No penalty below threshold (got ${priorLow})`);

// Exactly at threshold: no penalty
const metaAt = { confirmation_count: 0, search_appearances: 25 };
const priorAt = getTypePrior("principle", metaAt, 100); // dominance = 25%
t.assert(priorAt === 1.15, `No penalty at threshold (got ${priorAt})`);

// Above threshold: soft penalty applied
const metaHigh = { confirmation_count: 0, search_appearances: 40 };
const priorHigh = getTypePrior("principle", metaHigh, 100); // dominance = 40% → penalty = 0.15
t.assert(priorHigh < 1.15, `Penalty applied above threshold (got ${priorHigh})`);
t.assert(Math.abs(priorHigh - 1.0) < 0.01, `40% dominance → boost ≈ 1.0 (got ${priorHigh})`);

// Extreme dominance: capped at 0.80
const metaExtreme = { confirmation_count: 0, search_appearances: 80 };
const priorExtreme = getTypePrior("principle", metaExtreme, 100); // dominance = 80% → penalty = 0.55 → cap
t.assert(priorExtreme === 0.80, `Extreme dominance capped at 0.80 (got ${priorExtreme})`);

// Insufficient queries: no penalty applied (< 30 queries)
const metaDominant = { confirmation_count: 0, search_appearances: 20 };
const priorFewQueries = getTypePrior("principle", metaDominant, 25); // only 25 total queries
t.assert(priorFewQueries === 1.15, `No penalty with < 30 total queries (got ${priorFewQueries})`);

// Confirmations still work alongside penalty
const metaConfirmed = { confirmation_count: 10, search_appearances: 50 };
const priorConfirmed = getTypePrior("principle", metaConfirmed, 100); // dominance = 50%, boost ≈ 1.337 - 0.25 = 1.087
t.assert(priorConfirmed < 1.337, `Confirmation boost reduced by dominance penalty (got ${priorConfirmed})`);
t.assert(priorConfirmed > 0.80, `Still above cap (got ${priorConfirmed})`);

// Non-principles unaffected
const priorPattern = getTypePrior("pattern", metaHigh, 100);
t.assert(priorPattern === 1.05, `Pattern unaffected by dominance penalty (got ${priorPattern})`);

// ─── Constants ───────────────────────────────────────────────────────────────

t.section("Constants");

t.assert(VITALITY_ZONES.active === 0.6, "VITALITY_ZONES.active = 0.6");
t.assert(VITALITY_ZONES.stale === 0.3, "VITALITY_ZONES.stale = 0.3");
t.assert(VITALITY_ZONES.fading === 0.1, "VITALITY_ZONES.fading = 0.1");
t.assert(RRF_K === 60, "RRF_K = 60");
t.assert(DEFAULT_SIGNAL_WEIGHTS.title === 4, "Title weight is highest (4)");
t.assert(DEFAULT_SIGNAL_WEIGHTS.graph === 1.5, "Graph weight is lowest (1.5)");

for (const [intent, w] of Object.entries(INTENT_WEIGHTS)) {
  const keys = Object.keys(w).sort().join(",");
  const expected = Object.keys(DEFAULT_SIGNAL_WEIGHTS).sort().join(",");
  t.assert(keys === expected, `${intent} weights have all signal keys`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export const results = t.summary();
