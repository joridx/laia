/**
 * Tool: brain_get_context
 * Session start: get user prefs, recent sessions, relevant learnings, and project context.
 */

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";

import { BRAIN_PATH } from "../config.js";
import { readFile, readJSON, writeFile } from "../file-io.js";
import { getRelatedConcepts, buildHierarchy } from "../graph.js";
import { performGitPull } from "../git-sync.js";
import {
  getAllLearnings, getLearningsByTags, filterStaleLearnings,
  computeAllVitalities, ensureLearningMeta
} from "../learnings.js";
import {
  performPrune, performConsolidate, performArchiveLearnings,
  cleanBrokenSubsumes, syncOrphanLearnings
} from "../maintenance.js";
import {
  isDbAvailable, getDb, rebuildFullIndex, markDbDirty, syncVitalityMap
} from "../database.js";
import { readTodos } from "../todos.js";
import {
  getRecentSessions, getSessionsByProject, getProjectContext
} from "../helpers.js";
import { extractTags, detectProjectFromPath } from "../utils.js";
import { planDistillation, getDistillStatus } from "../distillation.js";
import { invalidateArchiveCache } from "../search.js";
import { compressContext } from "../compression.js";
import { readMeta, readMetrics } from "./shared.js";

export const name = "brain_get_context";
export const description = "Session start: get user prefs, recent sessions, relevant learnings, and project context. Supports compression levels: full, summary, headlines (auto-selected or explicit).";
export const schema = {
  project: z.string().optional().describe("Project name to filter context (e.g., 'binary-engine')"),
  cwd: z.string().optional().describe("Current working directory to auto-detect project"),
  compact: z.boolean().optional().describe("Enable compression (default true). Set false for full context."),
  level: z.enum(["full", "summary", "headlines"]).optional().describe("Compression level. full=no compression, summary=~3KB, headlines=~1.2KB bullet points. Default: auto-selected."),
  contextBudget: z.number().optional().describe("Remaining context window chars. Used for auto-selecting compression level (>8000→full, 3000-8000→summary, <3000→headlines).")
};

export async function handler({ project, cwd, compact = true, level, contextBudget } = {}) {
  const syncResult = performGitPull();

  // P4.1: Rebuild SQLite index after git pull (or first run)
  let dbRebuildResult = null;
  if (isDbAvailable()) {
    const db = getDb();
    if (db) {
      dbRebuildResult = rebuildFullIndex();
      if (dbRebuildResult && (dbRebuildResult.learnings.indexed > 0 || dbRebuildResult.files.indexed > 0)) {
        console.error(`   SQLite: indexed ${dbRebuildResult.learnings.indexed} learnings, ${dbRebuildResult.files.indexed} files (${dbRebuildResult.elapsed}ms)`);
      }
    }
  }

  const preferences = readFile("memory/user/preferences.md");
  const index = readJSON("index.json");

  const detectedProject = project || detectProjectFromPath(cwd);
  const isFiltered = !!detectedProject;

  // Auto-maintenance (P2.5)
  const maintenanceActions = [];
  const maintenanceMetrics = readMetrics() || {};
  const today = new Date().toISOString().split("T")[0];

  const sharedVitalityMap = computeAllVitalities({ forceRecompute: true });

  // P4.1: Sync vitality to DB (pre-computed, avoid recomputing in search)
  if (isDbAvailable() && sharedVitalityMap.size > 0) {
    const db = getDb();
    if (db) syncVitalityMap(db, sharedVitalityMap);
  }

  // P3.2: Sync orphan learnings (e.g. created in Obsidian)
  const orphans = syncOrphanLearnings();
  if (orphans > 0) {
    maintenanceActions.push(`indexed ${orphans} new learnings from Obsidian`);
    if (isDbAvailable()) markDbDirty();
  }

  const lastPrune = maintenanceMetrics.last_prune;
  const daysSincePrune = lastPrune
    ? Math.floor((new Date(today) - new Date(lastPrune)) / (1000 * 60 * 60 * 24))
    : Infinity;

  if (daysSincePrune > 7) {
    const pruneResult = performPrune(60, sharedVitalityMap);
    if (pruneResult && pruneResult.newlyStale > 0) {
      maintenanceActions.push(`pruned ${pruneResult.newlyStale} stale learnings`);
    }
    const archiveResult = performArchiveLearnings(sharedVitalityMap);
    if (archiveResult && archiveResult.archived > 0) {
      maintenanceActions.push(`archived ${archiveResult.archived} stale learnings`);
      invalidateArchiveCache();
    }
    const cleanedSubsumes = cleanBrokenSubsumes();
    if (cleanedSubsumes > 0) {
      maintenanceActions.push(`cleaned ${cleanedSubsumes} broken subsumes refs`);
    }
  }

  // Rebuild tag hierarchy from subsumption (independent 7-day timer)
  const lastHierarchy = maintenanceMetrics.last_hierarchy;
  const daysSinceHierarchy = lastHierarchy
    ? Math.floor((new Date(today) - new Date(lastHierarchy)) / (1000 * 60 * 60 * 24))
    : Infinity;

  if (daysSinceHierarchy > 7) {
    try {
      const hierarchyResult = buildHierarchy(() => getAllLearnings());
      if (hierarchyResult.added > 0) {
        maintenanceActions.push(`hierarchy: ${hierarchyResult.added} parent→child pairs`);
      }
      maintenanceMetrics.last_hierarchy = today;
      writeFile("metrics.json", JSON.stringify(maintenanceMetrics, null, 2));
    } catch (e) { console.error(`Hierarchy rebuild failed: ${e.message}`); }
  }

  const lastConsolidate = maintenanceMetrics.last_consolidation || index?.consolidation?.last_run;
  const daysSinceConsolidate = lastConsolidate
    ? Math.floor((new Date(today) - new Date(lastConsolidate)) / (1000 * 60 * 60 * 24))
    : Infinity;

  if (daysSinceConsolidate > 30) {
    const consolidateResult = performConsolidate(30);
    if (consolidateResult) {
      maintenanceActions.push(`consolidated ${consolidateResult.consolidated} old sessions`);
    }
  }

  let sessions;
  if (detectedProject) {
    sessions = getSessionsByProject(detectedProject, 3);
    if (sessions.length === 0) sessions = getRecentSessions(2);
  } else {
    sessions = getRecentSessions(2);
  }

  let warningLearnings;
  if (detectedProject) {
    const projectTags = extractTags(detectedProject);
    if (projectTags.length > 0) {
      warningLearnings = getLearningsByTags(projectTags, "warning").slice(0, 10);
    } else {
      warningLearnings = getAllLearnings().filter(l => l.type === "warning").slice(0, 10);
    }
  } else {
    warningLearnings = getAllLearnings().filter(l => l.type === "warning").slice(0, 10);
  }

  let context = "# LAIA Brain Context\n\n";

  if (isFiltered) context += `**🎯 Filtered for project:** ${detectedProject}\n\n`;
  if (preferences) context += "## User Preferences\n" + preferences + "\n\n";

  if (detectedProject) {
    const projectContext = getProjectContext(detectedProject);
    if (projectContext) {
      context += `## Project: ${detectedProject}\n`;
      context += projectContext.isStructured
        ? projectContext.content + "\n\n"
        : projectContext.content.slice(0, 800) + "\n\n";
    }
  }

  if (sessions.length > 0) {
    context += isFiltered ? `## Sessions (${detectedProject})\n` : "## Recent Sessions\n";
    for (const session of sessions) {
      context += `### ${session.file}\n${session.content?.slice(0, 500)}...\n\n`;
    }
  }

  if (warningLearnings.length > 0) {
    const { active: activeW } = filterStaleLearnings(warningLearnings);
    context += isFiltered ? `## Warnings (relevant to ${detectedProject})\n` : "## Warnings (#avoid)\n";
    for (const w of activeW) {
      context += `- **${w.title}**: ${w.headline || w.title}\n`;
    }
  }

  const metrics = readMetrics();
  if (metrics?.tag_hits) {
    const topTags = Object.entries(metrics.tag_hits)
      .filter(([_, hits]) => hits > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topTags.length > 0) {
      context += `\n## Most Used Topics\n`;
      for (const [tag, hits] of topTags) {
        const related = getRelatedConcepts(tag);
        context += `- **${tag}** (${hits} queries)`;
        if (related.length > 0) context += ` → related: ${related.slice(0, 3).join(", ")}`;
        context += "\n";
      }
    }
  }

  // Pending TODOs
  const allTodos = readTodos();
  const pendingTodos = allTodos.filter(t => t.status === "pending" || t.status === "in_progress");
  const contextTodos = detectedProject
    ? pendingTodos.filter(t => !t.project || t.project.toLowerCase().includes(detectedProject.toLowerCase()))
    : pendingTodos;

  if (contextTodos.length > 0) {
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    contextTodos.sort((a, b) => (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1));
    context += `\n## Pending TODOs (${contextTodos.length})\n`;
    for (const t of contextTodos.slice(0, 10)) {
      const icon = t.priority === "high" ? "🔴" : t.priority === "low" ? "⚪" : "🟡";
      const statusIcon = t.status === "in_progress" ? "🔄" : "⬜";
      context += `${statusIcon} ${icon} ${t.text}`;
      const meta = [];
      if (t.owner !== "both") meta.push(`@${t.owner}`);
      if (t.project) meta.push(t.project);
      if (t.due) meta.push(`due:${t.due}`);
      if (meta.length) context += ` _(${meta.join(", ")})_`;
      context += "\n";
    }
    if (contextTodos.length > 10) context += `... i ${contextTodos.length - 10} més\n`;
  }

  // Learning health
  const learningsMeta = readMeta();
  if (learningsMeta?.learnings) {
    const entries = Object.entries(learningsMeta.learnings);
    const zoneCounts = { active: 0, stale: 0, fading: 0, archived: 0 };
    for (const [slug] of entries) {
      const vData = sharedVitalityMap.get(slug);
      const zone = vData?.zone || "active";
      zoneCounts[zone] = (zoneCounts[zone] || 0) + 1;
    }

    const topHits = entries
      .filter(([slug, d]) => {
        const vData = sharedVitalityMap.get(slug);
        return (vData?.zone === "active") && d.hit_count > 0;
      })
      .sort((a, b) => b[1].hit_count - a[1].hit_count)
      .slice(0, 5);

    context += `\n## Learning Health\n`;
    context += `- **${zoneCounts.active}** active, **${zoneCounts.stale}** stale, **${zoneCounts.fading}** fading, **${zoneCounts.archived}** archived (of ${entries.length} total)\n`;
    if (topHits.length > 0) {
      context += `- Most accessed: ${topHits.map(([s, d]) => `${s} (${d.hit_count})`).join(", ")}\n`;
    }
  }

  // P10.4: Distillation auto-plan trigger (30-day cadence + ratio check)
  try {
    const planResult = planDistillation();
    if (!planResult.skipped && planResult.newClusters > 0) {
      context += `\n## Distillation Plan Updated\n`;
      context += `- ${planResult.newClusters} new cluster(s) queued. Run \`brain_distill action:generate\` to draft principles.\n`;
    }
    const distStatus = getDistillStatus();
    if (distStatus.drafted > 0) {
      context += `\n## Distillation Drafts Awaiting Review\n`;
      context += `- ${distStatus.drafted} draft(s) ready. Run \`brain_distill action:status\` to review.\n`;
    } else if (planResult.totalPending > 0 && distStatus.drafted === 0) {
      context += `\n## Distillation Queue\n`;
      context += `- ${planResult.totalPending} cluster(s) pending. Run \`brain_distill action:generate\` when ready.\n`;
    }
  } catch (e) {
    console.error("P10.4 distillation trigger error:", e.message);
  }

  if (index?.consolidation) {
    context += `\n## Brain Stats\n`;
    context += `- Last consolidation: ${index.consolidation.last_run}\n`;
    context += `- Total files: ${index.consolidation.stats?.total_files || "unknown"}\n`;
    context += `- Total queries: ${metrics?.total_queries || 0}\n`;
  }

  if (maintenanceActions.length > 0) {
    context += `\n## Auto-Maintenance\n`;
    context += `- 🧹 ${maintenanceActions.join(", ")}\n`;
  }

  // P5.3: Skills health status
  const skillsHealthPath = path.join(homedir(), ".laia", ".skills-health.json");
  if (fs.existsSync(skillsHealthPath)) {
    try {
      const shData = JSON.parse(fs.readFileSync(skillsHealthPath, "utf8"));
      const ageMin = shData.timestamp
        ? Math.floor((Date.now() - new Date(shData.timestamp).getTime()) / (1000 * 60))
        : null;
      const { summary } = shData;
      if (summary.fail > 0) {
        const failing = shData.checks.filter(c => !c.ok).map(c => c.service);
        context += `\n## ⚠️ Service Endpoints\n`;
        context += `- **${summary.fail}** service(s) failing: ${failing.join(", ")}\n`;
        context += `- Run \`/monitor\` for details\n`;
      }
      if (ageMin !== null && ageMin > 1440) {
        context += context.includes("Service Endpoints") ? "" : `\n## Service Endpoints\n`;
        context += `- Last check is ${Math.floor(ageMin / 60)}h old. Consider running \`/monitor\`\n`;
      }
    } catch { /* ignore corrupt file */ }
  }

  if (syncResult.syncReport) {
    context += `\n## Git Sync\n${syncResult.syncReport}\n`;
  }

  // P10.5 + P16.1: Multi-level context compression
  const compactionEnabled = compact && (process.env.BRAIN_CONTEXT_COMPACTION || "auto") !== "off";
  if (compactionEnabled) {
    try {
      const effectiveLevel = !compact ? "full" : level || undefined;
      const result = await compressContext(context, { level: effectiveLevel, contextBudget });
      if (result.level !== "full") {
        context = result.text;
      }
    } catch (e) {
      console.error(`Compression error: ${e.message}`);
    }
  }

  return { content: [{ type: "text", text: context }] };
}
