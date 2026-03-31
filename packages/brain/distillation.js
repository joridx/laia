/**
 * P10.4: Periodic distillation workflow.
 * planDistillation → generateDrafts → approveDraft / rejectDraft
 */

import * as fs from "fs";
import * as path from "path";
import { BRAIN_PATH, LEARNINGS_DIR } from "./config.js";
import { readFile, writeFile, readJSON } from "./file-io.js";
import { getAllLearnings, ensureLearningMeta } from "./learnings.js";
import { detectClusters, MIN_CLUSTER_QUALITY } from "./maintenance.js";
import { slugify } from "./utils.js";
import { isLlmAvailable, llmDistill, getRemainingBudget } from "./llm.js";
import { metaRepo } from "./database.js";
import { readMetaStable } from "./meta-io.js";

function _readMeta() { return readMetaStable(); }

const DISTILL_STATE_FILE = "distillation_state.json";

// ─── State I/O ────────────────────────────────────────────────────────────────

export function emptyDistillState() {
  return {
    version: 1,
    lastPlanAt: null,
    lastRatioCheckAt: null,
    queue: [],
    drafts: [],
    metrics: { activeNotes: 0, principleNotes: 0, ratio: null }
  };
}

export function readDistillState() {
  const raw = readJSON(DISTILL_STATE_FILE);
  if (!raw || raw.version !== 1) return emptyDistillState();
  return {
    ...emptyDistillState(),
    ...raw,
    queue: Array.isArray(raw.queue) ? raw.queue : [],
    drafts: Array.isArray(raw.drafts) ? raw.drafts : [],
  };
}

export function writeDistillState(state) {
  writeFile(DISTILL_STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export function computeDistillMetrics() {
  const allLearnings = getAllLearnings();
  const meta = _readMeta() || {};
  const archivedSlugs = new Set(
    Object.entries(meta.learnings || {}).filter(([, d]) => d.archived).map(([s]) => s)
  );
  const active = allLearnings.filter(l => !archivedSlugs.has(l.slug) && l.type !== "principle");
  const principles = allLearnings.filter(l => !archivedSlugs.has(l.slug) && l.type === "principle");
  const ratio = principles.length > 0 ? +(active.length / principles.length).toFixed(2) : null;
  return { activeNotes: active.length, principleNotes: principles.length, ratio };
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

const PLAN_COOLDOWN_DAYS = 30;
const RATIO_COOLDOWN_DAYS = 7;
const MIN_CLUSTER_SIZE = 4;
const MIN_SIMILARITY = 0.35;
const RATIO_THRESHOLD = 3.0;

export function planDistillation({ force = false } = {}) {
  const state = readDistillState();
  const now = new Date();

  if (!force && state.lastPlanAt) {
    const daysSince = (now - new Date(state.lastPlanAt)) / (1000 * 60 * 60 * 24);
    if (daysSince < PLAN_COOLDOWN_DAYS) {
      const metrics = computeDistillMetrics();
      if (metrics.ratio === null || metrics.ratio <= RATIO_THRESHOLD) {
        return { newClusters: 0, totalPending: state.queue.filter(q => q.status === "pending").length, skipped: true };
      }
      if (state.lastRatioCheckAt) {
        const daysSinceRatio = (now - new Date(state.lastRatioCheckAt)) / (1000 * 60 * 60 * 24);
        if (daysSinceRatio < RATIO_COOLDOWN_DAYS) {
          return { newClusters: 0, totalPending: state.queue.filter(q => q.status === "pending").length, skipped: true };
        }
      }
      state.lastRatioCheckAt = now.toISOString();
    }
  }

  const { clusters } = detectClusters({ minSimilarity: MIN_SIMILARITY, maxResults: 50 });
  // P12.2: Filter by size AND quality
  const candidates = clusters.filter(c => c.size >= MIN_CLUSTER_SIZE && c.quality_score >= MIN_CLUSTER_QUALITY);

  const existingFingerprints = new Set(state.queue.map(q => q.sourceSlugs.slice().sort().join("|")));

  let newClusters = 0;
  for (const cluster of candidates) {
    const fingerprint = cluster.slugs.slice().sort().join("|");
    if (existingFingerprints.has(fingerprint)) continue;

    const sourceUpdatedAt = {};
    for (const slug of cluster.slugs) {
      const filePath = path.join(BRAIN_PATH, LEARNINGS_DIR, `${slug}.md`);
      try { sourceUpdatedAt[slug] = fs.statSync(filePath).mtime.toISOString(); }
      catch { sourceUpdatedAt[slug] = null; }
    }

    state.queue.push({
      clusterId: `clu_${Date.now()}_${newClusters}`,
      sourceSlugs: cluster.slugs,
      sourceUpdatedAt,
      size: cluster.size,
      avgSimilarity: cluster.avg_similarity,
      qualityScore: cluster.quality_score || 0,  // P12.2
      status: "pending",
      draftId: null
    });
    newClusters++;
  }

  state.lastPlanAt = now.toISOString();
  writeDistillState(state);
  return { newClusters, totalPending: state.queue.filter(q => q.status === "pending").length };
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function isClusterStale(queueEntry) {
  for (const slug of queueEntry.sourceSlugs) {
    const filePath = path.join(BRAIN_PATH, LEARNINGS_DIR, `${slug}.md`);
    const recordedMtime = queueEntry.sourceUpdatedAt?.[slug];
    if (!recordedMtime) continue;
    try {
      const currentMtime = fs.statSync(filePath).mtime.toISOString();
      if (currentMtime !== recordedMtime) return true;
    } catch { return true; } // file deleted → stale
  }
  return false;
}

export function getDistillStatus() {
  const state = readDistillState();
  const counts = { pending: 0, drafted: 0, approved: 0, rejected: 0, stale: 0 };
  for (const q of state.queue) counts[q.status] = (counts[q.status] || 0) + 1;

  // Auto-detect stale pending entries
  let changed = false;
  for (const q of state.queue) {
    if (q.status === "pending" && isClusterStale(q)) {
      q.status = "stale";
      counts.stale = (counts.stale || 0) + 1;
      counts.pending = Math.max(0, (counts.pending || 0) - 1);
      changed = true;
    }
  }
  if (changed) writeDistillState(state);

  const pendingItems = state.queue
    .filter(q => q.status === "pending")
    .map(q => ({ clusterId: q.clusterId, size: q.size, avgSimilarity: q.avgSimilarity, sourceSlugs: q.sourceSlugs }));

  const draftedItems = state.drafts
    .filter(d => d.status === "drafted")
    .map(d => ({ draftId: d.draftId, title: d.title, content: d.content, tags: d.tags, sources: d.sources, generatedAt: d.generatedAt }));

  return { ...counts, pendingItems, draftedItems, lastPlanAt: state.lastPlanAt };
}

// ─── Generate ─────────────────────────────────────────────────────────────────

const MAX_DRAFTS_PER_SESSION = 3;
const DISTILL_COST = 4;

export async function generateDrafts({ limit = MAX_DRAFTS_PER_SESSION } = {}) {
  const state = readDistillState();
  const pending = state.queue.filter(q => q.status === "pending");

  if (!isLlmAvailable()) {
    return { generated: 0, skippedBudget: 0, skippedLlm: pending.length };
  }

  const candidates = pending
    .slice()
    // P12.2: Sort by quality_score (if available), then size, then similarity
    .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0) || b.size - a.size || b.avgSimilarity - a.avgSimilarity)
    .slice(0, limit);

  const allLearnings = getAllLearnings();
  const learningsBySlug = new Map(allLearnings.map(l => [l.slug, l]));

  let generated = 0, skippedBudget = 0, skippedLlm = 0;

  for (const qEntry of candidates) {
    const remaining = getRemainingBudget();
    if (remaining < DISTILL_COST) { skippedBudget++; continue; }

    const sources = qEntry.sourceSlugs
      .map(s => learningsBySlug.get(s))
      .filter(Boolean)
      .map(l => ({ slug: l.slug, title: l.title, tags: l.tags || [], body: l.body || l.headline || "" }));

    if (sources.length < 3) { skippedBudget++; continue; }

    const tagsUnion = [...new Set(sources.flatMap(l => l.tags))];
    const draft = await llmDistill(sources, tagsUnion);
    if (!draft) { skippedLlm++; continue; }

    const draftId = `dr_${Date.now()}_${generated}`;
    state.drafts.push({
      draftId,
      clusterId: qEntry.clusterId,
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      sources: draft.sources,
      generatedAt: new Date().toISOString(),
      status: "drafted"
    });
    qEntry.status = "drafted";
    qEntry.draftId = draftId;
    generated++;
  }

  writeDistillState(state);
  return { generated, skippedBudget, skippedLlm };
}

// ─── Approve / Reject ─────────────────────────────────────────────────────────

export function rejectDraft(draftId) {
  const state = readDistillState();
  const draft = state.drafts.find(d => d.draftId === draftId);
  if (!draft) return { ok: false, error: `Draft ${draftId} not found` };
  if (draft.status !== "drafted") return { ok: false, error: `Draft ${draftId} is not in drafted state (${draft.status})` };

  draft.status = "rejected";
  const qEntry = state.queue.find(q => q.clusterId === draft.clusterId);
  if (qEntry) qEntry.status = "pending"; // allow regeneration

  writeDistillState(state);
  return { ok: true };
}

export function approveDraft(draftId, { editedContent } = {}) {
  const state = readDistillState();
  const draft = state.drafts.find(d => d.draftId === draftId);
  if (!draft) return { ok: false, error: `Draft ${draftId} not found` };
  if (draft.status !== "drafted") return { ok: false, error: `Draft ${draftId} is not in drafted state (${draft.status})` };

  const qEntry = state.queue.find(q => q.clusterId === draft.clusterId);
  if (qEntry && isClusterStale(qEntry)) {
    return { ok: false, error: "Cluster is stale — source notes changed since draft was generated. Re-run plan + generate." };
  }

  const finalContent = editedContent || draft.content;
  const slug = slugify(draft.title);
  const filePath = `${LEARNINGS_DIR}/${slug}.md`;
  const cleanTags = (draft.tags || []).map(t => String(t).toLowerCase().trim());
  const sourcesLine = `\n\n**Distilled from:** ${draft.sources.join(", ")}`;
  const markdownContent = `---\ntitle: ${draft.title}\ntype: principle\ntags: [${cleanTags.join(", ")}]\ncreated: ${new Date().toISOString().split("T")[0]}\n---\n\n${finalContent}${sourcesLine}\n`;

  writeFile(filePath, markdownContent);
  ensureLearningMeta(slug, draft.title, filePath, "principle");

  const meta = _readMeta() || { learnings: {} };
  let archivedCount = 0;
  for (const sourceSlug of draft.sources) {
    if (!meta.learnings[sourceSlug] || meta.learnings[sourceSlug].archived) continue;
    meta.learnings[sourceSlug].archived = true;
    meta.learnings[sourceSlug].archived_by = `distillation:${slug}`;
    meta.learnings[sourceSlug].archived_at = new Date().toISOString();
    archivedCount++;
  }
  writeFile("learnings-meta.json", JSON.stringify(meta, null, 2));

  draft.status = "approved";
  draft.principleSlug = slug;
  if (qEntry) qEntry.status = "approved";

  writeDistillState(state);
  return { ok: true, principleSlug: slug, archivedSources: archivedCount };
}

// ─── P12.4: Distillation effectiveness measurement ────────────────────────

/**
 * Compute distillation effectiveness metrics.
 * Returns principle retrieval, source retirement, pipeline health,
 * and a confidence-gated overall effectiveness score.
 */
export function computeDistillEffectiveness() {
  const meta = _readMeta();
  if (!meta?.learnings) return null;

  const state = readDistillState();
  const now = Date.now();
  const DAY_MS = 86_400_000;

  // ─── 1. Principle retrieval quality ─────────────────────────────────────
  const principleEntries = Object.entries(meta.learnings)
    .filter(([, d]) => d.type === "principle" && !d.archived);

  let totalApp = 0, totalFup = 0, totalConf = 0;
  const principleStats = [];
  const stalePrinciples = [];

  for (const [slug, d] of principleEntries) {
    const app = d.search_appearances || 0;
    const fup = d.search_followup_hits || 0;
    const conf = d.confirmation_count || 0;
    totalApp += app;
    totalFup += fup;
    totalConf += conf;
    principleStats.push({ slug, title: (d.title || slug).slice(0, 80), appearances: app, followups: fup, confirmations: conf });

    // Stale: created 21+ days ago AND 0 appearances (Codex: age + opportunity)
    const created = d.created_date ? new Date(d.created_date).getTime() : now;
    const age = (now - created) / DAY_MS;
    if (age >= 21 && app === 0) {
      stalePrinciples.push({ slug, title: (d.title || slug).slice(0, 60), ageDays: Math.floor(age) });
    }
  }

  principleStats.sort((a, b) => b.confirmations - a.confirmations);

  const principleCount = principleEntries.length;
  const withAppearances = principleStats.filter(p => p.appearances > 0).length;
  const withConfirmations = principleStats.filter(p => p.confirmations > 0).length;
  // Dual metrics (Codex): exposure conversion + principle-level adoption
  const exposureConversion = totalApp > 0 ? +(totalConf / totalApp).toFixed(4) : 0;
  const adoptionRate = principleCount > 0 ? +(withConfirmations / principleCount).toFixed(4) : 0;

  const principles = {
    count: principleCount,
    withAppearances,
    withConfirmations,
    totalAppearances: totalApp,
    totalFollowups: totalFup,
    totalConfirmations: totalConf,
    exposureConversion,
    adoptionRate,
    topPrinciples: principleStats.slice(0, 5),
    stalePrinciples
  };

  // ─── 2. Archived source comparison ────────────────────────────────────
  const archivedEntries = Object.entries(meta.learnings)
    .filter(([, d]) => d.archived === true);
  let archivedApp = 0, archivedFup = 0;
  for (const [, d] of archivedEntries) {
    archivedApp += (d.search_appearances || 0);
    archivedFup += (d.search_followup_hits || 0);
  }
  // noiseReduction: archived count relative to total distillation-related notes
  const distillRelated = archivedEntries.length + principleCount;
  const noiseReduction = distillRelated > 0 ? +(archivedEntries.length / distillRelated).toFixed(4) : 0;

  const sources = {
    archived: archivedEntries.length,
    archivedAppearances: archivedApp,
    archivedFollowups: archivedFup,
    noiseReduction
  };

  // ─── 3. Pipeline health ───────────────────────────────────────────────
  const queueCounts = { pending: 0, drafted: 0, approved: 0, rejected: 0 };
  const qualityScores = { approved: [], rejected: [] };
  for (const q of state.queue) {
    queueCounts[q.status] = (queueCounts[q.status] || 0) + 1;
    if ((q.status === "approved" || q.status === "rejected") && typeof q.qualityScore === "number") {
      qualityScores[q.status].push(q.qualityScore);
    }
  }
  const decisions = queueCounts.approved + queueCounts.rejected;
  const approvalRate = decisions > 0 ? +(queueCounts.approved / decisions).toFixed(4) : null;
  const avgApprovedQuality = qualityScores.approved.length > 0
    ? +(qualityScores.approved.reduce((s, v) => s + v, 0) / qualityScores.approved.length).toFixed(3)
    : null;
  const avgRejectedQuality = qualityScores.rejected.length > 0
    ? +(qualityScores.rejected.reduce((s, v) => s + v, 0) / qualityScores.rejected.length).toFixed(3)
    : null;

  const pipeline = {
    ...queueCounts,
    decisions,
    approvalRate,
    avgApprovedQuality,
    avgRejectedQuality
  };

  // ─── 4. Confidence-gated effectiveness score (Codex) ─────────────────────
  const MIN_PRINCIPLES = 5;
  const MIN_APPEARANCES = 20;
  const MIN_DECISIONS = 5;

  // Data confidence: min of normalized supports
  const confPrinciples = Math.min(principleCount / MIN_PRINCIPLES, 1);
  const confAppearances = Math.min(totalApp / MIN_APPEARANCES, 1);
  const confDecisions = Math.min(decisions / MIN_DECISIONS, 1);
  const dataConfidence = +(Math.min(confPrinciples, confAppearances, confDecisions)).toFixed(3);

  // Raw sub-scores (0..1)
  const principleRetrieval = principleCount > 0 ? withAppearances / principleCount : 0;
  const confirmationScore = exposureConversion; // 0..1 range (typically much < 1)
  const pipelineScore = approvalRate ?? 0;

  const rawScore = 0.30 * principleRetrieval
    + 0.35 * confirmationScore
    + 0.20 * noiseReduction
    + 0.15 * pipelineScore;

  const effectivenessScore = +(rawScore * dataConfidence).toFixed(3);

  let scoreStatus;
  if (dataConfidence < 0.3) scoreStatus = "insufficient_data";
  else if (dataConfidence < 0.7) scoreStatus = "provisional";
  else scoreStatus = "stable";

  return {
    principles,
    sources,
    pipeline,
    effectiveness: {
      rawScore: +rawScore.toFixed(3),
      dataConfidence,
      effectivenessScore,
      scoreStatus,
      interpretation: effectivenessScore < 0.2 ? "❌ Not effective"
        : effectivenessScore < 0.5 ? "⚠️ Early stage"
        : effectivenessScore < 0.8 ? "✅ Working"
        : "🌟 Mature"
    }
  };
}
