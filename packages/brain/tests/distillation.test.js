/**
 * P10.4: Distillation state I/O tests
 * Tests readDistillState, writeDistillState, emptyDistillState.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createSuite } from "./harness.js";

const t = createSuite("distillation");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-distill-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

for (const d of ["memory/learnings", "memory/sessions", "memory/projects", "memory/todos", "knowledge/general"]) {
  fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
}
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({ version: "2.0", sessions: [] }));
fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({ usage: {}, search_log: [] }));
fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({ version: "1.0", concepts: {} }));
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({ version: "1.0", learnings: {} }));

const { readDistillState, writeDistillState, emptyDistillState } = await import("../distillation.js");

t.section("state I/O");

t.assert(typeof readDistillState === "function", "readDistillState exported");
t.assert(typeof writeDistillState === "function", "writeDistillState exported");
t.assert(typeof emptyDistillState === "function", "emptyDistillState exported");

const fresh = readDistillState();
t.assert(fresh.version === 1, "fresh state has version 1");
t.assert(Array.isArray(fresh.queue), "fresh state has queue array");
t.assert(Array.isArray(fresh.drafts), "fresh state has drafts array");
t.assert(fresh.lastPlanAt === null, "fresh state lastPlanAt is null");

const state = emptyDistillState();
state.lastPlanAt = "2026-01-01T00:00:00.000Z";
writeDistillState(state);
const loaded = readDistillState();
t.assert(loaded.lastPlanAt === "2026-01-01T00:00:00.000Z", "round-trip persists lastPlanAt");
t.assert(Array.isArray(loaded.queue), "loaded state has queue");

// ─── Task 2 imports ───────────────────────────────────────────────────────────
const { planDistillation, computeDistillMetrics } = await import("../distillation.js");
const { setLearningsCache } = await import("../file-io.js");
const { rebuildFullIndex } = await import("../database.js");

// Create 4 learnings with highly overlapping tags to form a cluster
const today2 = new Date().toISOString().split("T")[0];
const makeLearning = (slug, title, tags) => {
  const content = `---\ntitle: ${title}\ntype: learning\ntags: [${tags.join(", ")}]\ncreated: ${today2}\n---\n\n${title} body text with relevant content about the topic.`;
  fs.writeFileSync(path.join(tmpDir, "memory/learnings", `${slug}.md`), content);
  const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf8"));
  meta.learnings[slug] = { file: `memory/learnings/${slug}.md`, created_date: today2, hit_count: 1 };
  fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(meta, null, 2));
};

makeLearning("auth-token-a", "Copilot auth token expires in 30 minutes", ["copilot", "auth", "token"]);
makeLearning("auth-token-b", "Copilot token must be refreshed every 25 minutes", ["copilot", "auth", "token"]);
makeLearning("auth-token-c", "Token refresh uses OAuth endpoint for Copilot auth", ["copilot", "auth", "token", "oauth"]);
makeLearning("auth-token-d", "Cache Copilot auth token to avoid repeated OAuth calls", ["copilot", "auth", "token", "cache"]);

// Invalidate in-memory cache and rebuild SQLite index from filesystem
setLearningsCache(null);
rebuildFullIndex();

t.section("computeDistillMetrics");

const metrics = computeDistillMetrics();
t.assert(typeof metrics.activeNotes === "number", "metrics has activeNotes");
t.assert(typeof metrics.principleNotes === "number", "metrics has principleNotes");
t.assert(metrics.ratio === null || typeof metrics.ratio === "number", "ratio is null or number");
t.assert(metrics.activeNotes >= 4, "at least 4 active notes");

t.section("planDistillation");

const plan = planDistillation({ force: true });
t.assert(typeof plan === "object", "planDistillation returns object");
t.assert(typeof plan.newClusters === "number", "plan has newClusters count");
t.assert(typeof plan.totalPending === "number", "plan has totalPending count");
t.assert(plan.newClusters >= 0, "newClusters is non-negative");
t.assert(plan.skipped !== true, "force:true bypasses cooldown");

const stateAfterPlan = readDistillState();
t.assert(stateAfterPlan.lastPlanAt !== null, "lastPlanAt set after plan");
t.assert(Array.isArray(stateAfterPlan.queue), "queue is array");

// re-plan without force → should skip (within cooldown)
const plan2 = planDistillation();
t.assert(plan2.skipped === true, "re-plan within cooldown is skipped");

// ─── Task 3 imports ───────────────────────────────────────────────────────────
const { getDistillStatus, isClusterStale } = await import("../distillation.js");

t.section("isClusterStale");

const stateForStale = readDistillState();
if (stateForStale.queue.length > 0) {
  const entry = stateForStale.queue[0];
  // Fresh entry with correct timestamps → not stale
  const stale = isClusterStale(entry);
  t.assert(typeof stale === "boolean", "isClusterStale returns boolean");
  t.assert(stale === false, "fresh entry with correct timestamps is not stale");

  // Tamper with timestamp → stale
  const tamperedEntry = {
    ...entry,
    sourceUpdatedAt: { ...entry.sourceUpdatedAt }
  };
  const firstSlug = entry.sourceSlugs[0];
  tamperedEntry.sourceUpdatedAt[firstSlug] = "1970-01-01T00:00:00.000Z";
  t.assert(isClusterStale(tamperedEntry) === true, "tampered mtime → stale");
}

t.section("getDistillStatus");

const status = getDistillStatus();
t.assert(typeof status === "object", "getDistillStatus returns object");
t.assert(typeof status.pending === "number", "status has pending count");
t.assert(typeof status.drafted === "number", "status has drafted count");
t.assert(typeof status.approved === "number", "status has approved count");
t.assert(Array.isArray(status.pendingItems), "status has pendingItems array");
t.assert(Array.isArray(status.draftedItems), "status has draftedItems array");
t.assert(status.lastPlanAt !== undefined, "status has lastPlanAt");
t.assert(status.drafted === 0, "no drafts yet");

// ─── Task 4 ───────────────────────────────────────────────────────────────────
const { generateDrafts } = await import("../distillation.js");

t.section("generateDrafts");

// LLM unavailable in test env → graceful degradation
const genResult = await generateDrafts({ limit: 3 });
t.assert(typeof genResult === "object", "generateDrafts returns object");
t.assert(typeof genResult.generated === "number", "result has generated count");
t.assert(typeof genResult.skippedBudget === "number", "result has skippedBudget");
t.assert(typeof genResult.skippedLlm === "number", "result has skippedLlm");
t.assert(genResult.generated >= 0, "generated is non-negative");
t.assert(genResult.generated + genResult.skippedBudget + genResult.skippedLlm >= 0, "counts non-negative");

// ─── Task 5 ───────────────────────────────────────────────────────────────────
const { approveDraft, rejectDraft } = await import("../distillation.js");

t.section("rejectDraft");

const fakeState = readDistillState();
fakeState.queue.push({
  clusterId: "clu_test_reject",
  sourceSlugs: ["auth-token-a", "auth-token-b"],
  sourceUpdatedAt: {},
  size: 2, avgSimilarity: 0.7,
  status: "drafted", draftId: "dr_test_reject"
});
fakeState.drafts.push({
  draftId: "dr_test_reject", clusterId: "clu_test_reject",
  title: "Test Principle", content: "Test content.", tags: ["test"],
  sources: ["auth-token-a", "auth-token-b"],
  generatedAt: new Date().toISOString(), status: "drafted"
});
writeDistillState(fakeState);

const rejectResult = rejectDraft("dr_test_reject");
t.assert(rejectResult.ok === true, "rejectDraft returns ok:true");
const afterReject = readDistillState();
t.assert(afterReject.drafts.find(d => d.draftId === "dr_test_reject")?.status === "rejected", "draft marked rejected");
t.assert(afterReject.queue.find(q => q.clusterId === "clu_test_reject")?.status === "pending", "queue entry reset to pending for regeneration");

t.section("approveDraft");

const approveState = readDistillState();
let ctcMtime, ctdMtime;
try {
  ctcMtime = fs.statSync(path.join(tmpDir, "memory/learnings/auth-token-c.md")).mtime.toISOString();
  ctdMtime = fs.statSync(path.join(tmpDir, "memory/learnings/auth-token-d.md")).mtime.toISOString();
} catch {
  ctcMtime = new Date().toISOString();
  ctdMtime = new Date().toISOString();
}
approveState.queue.push({
  clusterId: "clu_test_approve",
  sourceSlugs: ["auth-token-c", "auth-token-d"],
  sourceUpdatedAt: { "auth-token-c": ctcMtime, "auth-token-d": ctdMtime },
  size: 2, avgSimilarity: 0.6,
  status: "drafted", draftId: "dr_test_approve"
});
approveState.drafts.push({
  draftId: "dr_test_approve", clusterId: "clu_test_approve",
  title: "Copilot Auth Token Handling",
  content: "Cache and refresh Copilot OAuth tokens proactively every 25 minutes.",
  tags: ["copilot", "auth"],
  sources: ["auth-token-c", "auth-token-d"],
  generatedAt: new Date().toISOString(), status: "drafted"
});
writeDistillState(approveState);

const approveResult = approveDraft("dr_test_approve");
t.assert(approveResult.ok === true, "approveDraft returns ok:true");
t.assert(typeof approveResult.principleSlug === "string", "approveDraft returns principleSlug");

const principleFile = path.join(tmpDir, "memory/learnings", `${approveResult.principleSlug}.md`);
t.assert(fs.existsSync(principleFile), "principle file created");

const finalMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf8"));
t.assert(finalMeta.learnings["auth-token-c"]?.archived === true, "source auth-token-c archived");
t.assert(finalMeta.learnings["auth-token-d"]?.archived === true, "source auth-token-d archived");

const finalState = readDistillState();
t.assert(finalState.drafts.find(d => d.draftId === "dr_test_approve")?.status === "approved", "draft marked approved");

t.section("end");
export const results = t.summary();
