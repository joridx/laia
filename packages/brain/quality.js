/**
 * quality.js — Quality Scorecard for LAIA sessions (V4 Sprint 3).
 *
 * Computes a composite quality score (1-10) per session, detects trends,
 * and triggers alerts when quality degrades.
 */

// ─── Composite Score Formula ────────────────────────────────────────────────
// From Brain Evolution Plan (Codex-improved):
// score = 10
// if !task_completed: score -= 4
// if rework_required: score -= 2
// score -= min(max(0, user_corrections) * 0.5, 2)
// score -= min(max(0, tool_errors) * 0.3, 1.5)
// if satisfaction == "low": score -= 1
// if satisfaction == "medium": score -= 0.5
// Floor at 1, cap at 10

const VALID_SATISFACTION = new Set(["high", "medium", "low"]);

/**
 * Compute composite quality score from a quality object.
 * @param {object} quality
 * @returns {number} Score 1.0–10.0
 */
export function computeCompositeScore(quality) {
  if (!quality || typeof quality !== "object") return null;

  let score = 10;

  if (quality.task_completed === false) score -= 4;
  if (quality.rework_required === true) score -= 2;

  const corrections = Math.max(0, Number(quality.user_corrections) || 0);
  score -= Math.min(corrections * 0.5, 2);

  const toolErrors = Math.max(0, Number(quality.tool_errors) || 0);
  score -= Math.min(toolErrors * 0.3, 1.5);

  const satisfaction = String(quality.satisfaction || "").toLowerCase();
  if (satisfaction === "low") score -= 1;
  if (satisfaction === "medium") score -= 0.5;

  // Floor at 1, cap at 10, round to 1 decimal
  return Math.round(Math.max(1, Math.min(10, score)) * 10) / 10;
}

/**
 * Validate and sanitize a quality object.
 * Returns null if no valid fields found.
 */
export function sanitizeQuality(quality) {
  if (!quality || typeof quality !== "object") return null;

  const result = {};
  let hasAnyField = false;

  // Boolean fields
  if (typeof quality.task_completed === "boolean") {
    result.task_completed = quality.task_completed;
    hasAnyField = true;
  }
  if (typeof quality.rework_required === "boolean") {
    result.rework_required = quality.rework_required;
    hasAnyField = true;
  }

  // Integer fields (clamp to sane ranges)
  for (const field of ["user_corrections", "tool_errors", "tools_used", "turns"]) {
    if (quality[field] != null) {
      const val = Math.max(0, Math.min(9999, Math.floor(Number(quality[field]) || 0)));
      result[field] = val;
      hasAnyField = true;
    }
  }

  // Enum field
  if (quality.satisfaction) {
    const sat = String(quality.satisfaction).toLowerCase();
    result.satisfaction = VALID_SATISFACTION.has(sat) ? sat : "medium";
    hasAnyField = true;
  }

  return hasAnyField ? result : null;
}

// ─── Trend Detection ────────────────────────────────────────────────────────

/**
 * Analyze quality trend from recent scores.
 * @param {Array<{score: number, date: string, project: string}>} entries
 * @returns {{ scores: number[], avg: number, last: number|null, alert: string|null, sparkline: string }}
 */
export function analyzeTrend(entries) {
  if (!entries || entries.length === 0) {
    return { scores: [], avg: 0, last: null, alert: null, sparkline: "" };
  }

  const scores = entries.map(e => e.score);
  const avg = Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10;
  const last = scores[scores.length - 1];

  // Alert: 3 consecutive sessions with score < 6
  let alert = null;
  if (scores.length >= 3) {
    const tail3 = scores.slice(-3);
    if (tail3.every(s => s < 6)) {
      alert = "⚠️ Quality declining: 3 consecutive sessions scored below 6";
    }
  }

  // Alert: high tool error rate in last session
  if (!alert && entries.length > 0) {
    const lastEntry = entries[entries.length - 1];
    if (lastEntry.tool_errors && lastEntry.tools_used) {
      const errorRate = lastEntry.tool_errors / lastEntry.tools_used;
      if (errorRate > 0.3) {
        alert = `⚠️ High tool error rate: ${Math.round(errorRate * 100)}% in last session`;
      }
    }
  }

  const sparkline = formatSparkline(scores);

  return { scores, avg, last, alert, sparkline };
}

/**
 * Format scores as a Unicode sparkline.
 * Bars: ▁▂▃▄▅▆▇█ (maps 1-10 to 8 levels)
 */
export function formatSparkline(scores) {
  if (!scores || scores.length === 0) return "";
  const bars = "▁▂▃▄▅▆▇█";
  return scores.map(s => {
    const idx = Math.max(0, Math.min(7, Math.round((s - 1) * 7 / 9)));
    return bars[idx];
  }).join("");
}
