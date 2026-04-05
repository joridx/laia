/**
 * brain_search tool — extracted from index.js
 */

import { z } from "zod";
import { recordHit, spreadActivation } from "../graph.js";
import { scoredSearch } from "../search.js";
import { DEFAULT_SIGNAL_WEIGHTS, INTENT_WEIGHTS } from "../scoring.js";
import { isLlmAvailable, llmRerank, llmExpandQuery, getBudgetWarning } from "../llm.js";
import { recordLearningHitsBySlugs, recordSearchAppearances, checkSearchAttribution, getAllLearnings } from "../learnings.js";
import { isEmbeddingsAvailable } from "../embeddings.js";
import { getEmbeddingDbStats } from "../database.js";
import { writeFile } from "../file-io.js";
import { readMetrics, SEARCH_LOG_MAX } from "./shared.js";
import { parseTemporalFilter } from "../temporal.js";
import { injectExplorationSlot } from "../feedback.js";

// ─── Local helper: ring-buffer search log ────────────────────────────────────

function recordSearchLog(query, slugs) {
  const metrics = readMetrics();
  if (!metrics) return;
  if (!metrics.search_log) metrics.search_log = [];
  metrics.search_log.push({ query, slugs, ts: Date.now() });
  if (metrics.search_log.length > SEARCH_LOG_MAX) {
    metrics.search_log = metrics.search_log.slice(-SEARCH_LOG_MAX);
  }
  writeFile("metrics.json", JSON.stringify(metrics, null, 2));
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const name = "brain_search";

export const description = "Search brain memory for learnings, patterns, sessions, or knowledge. Supports temporal filters via natural language ('last week', 'ahir', 'març 2026') or explicit since/until params.";

export const schema = {
  query: z.string().describe("The search term or phrase to look for. Can include temporal expressions like 'last week', 'yesterday', 'ahir', 'març 2026'."),
  scope: z.enum(["all", "learnings", "sessions", "knowledge", "notes"]).optional().describe("Where to search: all, learnings, sessions, knowledge, or notes (Obsidian)"),
  project: z.string().optional().describe("Active project for context-aware scoring"),
  show_all: z.boolean().optional().describe("Bypass convergence gates, return all results."),
  limit: z.number().optional().describe("Max results per category (0 = no limit). For pagination."),
  offset: z.number().optional().describe("Skip first N results per category. For pagination."),
  agentContext: z.string().optional().describe("Agent profile name for boosted results (V2b). Learnings tagged agent:<name> get +0.15 boost."),
  since: z.string().optional().describe("Filter results created on or after this date (YYYY-MM-DD). Also auto-parsed from natural language in query."),
  until: z.string().optional().describe("Filter results created on or before this date (YYYY-MM-DD). Also auto-parsed from natural language in query."),
  explain: z.boolean().optional().describe("Show detailed score breakdown per signal with weights. Useful for debugging search ranking.")
};

export async function handler({ query, scope = "all", project, show_all = false, limit = 0, offset = 0, agentContext, since, until, explain = false }) {
  // Parse temporal filters from natural language in query
  const temporal = parseTemporalFilter(query);
  // If query was only temporal (e.g. "last week"), cleanQuery is empty → keep it empty
  // to avoid re-injecting temporal text into search/ranking
  const effectiveQuery = temporal.cleanQuery !== null ? temporal.cleanQuery : query;
  const effectiveSince = since || temporal.since;
  const effectiveUntil = until || temporal.until;

  recordHit("search", effectiveQuery.toLowerCase());

  const metrics = readMetrics();
  const totalQueries = metrics?.total_queries || 0;

  let { learnings, files, graphExpanded, intent, timing, pagination } = await scoredSearch(effectiveQuery, scope, project, show_all, { limit, offset, agentContext, since: effectiveSince, until: effectiveUntil, totalQueries });

  const maxLearnings = show_all ? 50 : 10;
  const maxFiles = show_all ? 30 : 10;
  let llmInfo = null;

  // ── LLM enhancement (parallel, non-blocking on failure) ──
  if (isLlmAvailable() && !show_all) {
    const shouldRerank = learnings.length > 3;
    const shouldExpand = learnings.length < 3 && (scope === "all" || scope === "learnings");
    const _tLlm = performance.now();

    const [rerankResult, expandResult] = await Promise.allSettled([
      shouldRerank ? llmRerank(effectiveQuery, learnings) : Promise.resolve(null),
      shouldExpand ? llmExpandQuery(effectiveQuery) : Promise.resolve(null)
    ]);

    if (rerankResult.status === "fulfilled") {
      const reranked = rerankResult.value;
      if (reranked && reranked.length > 0) {
        const slugOrder = new Map(reranked.map((slug, i) => [slug, i]));
        const rerankedLearnings = [];
        const remaining = [];
        for (const l of learnings) {
          if (slugOrder.has(l.slug)) {
            rerankedLearnings.push({ ...l, llmRank: slugOrder.get(l.slug) + 1 });
          } else {
            remaining.push(l);
          }
        }
        rerankedLearnings.sort((a, b) => a.llmRank - b.llmRank);
        learnings = [...rerankedLearnings, ...remaining];
        llmInfo = `LLM reranked top-${reranked.length} (${(performance.now() - _tLlm).toFixed(0)}ms)`;
      }
    } else if (shouldRerank) {
      console.error(`LLM rerank error: ${rerankResult.reason?.message || rerankResult.reason}`);
    }

    if (expandResult.status === "fulfilled") {
      const expanded = expandResult.value;
      if (expanded && expanded.length > 0) {
        const expandedQuery = effectiveQuery + " " + expanded.join(" ");
        const rescue = await scoredSearch(expandedQuery, scope, project, false, { limit, offset, since: effectiveSince, until: effectiveUntil, totalQueries });
        const existingSlugs = new Set(learnings.map(l => l.slug));
        const newLearnings = rescue.learnings.filter(l => !existingSlugs.has(l.slug));
        if (newLearnings.length > 0) {
          learnings = [...learnings, ...newLearnings];
          llmInfo = (llmInfo ? llmInfo + " + " : "") + `LLM expanded: +${newLearnings.length} results via [${expanded.join(", ")}]`;
        }
      }
    } else if (shouldExpand) {
      console.error(`LLM expand error: ${expandResult.reason?.message || expandResult.reason}`);
    }
  }

  const hitSlugs = learnings.slice(0, 15).map(l => l.slug);

  // P15.2: Inject 1 exploration slot (random from pos 6-20)
  learnings = injectExplorationSlot(learnings, limit || 10) || learnings;

  recordLearningHitsBySlugs(hitSlugs);

  // P10.3: Record search appearances + attribution cache + ring buffer
  recordSearchAppearances(hitSlugs);
  recordSearchLog(effectiveQuery, hitSlugs);

  // P4.6: Spread activation from accessed learnings through the knowledge graph
  if (hitSlugs.length > 0) {
    const allLearnings = getAllLearnings();
    const tagMap = new Map(allLearnings.map(l => [l.slug, l.tags || []]));
    spreadActivation(hitSlugs, slug => tagMap.get(slug));
  }

  let output = `# Search: "${effectiveQuery}"${show_all ? " (show_all)" : ""}${explain ? " (explain)" : ""}\n\n`;
  if (effectiveSince || effectiveUntil) {
    output += `**Time filter:** ${effectiveSince || "*"} → ${effectiveUntil || "*"}\n`;
  }
  if (intent && intent.intent !== "semantic") output += `**Intent:** ${intent.intent} (${intent.confidence})\n`;
  if (explain) {
    const weights = (intent && INTENT_WEIGHTS[intent.intent]) || DEFAULT_SIGNAL_WEIGHTS;
    const activeWeights = Object.entries(weights).filter(([, w]) => w > 0).map(([s, w]) => `${s}:${w}`).join(", ");
    output += `**Weights:** ${activeWeights}\n`;
  }
  if (graphExpanded.length > 0) output += `**Graph expansion:** ${graphExpanded.join(", ")}\n`;
  if (llmInfo) output += `**LLM:** ${llmInfo}\n`;
  const llmWarning = getBudgetWarning();
  if (llmWarning) output += `\n${llmWarning}\n\n`;
  if (timing) output += `**Timing:** ${timing.total}ms (graph:${timing.graph} bm25:${timing.bm25} vitality:${timing.vitality} learnings:${timing.learnings} files:${timing.files})\n`;
  if (isEmbeddingsAvailable()) {
    const embStats = getEmbeddingDbStats();
    const embMatches = learnings.filter(l => l.rawScores?.embedding > 0.1).length;
    output += `**Embeddings:** ${embStats?.total || 0} indexed${embMatches > 0 ? `, ${embMatches} semantic matches` : ""}\n`;
  }
  if (pagination) output += `**Pagination:** offset=${pagination.offset} limit=${pagination.limit} totalLearnings=${pagination.totalLearnings} totalFiles=${pagination.totalFiles}\n`;
  output += "\n";

  if (learnings.length === 0 && files.length === 0) {
    output += show_all ? `No results found at all.\n` : `No results (≥2 signal gate applied).\n`;
    return { content: [{ type: "text", text: output }] };
  }

  if (learnings.length > 0) {
    output += `## Learnings (${learnings.length}${show_all ? ", showing " + Math.min(learnings.length, maxLearnings) : ""})\n\n`;
    for (const l of learnings.slice(0, maxLearnings)) {
      const sigStr = Object.entries(l.signals || {}).map(([k,v]) => `${k}:${v}`).join(" ");
      const llmTag = l.llmRank ? ` llm:#${l.llmRank}` : "";
      output += `- **${l.title}** [${l.slug}] (score:${l.score.toFixed(1)} | ${sigStr}${llmTag})\n  ${l.headline}\n`;
      // Knowledge Store: show attachments if present
      if (l.attachments && Array.isArray(l.attachments) && l.attachments.length > 0) {
        for (const att of l.attachments) {
          const icon = att.mime?.startsWith('image/') ? '🖼️' : att.mime?.includes('pdf') ? '📄' : att.mime?.includes('spreadsheet') || att.mime?.includes('excel') ? '📊' : '📎';
          output += `  ${icon} ${att.uri} (${att.mime})\n     ${att.label}\n`;
        }
      }
      if (explain && l.rawScores) {
        const weights = (intent && INTENT_WEIGHTS[intent.intent]) || DEFAULT_SIGNAL_WEIGHTS;
        const parts = Object.entries(l.rawScores)
          .filter(([, raw]) => raw > 0)
          .map(([sig, raw]) => {
            const w = weights[sig] || 1;
            return `${sig}: ${raw}×${w}=${(raw * w).toFixed(1)}`;
          });
        if (parts.length > 0) {
          output += `    📊 ${parts.join(" + ")} = **${l.score.toFixed(1)}**\n`;
        }
        if (l.agentBoosted) output += `    🏷️ agent boost: +0.15\n`;
      }
    }
  }

  if (files.length > 0) {
    output += `\n## Files (${files.length}${show_all ? ", showing " + Math.min(files.length, maxFiles) : ""})\n\n`;
    for (const f of files.slice(0, maxFiles)) {
      const graphNote = f.viaGraph && f.viaGraph.length > 0 ? ` [via graph: ${f.viaGraph.join(", ")}]` : "";
      output += `- **${f.file}** (score:${f.score})${graphNote}\n`;
      for (const s of f.snippets.slice(0, 2)) {
        output += `  L${s.line}: ${s.content}\n`;
      }
    }
  }

  return { content: [{ type: "text", text: output }] };
}
