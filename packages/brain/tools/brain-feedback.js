/**
 * P15.2 Day 2: brain_feedback tool — receives implicit feedback from agent turns.
 *
 * After the agent responds, the client scans turnMessages for brain_search calls
 * and sends the agent's response here. We detect which results were "used" and
 * record feedback (hits/misses) in learnings-meta.
 */

import { z } from "zod";
import { detectUsedLearnings, recordFeedback, computeRankDelta } from "../feedback.js";
import { writeFile, readJSON } from "../file-io.js";
import { readMetaWithDirty } from "../meta-io.js";

// ─── Meta helpers (same pattern as learnings.js) ────────────────────────────

let _metaDirtyRef = null;
let _flushTimer = null;

function _readMeta() {
  return readMetaWithDirty(() => _metaDirtyRef);
}

function _writeMeta(meta) {
  _metaDirtyRef = meta;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (_metaDirtyRef) {
      writeFile("learnings-meta.json", JSON.stringify(_metaDirtyRef, null, 2));
      _metaDirtyRef = null;
    }
  }, 500);
}

// ─── Response cleaning ──────────────────────────────────────────────────────

function cleanResponse(text) {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, "")      // remove code blocks
    .replace(/\[.*?\]\(.*?\)/g, "")       // remove markdown links
    .replace(/[|─┼┌┐└┘├┤┬┴]{2,}/g, "")   // remove table borders
    .slice(0, 2000);
}

// ─── Tool definition ────────────────────────────────────────────────────────

export const name = "brain_feedback";

export const description = "Record implicit relevance feedback after an agent turn. Called by the client with brain_search results and the agent's response.";

export const schema = {
  query: z.string().optional().describe("The original brain_search query"),
  result_slugs: z.array(z.string()).optional().describe("Slugs of results returned by brain_search (ordered by rank)"),
  exploration_slugs: z.array(z.string()).optional().describe("Slugs of exploration items (excluded from miss penalties)"),
  response: z.string().optional().describe("The agent's response text (cleaned, max 2000 chars)"),
  result_titles: z.array(z.string()).optional().describe("Titles of results (for detection)"),
  result_bodies: z.array(z.string()).optional().describe("Body snippets of results (for keyword detection)"),
  // V4: Procedure outcome tracking
  procedure_slug: z.string().optional().describe("Slug of a procedure learning to track outcome for"),
  procedure_outcome: z.enum(["success", "failure", "partial"]).optional().describe("Outcome of a procedure execution"),
};

export { handler };

async function handler(args) {
  const { query, result_slugs = [], exploration_slugs = [], response, result_titles = [], result_bodies = [], procedure_slug, procedure_outcome } = args;

  // V4: Procedure outcome tracking mode
  if (procedure_slug && procedure_outcome) {
    return handleProcedureOutcome(procedure_slug, procedure_outcome);
  }

  // Original feedback mode — requires query + result_slugs + response
  if (!query || result_slugs.length === 0 || !response) {
    return { content: [{ type: "text", text: JSON.stringify({ skipped: true, reason: "missing required fields for feedback (query, result_slugs, response)" }) }] };
  }

  // Skip short responses (likely "ok", "done", acknowledgements)
  const cleaned = cleanResponse(response);
  if (cleaned.length < 50) {
    return { content: [{ type: "text", text: JSON.stringify({ skipped: true, reason: "response too short" }) }] };
  }

  // Build result objects for detection
  const results = result_slugs.map((slug, i) => ({
    slug,
    title: result_titles[i] || slug.replace(/-/g, " "),
    body: result_bodies[i] || "",
  }));

  // Detect which results were "used" by the agent
  const usedSlugs = detectUsedLearnings(results, cleaned);

  // Read meta and record feedback
  const meta = _readMeta();
  if (!meta?.learnings) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "no meta" }) }] };
  }

  // Exclude exploration items from miss penalties
  const explorationSet = new Set(exploration_slugs);
  const feedbackSlugs = result_slugs.filter(s => !explorationSet.has(s));

  // Record feedback (anti-agent-bias built in)
  const fb = recordFeedback(meta, feedbackSlugs, usedSlugs);

  // Track exploration appearances (no misses)
  for (const slug of exploration_slugs) {
    const entry = meta.learnings[slug];
    if (entry) {
      if (entry.feedback_appearances == null) entry.feedback_appearances = 0;
      entry.feedback_appearances++;
      if (usedSlugs.includes(slug)) {
        if (entry.feedback_hits == null) entry.feedback_hits = 0;
        entry.feedback_hits++;
        entry.feedback_last_hit = Date.now();
        fb.hits.push(slug);
      }
      // No miss penalty for exploration items
    }
  }

  _writeMeta(meta);

  // Debug summary
  const summary = {
    query,
    total_results: result_slugs.length,
    exploration: exploration_slugs.length,
    used: fb.hits.length,
    missed: fb.misses.length,
    forgiven: fb.forgiven.length,
    hits: fb.hits,
  };

  return { content: [{ type: "text", text: JSON.stringify(summary) }] };
}

// ─── Procedure Outcome (V4) ─────────────────────────────────────────────────────

import { isDbAvailable, getDb, updateProcedureOutcome } from "../database.js";

async function handleProcedureOutcome(slug, outcome) {
  if (!isDbAvailable()) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "database not available" }) }] };
  }

  try {
    updateProcedureOutcome(getDb(), slug, outcome);

    // Also update meta hit_count for the procedure
    const meta = _readMeta();
    if (meta?.learnings?.[slug]) {
      meta.learnings[slug].hit_count = (meta.learnings[slug].hit_count || 0) + 1;
      meta.learnings[slug].last_accessed = new Date().toISOString();
      meta.learnings[slug].last_outcome = outcome;
      _writeMeta(meta);
    }

    const icon = outcome === "success" ? "✅" : outcome === "failure" ? "❌" : "⚠️";
    return {
      content: [{ type: "text", text: `${icon} Procedure outcome recorded: ${slug} → ${outcome}` }]
    };
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
  }
}
