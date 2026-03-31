/**
 * P12.4: Distillation effectiveness measurement tests
 * Tests computeDistillEffectiveness with various data scenarios.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("distill-effectiveness (P12.4)");

// ─── Setup ────────────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-eff-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

for (const dir of [
  "memory/sessions", "memory/learnings", "memory/projects",
  "memory/todos", "knowledge/general"
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({ version: "2.0", sessions: [], consolidation: {} }));
fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({ tag_hits: {}, search_hits: {}, total_queries: 0 }));
fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({ concepts: {} }));
fs.writeFileSync(path.join(tmpDir, "memory/todos.json"), "[]");

// Imports must be before writeMeta/writeDistillState calls
const { computeDistillEffectiveness } = await import("../distillation.js");
const { invalidateJsonCache } = await import("../file-io.js");

function writeMeta(learnings) {
  fs.writeFileSync(
    path.join(tmpDir, "learnings-meta.json"),
    JSON.stringify({ version: "1.0", learnings }, null, 2)
  );
  invalidateJsonCache();
}

function writeDistillState(state) {
  fs.writeFileSync(
    path.join(tmpDir, "distillation_state.json"),
    JSON.stringify(state, null, 2)
  );
  invalidateJsonCache();
}

function mkLearning(slug) {
  const content = `---\ntitle: "${slug}"\ntype: learning\ntags: [test]\ncreated: 2026-03-20\nslug: ${slug}\n---\n\nBody.\n`;
  fs.writeFileSync(path.join(tmpDir, "memory/learnings", `${slug}.md`), content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Empty state
// ═══════════════════════════════════════════════════════════════════════════════

writeMeta({});
writeDistillState({ version: 1, lastPlanAt: null, lastRatioCheckAt: null, queue: [], drafts: [] });

t.section("empty state");

const empty = computeDistillEffectiveness();
t.assert(empty !== null, "returns non-null for empty meta");
t.assert(empty.principles.count === 0, "0 principles");
t.assert(empty.sources.archived === 0, "0 archived");
t.assert(empty.pipeline.decisions === 0, "0 decisions");
t.assert(empty.effectiveness.dataConfidence === 0, "dataConfidence = 0");
t.assert(empty.effectiveness.scoreStatus === "insufficient_data", "status: insufficient_data");
t.assert(empty.effectiveness.effectivenessScore === 0, "score = 0");

// ═══════════════════════════════════════════════════════════════════════════════
// Minimal data: a few principles, no usage
// ═══════════════════════════════════════════════════════════════════════════════

t.section("minimal data — principles with no usage");

const minMeta = {};
for (let i = 1; i <= 7; i++) {
  const slug = `principle-${i}`;
  mkLearning(slug);
  minMeta[slug] = {
    title: `Principle ${i}`, file: `memory/learnings/${slug}.md`, type: "principle",
    tags: ["test"], hit_count: 0, search_appearances: 0, search_followup_hits: 0,
    created_date: "2026-03-01" // 19 days old
  };
}
writeMeta(minMeta);

const minimal = computeDistillEffectiveness();
t.assert(minimal.principles.count === 7, "7 principles");
t.assert(minimal.principles.withAppearances === 0, "none appeared in searches");
t.assert(minimal.principles.adoptionRate === 0, "adoption rate = 0");
t.assert(minimal.effectiveness.dataConfidence === 0, "confidence = 0 (0 appearances)");
// stalePrinciples: created 19 days ago, threshold is 21 → not stale yet
t.assert(minimal.principles.stalePrinciples.length === 0, "not stale yet (19d < 21d)");

// ═══════════════════════════════════════════════════════════════════════════════
// Stale principles (21+ days, 0 appearances)
// ═══════════════════════════════════════════════════════════════════════════════

t.section("stale principles detection");

const staleMeta = {};
for (let i = 1; i <= 5; i++) {
  const slug = `stale-p-${i}`;
  mkLearning(slug);
  staleMeta[slug] = {
    title: `Stale Principle ${i}`, file: `memory/learnings/${slug}.md`, type: "principle",
    tags: ["test"], hit_count: 0, search_appearances: 0, search_followup_hits: 0,
    created_date: "2026-02-15" // 33 days old
  };
}
// One non-stale (has appearances)
staleMeta["active-p"] = {
  title: "Active Principle", file: "memory/learnings/active-p.md", type: "principle",
  tags: ["test"], hit_count: 3, search_appearances: 5, search_followup_hits: 1,
  created_date: "2026-02-15"
};
mkLearning("active-p");
writeMeta(staleMeta);

const staleResult = computeDistillEffectiveness();
t.assert(staleResult.principles.count === 6, "6 principles total");
t.assert(staleResult.principles.stalePrinciples.length === 5, "5 stale principles");
t.assert(staleResult.principles.withAppearances === 1, "1 with appearances");

// ═══════════════════════════════════════════════════════════════════════════════
// Good data: principles with confirmations, archived sources, pipeline decisions
// ═══════════════════════════════════════════════════════════════════════════════

t.section("good data — effectiveness scoring");

const goodMeta = {};
// 10 principles, varying usage
for (let i = 1; i <= 10; i++) {
  const slug = `good-p-${i}`;
  mkLearning(slug);
  goodMeta[slug] = {
    title: `Good Principle ${i}`, file: `memory/learnings/${slug}.md`, type: "principle",
    tags: ["test"], hit_count: i * 2, search_appearances: i * 5,
    search_followup_hits: i, confirmation_count: Math.floor(i / 2),
    created_date: "2026-02-20"
  };
}
// 10 archived sources
for (let i = 1; i <= 10; i++) {
  const slug = `archived-${i}`;
  mkLearning(slug);
  goodMeta[slug] = {
    title: `Archived Source ${i}`, file: `memory/learnings/${slug}.md`, type: "learning",
    tags: ["test"], hit_count: 0, search_appearances: 0, search_followup_hits: 0,
    archived: true, created_date: "2026-02-01"
  };
}
writeMeta(goodMeta);

// Pipeline with decisions
writeDistillState({
  version: 1, lastPlanAt: "2026-03-20T00:00:00Z", lastRatioCheckAt: null,
  queue: [
    { clusterId: "c1", status: "approved", qualityScore: 0.72 },
    { clusterId: "c2", status: "approved", qualityScore: 0.65 },
    { clusterId: "c3", status: "approved", qualityScore: 0.80 },
    { clusterId: "c4", status: "rejected", qualityScore: 0.28 },
    { clusterId: "c5", status: "rejected", qualityScore: 0.31 },
    { clusterId: "c6", status: "pending", qualityScore: 0.55 },
  ],
  drafts: []
});

const good = computeDistillEffectiveness();

// Principles
t.assert(good.principles.count === 10, "10 principles");
t.assert(good.principles.withAppearances === 10, "all 10 appeared");
t.assert(good.principles.withConfirmations > 0, "some confirmed");
t.assert(good.principles.totalAppearances === 275, "total appearances = 5+10+...+50 = 275");
t.assert(good.principles.exposureConversion > 0, "exposure conversion > 0");
t.assert(good.principles.adoptionRate > 0, "adoption rate > 0");

// Sources
t.assert(good.sources.archived === 10, "10 archived");
t.assert(good.sources.noiseReduction === 0.5, "noise reduction = 10/(10+10) = 0.5");

// Pipeline
t.assert(good.pipeline.approved === 3, "3 approved");
t.assert(good.pipeline.rejected === 2, "2 rejected");
t.assert(good.pipeline.decisions === 5, "5 decisions");
t.assert(good.pipeline.approvalRate === 0.6, "approval rate = 60%");
t.assert(good.pipeline.avgApprovedQuality !== null, "avg approved quality computed");
t.assert(good.pipeline.avgRejectedQuality !== null, "avg rejected quality computed");

// Effectiveness
t.assert(good.effectiveness.dataConfidence === 1, "full confidence (enough data)");
t.assert(good.effectiveness.scoreStatus === "stable", "status: stable");
t.assert(good.effectiveness.rawScore > 0, "raw score > 0");
t.assert(good.effectiveness.effectivenessScore > 0, "effectiveness > 0");
t.assert(good.effectiveness.rawScore === good.effectiveness.effectivenessScore,
  "confidence=1 → raw = effective");

// Score in expected range
t.assert(good.effectiveness.effectivenessScore > 0.15, `score > 0.15: ${good.effectiveness.effectivenessScore}`);
t.assert(good.effectiveness.effectivenessScore < 0.80, `score < 0.80: ${good.effectiveness.effectivenessScore}`);

// Interpretation
t.assert(typeof good.effectiveness.interpretation === "string", "has interpretation");

// ═══════════════════════════════════════════════════════════════════════════════
// Confidence gating: moderate data → provisional
// ═══════════════════════════════════════════════════════════════════════════════

t.section("confidence gating — provisional");

// 3 principles (< 5 threshold), some appearances
const provMeta = {};
for (let i = 1; i <= 3; i++) {
  const slug = `prov-p-${i}`;
  mkLearning(slug);
  provMeta[slug] = {
    title: `Prov Principle ${i}`, file: `memory/learnings/${slug}.md`, type: "principle",
    tags: ["test"], hit_count: 10, search_appearances: 15,
    search_followup_hits: 3, confirmation_count: 2,
    created_date: "2026-02-20"
  };
}
writeMeta(provMeta);

// 8 decisions in pipeline
writeDistillState({
  version: 1, lastPlanAt: "2026-03-20T00:00:00Z", lastRatioCheckAt: null,
  queue: [
    ...Array(5).fill(null).map((_, i) => ({ clusterId: `pa-${i}`, status: "approved", qualityScore: 0.6 })),
    ...Array(3).fill(null).map((_, i) => ({ clusterId: `pr-${i}`, status: "rejected", qualityScore: 0.3 })),
  ],
  drafts: []
});

const prov = computeDistillEffectiveness();
t.assert(prov.effectiveness.dataConfidence > 0, "confidence > 0");
t.assert(prov.effectiveness.dataConfidence < 1, "confidence < 1 (insufficient principles)");
// 3 principles / 5 min = 0.6 → provisional range
t.assert(prov.effectiveness.scoreStatus === "provisional" || prov.effectiveness.scoreStatus === "insufficient_data",
  `status provisional or insufficient: ${prov.effectiveness.scoreStatus}`);
// Score should be discounted
t.assert(prov.effectiveness.effectivenessScore < prov.effectiveness.rawScore,
  "score discounted by confidence");

// ═══════════════════════════════════════════════════════════════════════════════
// Edge: null meta
// ═══════════════════════════════════════════════════════════════════════════════

t.section("edge cases");

fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), "{}");
invalidateJsonCache();
const nullResult = computeDistillEffectiveness();
t.assert(nullResult === null, "null meta → returns null");

// ─── Cleanup ────────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ─── Summary ────────────────────────────────────────────────────────────────

const { passed, failed } = t.summary();
if (failed > 0) process.exit(1);
