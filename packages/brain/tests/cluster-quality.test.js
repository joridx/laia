/**
 * P12.2: Cluster quality filter tests
 * Tests clusterQualityScore, integration with detectClusters and planDistillation.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("cluster-quality (P12.2)");

// ─── Setup: temporary BRAIN_PATH ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cq-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

for (const dir of [
  "memory/sessions",
  "memory/learnings",
  "memory/notes",
  "memory/projects",
  "memory/todos",
  "knowledge/general",
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}

fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({
  version: "2.0", sessions: [], consolidation: {}
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({
  tag_hits: {}, search_hits: {}, total_queries: 0
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({
  concepts: {}
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "memory/todos.json"), "[]");

// ─── Helper: create learning + meta entry ──────────────────────────────────────

const metaData = { learnings: {} };

function makeLearning(slug, opts = {}) {
  const {
    title = slug,
    type = "learning",
    tags = ["test"],
    dir = "memory/learnings",
    hit_count = 0,
    search_appearances = 0,
    search_followup_hits = 0,
    body = `${title} body content about the topic.`
  } = opts;

  const filePath = `${dir}/${slug}.md`;
  const content = `---\ntitle: "${title}"\ntype: ${type}\ntags: [${tags.join(", ")}]\ncreated: 2026-03-20\nslug: ${slug}\n---\n\n${body}\n\n${tags.map(t => `#${t}`).join(" ")}\n`;

  fs.writeFileSync(path.join(tmpDir, filePath), content);

  metaData.learnings[slug] = {
    title,
    file: filePath,
    type,
    tags,
    hit_count,
    search_appearances,
    search_followup_hits,
    created_date: "2026-03-20",
    last_accessed: hit_count > 0 ? "2026-03-20" : null,
    stale: false
  };
}

function saveMeta() {
  fs.writeFileSync(
    path.join(tmpDir, "learnings-meta.json"),
    JSON.stringify(metaData, null, 2)
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// clusterQualityScore — unit tests (pure function, no side effects)
// ═══════════════════════════════════════════════════════════════════════════════

// Create test learnings with different profiles
makeLearning("high-ops-1", {
  title: "Jenkins token renewal process",
  type: "warning", tags: ["jenkins", "auth", "token"],
  hit_count: 25, search_appearances: 8
});
makeLearning("high-ops-2", {
  title: "Jenkins API connection requires specific headers",
  type: "pattern", tags: ["jenkins", "api", "auth"],
  hit_count: 20, search_appearances: 5
});
makeLearning("high-ops-3", {
  title: "Jenkins pipeline timeout warning",
  type: "warning", tags: ["jenkins", "pipeline", "timeout"],
  hit_count: 15, search_appearances: 3
});
makeLearning("med-ops-1", {
  title: "Docker compose networking basics",
  type: "learning", tags: ["docker", "compose"],
  hit_count: 5, search_appearances: 1
});
makeLearning("med-ops-2", {
  title: "Docker volume mount permissions",
  type: "pattern", tags: ["docker", "volumes"],
  hit_count: 8, search_appearances: 2
});
makeLearning("low-note-1", {
  title: "Kubernetes Deployment",
  type: "learning", tags: ["kubernetes"],
  dir: "memory/notes",
  hit_count: 0, search_appearances: 0
});
makeLearning("low-note-2", {
  title: "Kubernetes Services",
  type: "learning", tags: ["kubernetes"],
  dir: "memory/notes",
  hit_count: 0, search_appearances: 0
});
makeLearning("low-note-3", {
  title: "Kubernetes ReplicaSet",
  type: "learning", tags: ["kubernetes"],
  dir: "memory/notes",
  hit_count: 0, search_appearances: 0
});
makeLearning("low-note-4", {
  title: "Kubernetes Intro",
  type: "learning", tags: ["kubernetes"],
  dir: "memory/notes",
  hit_count: 0, search_appearances: 0
});
makeLearning("mixed-1", {
  title: "Docker basics intro",
  type: "learning", tags: ["docker"],
  dir: "memory/notes",
  hit_count: 0, search_appearances: 0
});
makeLearning("mixed-gem", {
  title: "Docker Swarm deploy resource limits critical",
  type: "warning", tags: ["docker", "swarm", "deploy"],
  hit_count: 30, search_appearances: 10
});

saveMeta();

// ─── Import module (after BRAIN_PATH + meta is set) ───────────────────────────

const { clusterQualityScore, MIN_CLUSTER_QUALITY } = await import("../maintenance.js");

// ─── Edge cases ─────────────────────────────────────────────────────────────

t.section("clusterQualityScore — edge cases");

t.assert(clusterQualityScore(null, metaData) === 0, "null slugs returns 0");
t.assert(clusterQualityScore([], metaData) === 0, "empty slugs returns 0");
t.assert(clusterQualityScore(["nonexistent-slug"], metaData) >= 0, "unknown slug doesn't crash");
t.assert(clusterQualityScore(["nonexistent-slug"], null) === 0, "null meta returns 0");
t.assert(clusterQualityScore(["nonexistent-slug"], {}) >= 0, "empty meta doesn't crash");

// ─── Score range ────────────────────────────────────────────────────────────

t.section("clusterQualityScore — score range (0..1)");

const highScore = clusterQualityScore(["high-ops-1", "high-ops-2", "high-ops-3"], metaData);
t.assert(highScore >= 0 && highScore <= 1, `high-ops score in [0,1]: ${highScore}`);
t.assert(highScore >= 0.6, `high-ops score >= 0.6: ${highScore}`);

const lowScore = clusterQualityScore(["low-note-1", "low-note-2", "low-note-3", "low-note-4"], metaData);
t.assert(lowScore >= 0 && lowScore <= 1, `low-notes score in [0,1]: ${lowScore}`);
t.assert(lowScore <= 0.35, `low-notes score <= 0.35: ${lowScore}`);

const medScore = clusterQualityScore(["med-ops-1", "med-ops-2"], metaData);
t.assert(medScore >= 0 && medScore <= 1, `med-ops score in [0,1]: ${medScore}`);
t.assert(medScore > lowScore, `med-ops (${medScore}) > low-notes (${lowScore})`);
t.assert(medScore < highScore, `med-ops (${medScore}) < high-ops (${highScore})`);

// ─── Signal 1: Source (notes/ vs learnings/) ────────────────────────────────

t.section("clusterQualityScore — Signal 1: source differentiation");

// Same hit_count=0, same type=learning, only difference is notes/ vs learnings/
makeLearning("src-learning", { type: "learning", hit_count: 0, search_appearances: 0 });
makeLearning("src-note", { type: "learning", dir: "memory/notes", hit_count: 0, search_appearances: 0 });
saveMeta();

const learnScore = clusterQualityScore(["src-learning"], metaData);
const noteScore = clusterQualityScore(["src-note"], metaData);
t.assert(learnScore > noteScore, `learnings/ (${learnScore}) > notes/ (${noteScore})`);

// Codex fix #2: soft separation (not 5x, more like 2x)
const ratio = learnScore / noteScore;
t.assert(ratio < 3, `source ratio is soft, not extreme: ${ratio.toFixed(1)}x`);

// ─── Signal 2: Usage (hit_count + search_appearances) ───────────────────────

t.section("clusterQualityScore — Signal 2: usage");

makeLearning("usage-zero", { hit_count: 0, search_appearances: 0 });
makeLearning("usage-low", { hit_count: 3, search_appearances: 1 });
makeLearning("usage-med", { hit_count: 10, search_appearances: 5 });
makeLearning("usage-high", { hit_count: 20, search_appearances: 10 });
makeLearning("usage-extreme", { hit_count: 100, search_appearances: 50 });
saveMeta();

const uZero = clusterQualityScore(["usage-zero"], metaData);
const uLow = clusterQualityScore(["usage-low"], metaData);
const uMed = clusterQualityScore(["usage-med"], metaData);
const uHigh = clusterQualityScore(["usage-high"], metaData);
const uExtreme = clusterQualityScore(["usage-extreme"], metaData);

t.assert(uLow > uZero, `usage-low (${uLow}) > usage-zero (${uZero})`);
t.assert(uMed > uLow, `usage-med (${uMed}) > usage-low (${uLow})`);
t.assert(uHigh > uMed, `usage-high (${uHigh}) > usage-med (${uMed})`);

// Saturation: extreme shouldn't be much higher than high (capped at 0.3)
const extremeDiff = uExtreme - uHigh;
t.assert(extremeDiff < 0.05, `usage saturates: extreme-high diff=${extremeDiff.toFixed(3)}`);

// ─── Signal 3: Type bonus ───────────────────────────────────────────────────

t.section("clusterQualityScore — Signal 3: type bonus");

makeLearning("type-warning", { type: "warning", hit_count: 0, search_appearances: 0 });
makeLearning("type-pattern", { type: "pattern", hit_count: 0, search_appearances: 0 });
makeLearning("type-learning", { type: "learning", hit_count: 0, search_appearances: 0 });
makeLearning("type-principle", { type: "principle", hit_count: 0, search_appearances: 0 });
saveMeta();

const tWarning = clusterQualityScore(["type-warning"], metaData);
const tPattern = clusterQualityScore(["type-pattern"], metaData);
const tLearning = clusterQualityScore(["type-learning"], metaData);
const tPrinciple = clusterQualityScore(["type-principle"], metaData);

t.assert(tWarning > tPattern, `warning (${tWarning}) > pattern (${tPattern})`);
t.assert(tPattern > tLearning, `pattern (${tPattern}) > learning (${tLearning})`);
t.assert(tLearning > tPrinciple, `learning (${tLearning}) > principle (${tPrinciple}) — already distilled`);

// ─── Hybrid scoring: avg + max guard (Codex fix #3) ────────────────────────

t.section("clusterQualityScore — hybrid avg+max (1 gem in noise)");

// Cluster: 1 high-quality gem + 4 low-quality notes
const mixedScore = clusterQualityScore(
  ["mixed-gem", "low-note-1", "low-note-2", "low-note-3", "low-note-4"],
  metaData
);
const pureNotesScore = clusterQualityScore(
  ["low-note-1", "low-note-2", "low-note-3", "low-note-4"],
  metaData
);

// Hybrid scoring should lift mixed above pure notes
t.assert(mixedScore > pureNotesScore,
  `mixed with gem (${mixedScore}) > pure notes (${pureNotesScore})`);

// The gem should meaningfully improve the score (max guard = 0.3×max)
const gemLift = mixedScore - pureNotesScore;
t.assert(gemLift > 0.05,
  `gem lifts score by ${gemLift.toFixed(3)} (>0.05 expected from max guard)`);

// But mixed cluster should still score less than pure high-quality
t.assert(mixedScore < highScore,
  `mixed (${mixedScore}) < pure high-ops (${highScore})`);

// ─── Ordering: high-quality clusters should sort first ──────────────────────

t.section("clusterQualityScore — ordering correctness");

t.assert(highScore > medScore, `high (${highScore}) > med (${medScore})`);
t.assert(medScore > lowScore, `med (${medScore}) > low (${lowScore})`);
t.assert(highScore > mixedScore, `high (${highScore}) > mixed (${mixedScore})`);
t.assert(mixedScore > lowScore, `mixed (${mixedScore}) > low (${lowScore})`);

// ─── MIN_CLUSTER_QUALITY constant ───────────────────────────────────────────

t.section("MIN_CLUSTER_QUALITY — threshold validation");

t.assert(typeof MIN_CLUSTER_QUALITY === "number", "MIN_CLUSTER_QUALITY is exported as number");
t.assert(MIN_CLUSTER_QUALITY > 0 && MIN_CLUSTER_QUALITY < 1, `threshold in (0,1): ${MIN_CLUSTER_QUALITY}`);

// Pure notes should be below or at threshold
t.assert(lowScore <= MIN_CLUSTER_QUALITY + 0.10,
  `pure notes (${lowScore}) near or below threshold (${MIN_CLUSTER_QUALITY})`);

// High-quality should be well above threshold
t.assert(highScore > MIN_CLUSTER_QUALITY + 0.20,
  `high-ops (${highScore}) well above threshold (${MIN_CLUSTER_QUALITY})`);

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: detectClusters returns quality_score
// ═══════════════════════════════════════════════════════════════════════════════

t.section("detectClusters — quality_score integration");

const { detectClusters } = await import("../maintenance.js");
const { setLearningsCache } = await import("../file-io.js");
const { rebuildFullIndex } = await import("../database.js");

// Rebuild index so detectClusters can find our test learnings
setLearningsCache(null);
rebuildFullIndex();

const { clusters, stats } = detectClusters({ maxResults: 50 });

// Every cluster should have quality_score
if (clusters.length > 0) {
  for (const c of clusters) {
    t.assert(typeof c.quality_score === "number",
      `cluster has quality_score: ${c.quality_score}`);
    t.assert(c.quality_score >= 0 && c.quality_score <= 1,
      `cluster quality in [0,1]: ${c.quality_score}`);
  }

  // Clusters should be sorted by quality (within same action group)
  const sameActionGroups = {};
  for (const c of clusters) {
    const key = c.suggested_action;
    if (!sameActionGroups[key]) sameActionGroups[key] = [];
    sameActionGroups[key].push(c);
  }
  for (const [action, group] of Object.entries(sameActionGroups)) {
    for (let i = 1; i < group.length; i++) {
      t.assert(group[i - 1].quality_score >= group[i].quality_score,
        `${action} group sorted by quality: ${group[i-1].quality_score} >= ${group[i].quality_score}`);
    }
  }
}

// Stats should have avg_quality
t.assert(typeof stats.avg_quality === "number", `stats has avg_quality: ${stats.avg_quality}`);

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: planDistillation respects quality filter
// ═══════════════════════════════════════════════════════════════════════════════

t.section("planDistillation — quality filter integration");

const { planDistillation, readDistillState, writeDistillState } = await import("../distillation.js");

// Reset distillation state
writeDistillState({
  version: 1,
  lastPlanAt: null,
  lastRatioCheckAt: null,
  queue: [],
  drafts: []
});

const plan = planDistillation({ force: true });
t.assert(typeof plan === "object", "planDistillation returns object");
t.assert(typeof plan.newClusters === "number", "plan has newClusters");

// If any clusters were queued, verify they all have qualityScore
const state = readDistillState();
for (const q of state.queue) {
  t.assert(typeof q.qualityScore === "number",
    `queue entry has qualityScore: ${q.qualityScore}`);
  t.assert(q.qualityScore >= MIN_CLUSTER_QUALITY,
    `queue entry quality (${q.qualityScore}) >= threshold (${MIN_CLUSTER_QUALITY})`);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ─── Summary ────────────────────────────────────────────────────────────────

const { passed, failed } = t.summary();
if (failed > 0) process.exit(1);
