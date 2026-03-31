/**
 * schema-validation.js — Startup schema validation for persisted JSON files.
 *
 * Uses Zod (already present via @modelcontextprotocol/sdk) for lightweight
 * structural validation. Runs once at startup, not per-read.
 *
 * Strategy:
 *   - Validate top-level shape of each critical JSON file
 *   - Per-entry validation is lenient (.passthrough()) to allow schema evolution
 *   - On failure: log detailed error, continue with safe defaults (don't crash)
 *   - Also exports normalizeLearningEntry() to replace scattered || 0 fallbacks
 */

import { z } from "zod";
import { readJSON } from "./file-io.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Learning meta entry — lenient, allows extra fields.
 * Required: none (all optional with defaults via normalizeLearningEntry).
 * This only validates the *shape* is reasonable, not every field.
 */
const LearningEntrySchema = z.object({
  hit_count:             z.number().optional(),
  last_accessed:         z.string().nullable().optional(),
  search_appearances:    z.number().optional(),
  search_followup_hits:  z.number().optional(),
  confirmation_count:    z.number().optional(),
  last_confirmed:        z.string().nullable().optional(),
  vitality:              z.number().optional(),
  vitality_zone:         z.string().optional(),
  vitality_updated:      z.string().nullable().optional(),
  stale:                 z.boolean().optional(),
  archived:              z.boolean().optional(),
  archived_at:           z.string().nullable().optional(),
  archived_by:           z.string().nullable().optional(),
  source:                z.string().optional(),
  source_type:            z.string().optional(),
  source_session:         z.string().optional(),
  source_context:         z.string().optional(),
  created_by:             z.string().optional(),
  source_ref:             z.string().nullable().optional(),
  superseded_by:         z.string().nullable().optional(),
  merge_count:           z.number().optional(),
  created_date:          z.string().nullable().optional(),
  file:                  z.string().nullable().optional(),
  title:                 z.string().nullable().optional(),
  type:                  z.string().nullable().optional(),
}).passthrough();  // Allow extra fields for forward compatibility

const LearningsMetaSchema = z.object({
  learnings: z.record(z.string(), LearningEntrySchema)
}).passthrough();

/**
 * Relations — concepts + optional hierarchy.
 */
const ConceptEntrySchema = z.object({
  related_to: z.array(z.string()).optional(),
  parent:     z.string().optional(),
  children:   z.array(z.string()).optional(),
}).passthrough();

const RelationsSchema = z.object({
  concepts: z.record(z.string(), ConceptEntrySchema)
}).passthrough();  // Allow hierarchy and future top-level keys

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize a learning meta entry with safe defaults.
 * Replaces scattered `|| 0`, `|| null`, `?? 0.5` across 15+ locations.
 *
 * @param {object} raw - Raw entry from learnings-meta.json or SQLite
 * @returns {object} - Entry with all standard fields guaranteed
 */
/** Safe number coercion: string numbers → number, invalid → default */
function toNum(val, fallback) {
  if (typeof val === "number" && isFinite(val)) return val;
  if (typeof val === "string") { const n = Number(val); if (isFinite(n)) return n; }
  return fallback;
}

/** Safe boolean coercion: handles "false"/"true" strings, numbers */
function toBool(val) {
  if (typeof val === "boolean") return val;
  if (val === "false" || val === 0) return false;
  return !!val;
}

export function normalizeLearningEntry(raw) {
  if (!raw || typeof raw !== "object") raw = {};
  const vitality = toNum(raw.vitality, 0.5);
  return {
    hit_count:            toNum(raw.hit_count, 0),
    last_accessed:        raw.last_accessed         ?? null,
    search_appearances:   toNum(raw.search_appearances, 0),
    search_followup_hits: toNum(raw.search_followup_hits, 0),
    confirmation_count:   toNum(raw.confirmation_count, 0),
    last_confirmed:       raw.last_confirmed        ?? null,
    vitality:             Math.max(0, Math.min(1, vitality)),
    vitality_zone:        raw.vitality_zone         || "active",
    vitality_updated:     raw.vitality_updated      ?? null,
    stale:                toBool(raw.stale),
    archived:             toBool(raw.archived),
    archived_at:          raw.archived_at           ?? null,
    archived_by:          raw.archived_by           ?? null,
    source:               raw.source                || "agent",
    source_type:           raw.source_type           || null,
    source_session:        raw.source_session        || null,
    source_context:        raw.source_context        || null,
    created_by:            raw.created_by            || null,
    source_ref:            raw.source_ref            ?? null,
    superseded_by:        raw.superseded_by         ?? null,
    merge_count:          toNum(raw.merge_count, 0),
    created_date:         raw.created_date          ?? null,
    file:                 raw.file                  ?? null,
    title:                raw.title                 ?? null,
    type:                 raw.type                  ?? null,
    // Preserve extra fields (maintenance, subsumes, model, etc.)
    ...Object.fromEntries(
      Object.entries(raw).filter(([k]) => !(k in STANDARD_FIELDS))
    ),
  };
}

/** Set of standard fields (for filtering extras in normalizeLearningEntry) */
const STANDARD_FIELDS = {
  hit_count: 1, last_accessed: 1, search_appearances: 1, search_followup_hits: 1,
  confirmation_count: 1, last_confirmed: 1, vitality: 1, vitality_zone: 1,
  vitality_updated: 1, stale: 1, archived: 1, archived_at: 1, archived_by: 1,
  source: 1, source_type: 1, source_session: 1, source_context: 1, created_by: 1, source_ref: 1,
  superseded_by: 1, merge_count: 1, created_date: 1, file: 1,
  title: 1, type: 1,
};

// ─── Startup Validation ──────────────────────────────────────────────────────

/**
 * Validate persisted JSON files at startup.
 * Returns { valid: boolean, issues: string[] }.
 * Does NOT throw — logs issues and continues.
 *
 * @param {object} [options] - Optional overrides for testing
 * @param {object|null} [options.meta] - Pre-loaded learnings-meta (skip file read)
 * @param {object|null} [options.relations] - Pre-loaded relations (skip file read)
 */
export function validatePersistedData(options = {}) {
  const issues = [];

  // 1. learnings-meta.json
  const meta = options.meta !== undefined ? options.meta : readJSON("learnings-meta.json");
  if (meta !== null) {
    const result = LearningsMetaSchema.safeParse(meta);
    if (!result.success) {
      const detail = result.error.issues
        .slice(0, 5)
        .map(i => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      issues.push(`learnings-meta.json: invalid schema\n${detail}`);
    } else {
      // Semantic checks (Zod guarantees types; check ranges/invariants)
      const { learnings } = result.data;
      let semanticIssues = 0;
      for (const [slug, entry] of Object.entries(learnings)) {
        if (entry.vitality !== undefined && (entry.vitality < 0 || entry.vitality > 1)) semanticIssues++;
        if (entry.hit_count !== undefined && entry.hit_count < 0) semanticIssues++;
      }
      if (semanticIssues > 0) {
        issues.push(`learnings-meta.json: ${semanticIssues} entries with out-of-range values (will be clamped)`);
      }
    }
  }
  // null = file doesn't exist or malformed JSON → readMetaStable handles this

  // 2. relations.json
  const relations = options.relations !== undefined ? options.relations : readJSON("relations.json");
  if (relations !== null) {
    const result = RelationsSchema.safeParse(relations);
    if (!result.success) {
      const detail = result.error.issues
        .slice(0, 5)
        .map(i => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      issues.push(`relations.json: invalid schema\n${detail}`);
    }
    // (Zod already guarantees related_to is array when present — no redundant checks needed)
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

// ─── Exports for testing ─────────────────────────────────────────────────────

export { LearningsMetaSchema, RelationsSchema, LearningEntrySchema, ConceptEntrySchema };
