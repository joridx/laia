/**
 * meta-io.js — Centralized state readers for learnings-meta and metrics.
 *
 * Two read modes:
 *   - readMetaStable()    → SQLite primary, JSON fallback, always { learnings: {} } shape
 *   - readMetaWithDirty() → checks in-memory dirty buffer first (for learnings.js debounce)
 *   - readMetricsStable() → SQLite primary, JSON fallback, always {} shape
 *
 * Previously duplicated across: learnings.js, maintenance.js, distillation.js, tools/shared.js
 */

import { readFile, readJSON } from "./file-io.js";
import { metaRepo, metricsRepo } from "./database.js";

// ─── Stable readers (no process-state dependency) ────────────────────────────

/**
 * Read learnings meta. SQLite primary → JSON fallback → empty default.
 * Always returns { learnings: { slug: metaObj } } shape.
 */
export function readMetaStable() {
  // Primary: SQLite via metaRepo
  const all = metaRepo.getAll(); // null when DB unavailable
  if (all && typeof all === "object") return { learnings: all };

  // Fallback: JSON file with shape validation
  const json = readJSON("learnings-meta.json");
  if (json && typeof json === "object") {
    if ("learnings" in json) {
      const l = json.learnings;
      return { learnings: (l && typeof l === "object") ? l : {} };
    }
    // Legacy format: top-level slugs without wrapper
    return { learnings: json };
  }

  // Final safe default
  return { learnings: {} };
}

/**
 * Read metrics. SQLite primary → JSON fallback → empty default.
 * Always returns {} shape (never null/undefined).
 */
export function readMetricsStable() {
  // Primary: SQLite via metricsRepo
  const all = metricsRepo.getAll(); // null when DB unavailable
  if (all && typeof all === "object") return all;

  // Fallback: JSON file
  const json = readJSON("metrics.json");
  if (json && typeof json === "object") return json;

  // Final safe default
  return {};
}

// ─── Dirty-aware reader (for learnings.js debounced writes) ──────────────────

/**
 * Read meta with dirty-buffer check.
 * If getDirtyRef() returns a non-null value, use that instead of DB/JSON.
 * This prevents stale reads during the debounce window.
 *
 * @param {Function} getDirtyRef - Returns the dirty meta ref (or null/undefined)
 * @returns {{ learnings: object }}
 */
export function readMetaWithDirty(getDirtyRef) {
  const dirty = getDirtyRef();
  if (dirty != null) return dirty;
  return readMetaStable();
}
