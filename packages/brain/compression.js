/**
 * Multi-level context compression for brain_get_context.
 *
 * Three levels of detail:
 *   full      → No compression. Raw context as-is.
 *   summary   → LLM-compacted paragraphs (~3000 chars). Current behaviour.
 *   headlines → LLM-compacted to bullet-point headlines (~1200 chars). New.
 *
 * Selection:
 *   - Explicit via `level` param ("full", "summary", "headlines")
 *   - Auto via `contextBudget` param (remaining chars in context window)
 *     → >8000: full, 3000-8000: summary, <3000: headlines
 */

import { isLlmAvailable, llmCompactContext } from "./llm.js";

// ─── Level definitions ───────────────────────────────────────────────────────

export const COMPRESSION_LEVELS = {
  full: {
    name: "full",
    description: "No compression. Full context.",
    targetRatio: 1.0,
  },
  summary: {
    name: "summary",
    description: "Compacted paragraphs preserving all actionable info.",
    targetChars: 3000,
    maxTokens: 1500,
    systemPrompt: `You compact brain context for an AI coding assistant.
NEVER remove or rewrite: code blocks, file paths, IDs (Jira keys, URLs, slugs), config keys, env var names, API endpoints, version numbers, numerical limits, concrete requirements, or TODO items.
Preserve: user prefs, project info, pending TODOs, active warnings, key stats.
Remove: verbose session narratives, redundant boilerplate, long lists of low-value items.
Keep markdown structure. Output must be shorter than input.
If you cannot reduce below target without dropping critical details, return the text unchanged.`
  },
  headlines: {
    name: "headlines",
    description: "Bullet-point headlines — critical info only.",
    targetChars: 1200,
    maxTokens: 600,
    systemPrompt: `You compress brain context into the shortest possible bullet-point format for an AI coding assistant working with minimal context window.
FORMAT: Use ONLY bullet points (- ), one per critical fact. No paragraphs, no headers, no blank lines.
PRESERVE (verbatim, never rewrite): file paths, Jira keys, URLs, API endpoints, env var names, version numbers, config keys, TODO items with their IDs.
KEEP: active warnings (type: warning), current project name + status, user prefs that affect code style.
AGGRESSIVE REMOVE: session history, stats/metrics, low-priority learnings, completed tasks, verbose descriptions.
Target: absolute minimum. Every bullet must be actionable or critical.`
  }
};

// ─── Auto-select level based on budget ───────────────────────────────────────

/**
 * Choose compression level automatically based on remaining context budget.
 * @param {number} contextLength - Length of uncompressed context (chars)
 * @param {number} [contextBudget] - Remaining chars in context window (null = auto)
 * @returns {string} "full" | "summary" | "headlines"
 */
export function autoSelectLevel(contextLength, contextBudget) {
  if (contextBudget == null) {
    // Default heuristic: if context is small, don't compress
    if (contextLength <= 4000) return "full";
    return "summary";
  }

  // Explicit budget: choose level that fits
  if (contextBudget >= 8000) return "full";
  if (contextBudget >= 3000) return "summary";
  return "headlines";
}

// ─── Compress ────────────────────────────────────────────────────────────────

/**
 * Compress context at the specified level.
 *
 * @param {string} context - Raw context text
 * @param {object} options
 * @param {string} [options.level] - Explicit level: "full", "summary", "headlines"
 * @param {number} [options.contextBudget] - Remaining context window chars (for auto-select)
 * @returns {Promise<{ text: string, level: string, originalLength: number, compressedLength: number }>}
 */
export async function compressContext(context, { level, contextBudget } = {}) {
  const originalLength = context.length;

  // Determine effective level
  const effectiveLevel = level || autoSelectLevel(originalLength, contextBudget);

  if (effectiveLevel === "full") {
    return { text: context, level: "full", originalLength, compressedLength: originalLength };
  }

  const spec = COMPRESSION_LEVELS[effectiveLevel];
  if (!spec) {
    return { text: context, level: "full", originalLength, compressedLength: originalLength };
  }

  if (!isLlmAvailable()) {
    // Fallback: truncate for headlines, return full for summary
    if (effectiveLevel === "headlines") {
      const truncated = _extractiveHeadlines(context, spec.targetChars);
      return { text: truncated, level: "headlines-extractive", originalLength, compressedLength: truncated.length };
    }
    return { text: context, level: "full-fallback", originalLength, compressedLength: originalLength };
  }

  // LLM compression
  const compacted = await llmCompactContext(context, spec.targetChars, spec.systemPrompt, spec.maxTokens);
  if (compacted && compacted.length < originalLength * 0.9) {
    const tag = `\n\n_(${effectiveLevel}: ${Math.round(originalLength / 1024)}KB → ${Math.round(compacted.length / 1024)}KB)_`;
    const finalText = compacted + tag;
    return { text: finalText, level: effectiveLevel, originalLength, compressedLength: finalText.length };
  }

  // LLM didn't compress enough — try extractive fallback for headlines
  if (effectiveLevel === "headlines") {
    const truncated = _extractiveHeadlines(context, spec.targetChars);
    return { text: truncated, level: "headlines-extractive", originalLength, compressedLength: truncated.length };
  }

  return { text: context, level: "full-fallback", originalLength, compressedLength: originalLength };
}

// ─── Extractive fallback: no LLM needed ──────────────────────────────────────

/**
 * Extract key lines from context without LLM.
 * Picks: headers, lines with warnings/TODOs/paths, first line of each section.
 */
function _extractiveHeadlines(context, targetChars) {
  const lines = context.split("\n");
  const picked = [];
  let chars = 0;

  // Priority 1: headers and warning/TODO lines
  for (const line of lines) {
    if (chars >= targetChars) break;
    const trimmed = line.trim();
    if (
      trimmed.startsWith("#") ||
      trimmed.startsWith("- ⚠") ||
      trimmed.startsWith("- 🔴") ||
      /\bwarning\b/i.test(trimmed) ||
      /\bTODO\b/i.test(trimmed) ||
      /\b(JIRA|IBLRDM)\b/.test(trimmed) ||
      /^- \*\*/.test(trimmed)
    ) {
      picked.push(trimmed);
      chars += trimmed.length + 1;
    }
  }

  // Priority 2: lines with paths or IDs (fill remaining budget)
  if (chars < targetChars * 0.8) {
    for (const line of lines) {
      if (chars >= targetChars) break;
      const trimmed = line.trim();
      if (picked.includes(trimmed)) continue;
      if (
        /[A-Z]:\\/.test(trimmed) ||
        /\/[a-z]/.test(trimmed) ||
        /https?:\/\//.test(trimmed)
      ) {
        picked.push(trimmed);
        chars += trimmed.length + 1;
      }
    }
  }

  if (picked.length === 0) return "_(no extractable headlines)_";
  return picked.join("\n");
}
