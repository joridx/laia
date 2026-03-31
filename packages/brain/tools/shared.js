/**
 * Shared utilities for tool handlers.
 * Extracted from index.js to avoid circular deps.
 */

import { z } from "zod";
import { readJSON } from "../file-io.js";
import { readMetaStable, readMetricsStable } from "../meta-io.js";

// ─── Zod helper ──────────────────────────────────────────────────────────────

export function zCoercedArray(itemSchema) {
  return z.preprocess((val) => {
    if (Array.isArray(val)) return val;
    if (typeof val === "string") {
      try { const parsed = JSON.parse(val); if (Array.isArray(parsed)) return parsed; } catch {}
      return val.split(",").map(s => s.trim()).filter(Boolean);
    }
    return val;
  }, z.array(itemSchema));
}

// ─── P14.1: Read helpers (SQLite primary, JSON fallback) ────────────────────

/** Read learnings meta. Returns { learnings: { slug: metaObj } } */
export function readMeta() { return readMetaStable(); }

/** Read metrics. Returns { key: value } */
export function readMetrics() { return readMetricsStable(); }

// ─── Tag alias loader (P7.5) ────────────────────────────────────────────────

export function getTagAliasMap() {
  const data = readJSON("tag-aliases.json");
  return data?.aliases || {};
}

// ─── Search log ring buffer (P10.3) ─────────────────────────────────────────

export const SEARCH_LOG_MAX = 50;
