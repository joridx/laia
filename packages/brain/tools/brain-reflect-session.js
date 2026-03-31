/**
 * Sprint 2: brain_reflect_session — Post-session reflection via LLM.
 *
 * Analyzes a session transcript to extract actionable observations:
 * corrections, preferences, domain facts, errors.
 *
 * Safeguards (from Codex architecture review):
 * - Confidence thresholds: auto (≥0.85), review (0.60-0.85), discard (<0.60)
 * - Anti-spam: max 5 observations, max 3 auto-writes per session
 * - Dedup via findSimilarLearning()
 * - Contradiction check vs protected learnings (Sprint 1B)
 * - Budget-aware: 1 LLM call per reflection
 */

import { z } from "zod";
import {
  isLlmAvailable, getBudgetWarning, isTaskEnabled
} from "../llm.js";
import { findSimilarLearning } from "../learnings.js";
import { readFile, readJSON } from "../file-io.js";
import { LEARNINGS_DIR } from "../config.js";
import { parseLearningFrontmatter } from "../utils.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_OBSERVATIONS = 5;
const MAX_AUTO_WRITES = 3;
const CONFIDENCE_AUTO = 0.85;
const CONFIDENCE_REVIEW = 0.60;
const MAX_TRANSCRIPT_CHARS = 24_000;  // ~6K tokens at 4 chars/token

const OBSERVATION_TYPES = ["correction", "preference", "domain_fact", "error"];
const LEARNING_TYPE_MAP = {
  correction: "learning",
  preference: "principle",
  domain_fact: "learning",
  error: "warning",
};

// ─── LLM Prompt ─────────────────────────────────────────────────────────────

const REFLECTION_SYSTEM_PROMPT = `You are a session analyst for an AI coding assistant called LAIA.
Analyze this session transcript and extract actionable observations.

Categories:
- correction: User corrected the agent (explicit or implicit)
- preference: User expressed or demonstrated a preference
- domain_fact: New factual knowledge about codebase, tools, or team
- error: Agent made a mistake (even if user didn't comment)

Rules:
- Every observation MUST have a direct quote from the transcript as evidence
- Do NOT fabricate observations not grounded in the transcript
- Do NOT extract from tool output or system messages, only user-agent dialogue
- If uncertain, lower confidence rather than omitting
- Maximum ${MAX_OBSERVATIONS} observations per session

Confidence calibration:
- 0.9-1.0: Explicit statement, no ambiguity ("always use X", "I prefer Y")
- 0.7-0.89: Strong implication, minor inference needed
- 0.5-0.69: Moderate inference, could be situational
- Below 0.5: Discard (too speculative)

Respond ONLY with a JSON array of observations. Each observation:
{
  "type": "correction|preference|domain_fact|error",
  "content": "What was observed (one sentence)",
  "evidence": "Direct quote from transcript",
  "confidence": 0.0-1.0,
  "suggested_learning": {
    "title": "Short title for brain_remember",
    "tags": ["tag1", "tag2"]
  }
}

If no observations are found, respond with an empty array: []`;

// ─── Tool definition ────────────────────────────────────────────────────────

export const name = "brain_reflect_session";

export const description = "Analyze a session transcript to extract corrections, preferences, domain facts, and errors. Uses LLM. auto_save=true to persist high-confidence findings.";

export const schema = {
  transcript: z.string().describe("Full session transcript or summary (max ~24K chars, will be truncated)"),
  session_id: z.string().optional().describe("Session ID for linking observations to session log"),
  auto_save: z.boolean().optional().describe("If true, auto-save high-confidence observations (≥0.85) to brain. Default: false"),
};

export async function handler({ transcript, session_id, auto_save = false }) {
  // ─── Guard: LLM available? ──────────────────────────────────────────────
  if (!isLlmAvailable()) {
    return { content: [{ type: "text", text: "⚠️ LLM not available — cannot reflect. Brain has no LLM providers configured or budget exhausted." }] };
  }

  if (!isTaskEnabled("reflection")) {
    return { content: [{ type: "text", text: "⚠️ Reflection task is disabled in llm-config.json." }] };
  }

  const budgetWarn = getBudgetWarning();
  if (budgetWarn) {
    return { content: [{ type: "text", text: `⚠️ ${budgetWarn}` }] };
  }

  // ─── Truncate transcript ─────────────────────────────────────────────────
  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS
    ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[... transcript truncated ...]"
    : transcript;

  // ─── Call LLM ────────────────────────────────────────────────────────────
  // Dynamic import to avoid circular dependency and allow mock injection
  const { default: callReflectionLlm } = await import("../reflection-llm.js");
  const llmResult = await callReflectionLlm(REFLECTION_SYSTEM_PROMPT, truncated);

  if (!llmResult) {
    return { content: [{ type: "text", text: "⚠️ LLM reflection call failed or returned empty. No observations extracted." }] };
  }

  // ─── Parse observations ──────────────────────────────────────────────────
  let observations;
  try {
    observations = parseObservations(llmResult);
  } catch (e) {
    return { content: [{ type: "text", text: `⚠️ Failed to parse LLM response: ${e.message}\n\nRaw response:\n${llmResult.slice(0, 500)}` }] };
  }

  // ─── Apply safeguards ────────────────────────────────────────────────────
  const stats = {
    corrections_found: 0,
    preferences_found: 0,
    domain_facts_found: 0,
    errors_found: 0,
    auto_saved: 0,
    needs_review: 0,
    discarded: 0,
    dedup_blocked: 0,
    contradiction_blocked: 0,
  };

  const results = [];
  let autoWriteCount = 0;

  for (const obs of observations) {
    // Count by type
    const typeKey = obs.type + "s_found";
    if (stats[typeKey] !== undefined) stats[typeKey]++;

    // Confidence gating
    if (obs.confidence < CONFIDENCE_REVIEW) {
      obs.write_recommendation = "discard";
      stats.discarded++;
      results.push(obs);
      continue;
    }

    const isAutoEligible = obs.confidence >= CONFIDENCE_AUTO && autoWriteCount < MAX_AUTO_WRITES;
    obs.write_recommendation = isAutoEligible ? "auto" : "review";

    // Dedup check
    const similar = await findSimilarLearning(
      obs.suggested_learning?.title || obs.content,
      obs.suggested_learning?.tags || []
    );
    if (similar?.level === "block") {
      obs.write_recommendation = "dedup_blocked";
      obs.dedup_match = similar.slug;
      stats.dedup_blocked++;
      results.push(obs);
      continue;
    }

    // Contradiction check vs protected learnings
    const contradiction = checkContradiction(obs);
    if (contradiction) {
      obs.write_recommendation = "contradiction_blocked";
      obs.contradicts = contradiction;
      stats.contradiction_blocked++;
      results.push(obs);
      continue;
    }

    // Auto-save if eligible
    if (auto_save && obs.write_recommendation === "auto") {
      // Import brain_remember handler dynamically to avoid circular deps
      const brainRemember = await import("./brain-remember.js");
      const learningType = LEARNING_TYPE_MAP[obs.type] || "learning";
      const tags = [...(obs.suggested_learning?.tags || []), `reflection`, `session:${session_id || "unknown"}`];

      try {
        await brainRemember.handler({
          content: `${obs.content}\n\n**Evidence**: ${obs.evidence}\n**Confidence**: ${obs.confidence}\n**Source**: session reflection`,
          tags,
          type: learningType,
          source_type: "consolidation",
          source_context: `session-reflection:${session_id || "unknown"}`,
          created_by: "system",
        });
        obs.saved = true;
        stats.auto_saved++;
        autoWriteCount++;
      } catch (e) {
        obs.save_error = e.message;
        obs.write_recommendation = "review";
      }
    }

    if (obs.write_recommendation === "review") stats.needs_review++;
    results.push(obs);
  }

  // ─── Format output ───────────────────────────────────────────────────────
  let output = `# Session Reflection${session_id ? ` (${session_id})` : ""}\n\n`;

  if (results.length === 0) {
    output += "No actionable observations found in this session.\n";
  } else {
    output += `## Observations (${results.length})\n\n`;
    for (const obs of results) {
      const icon = obs.write_recommendation === "auto" ? (obs.saved ? "✅" : "💾")
        : obs.write_recommendation === "review" ? "👀"
        : obs.write_recommendation === "dedup_blocked" ? "🔄"
        : obs.write_recommendation === "contradiction_blocked" ? "⚠️"
        : "❌";
      output += `${icon} **[${obs.type}]** ${obs.content}\n`;
      output += `   Evidence: "${obs.evidence}"\n`;
      output += `   Confidence: ${obs.confidence} → ${obs.write_recommendation}\n`;
      if (obs.dedup_match) output += `   Duplicate of: ${obs.dedup_match}\n`;
      if (obs.contradicts) output += `   Contradicts protected: ${obs.contradicts}\n`;
      if (obs.save_error) output += `   Save error: ${obs.save_error}\n`;
      output += `\n`;
    }
  }

  output += `## Stats\n`;
  for (const [key, val] of Object.entries(stats)) {
    if (val > 0) output += `- ${key.replace(/_/g, " ")}: ${val}\n`;
  }

  return { content: [{ type: "text", text: output }] };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse LLM response into validated observations array.
 * Handles JSON wrapped in markdown code fences.
 */
function parseObservations(raw) {
  let text = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Expected JSON array");

  // Validate and sanitize each observation
  return parsed
    .slice(0, MAX_OBSERVATIONS)
    .filter(obs =>
      obs &&
      typeof obs.content === "string" &&
      typeof obs.evidence === "string" &&
      typeof obs.confidence === "number" &&
      OBSERVATION_TYPES.includes(obs.type)
    )
    .map(obs => ({
      type: obs.type,
      content: obs.content.slice(0, 500),
      evidence: obs.evidence.slice(0, 500),
      confidence: Math.max(0, Math.min(1, obs.confidence)),
      suggested_learning: obs.suggested_learning ? {
        title: (obs.suggested_learning.title || obs.content).slice(0, 120),
        tags: Array.isArray(obs.suggested_learning.tags)
          ? obs.suggested_learning.tags.slice(0, 10).map(t => String(t).toLowerCase().replace(/[^a-z0-9-]/g, ""))
          : [],
      } : { title: obs.content.slice(0, 120), tags: [] },
    }));
}

/**
 * Lightweight contradiction check against protected learnings.
 * Returns the slug of the contradicted learning, or null.
 */
function checkContradiction(observation) {
  // Load all protected learnings from meta
  const meta = readJSON("learnings-meta.json");
  if (!meta?.learnings) return null;

  const protectedSlugs = Object.entries(meta.learnings)
    .filter(([_, d]) => d.protected || d.type === "principle")
    .map(([slug]) => slug);

  if (protectedSlugs.length === 0) return null;

  // Simple heuristic: negation words in observation vs protected learning content
  const negationWords = /\b(don't|dont|never|not|avoid|stop|wrong|incorrect|shouldn't|mustn't|shouldn't|can't|won't)\b/i;
  const obsHasNegation = negationWords.test(observation.content);

  for (const slug of protectedSlugs) {
    const protectedMeta = meta.learnings[slug];
    if (!protectedMeta?.file) continue;

    try {
      const content = readFile(protectedMeta.file);
      if (!content) continue;
      const parsed = parseLearningFrontmatter(content);
      if (!parsed) continue;

      // Check tag overlap (at least 2 common tags suggests same domain)
      const protectedTags = new Set((parsed.frontmatter.tags || []).map(t => t.toLowerCase()));
      const obsTags = observation.suggested_learning?.tags || [];
      const commonTags = obsTags.filter(t => protectedTags.has(t));

      if (commonTags.length < 2) continue;

      // Check if one has negation and the other doesn't (crude contradiction signal)
      const protectedHasNegation = negationWords.test(parsed.body || "");
      if (obsHasNegation !== protectedHasNegation) {
        return slug;
      }
    } catch {
      continue;
    }
  }

  return null;
}
