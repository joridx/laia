/**
 * Tests for schema-validation.js — Zod startup validation + normalizeLearningEntry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Dynamic import ──────────────────────────────────────────────────────────

let validatePersistedData, normalizeLearningEntry;
let LearningsMetaSchema, RelationsSchema, LearningEntrySchema, ConceptEntrySchema;

async function loadModule() {
  const mod = await import(`../schema-validation.js?t=${Date.now()}`);
  validatePersistedData = mod.validatePersistedData;
  normalizeLearningEntry = mod.normalizeLearningEntry;
  LearningsMetaSchema = mod.LearningsMetaSchema;
  RelationsSchema = mod.RelationsSchema;
  LearningEntrySchema = mod.LearningEntrySchema;
  ConceptEntrySchema = mod.ConceptEntrySchema;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("schema-validation", async () => {
  await loadModule();

  // ── normalizeLearningEntry ──

  describe("normalizeLearningEntry", () => {
    it("fills all defaults for empty object", () => {
      const result = normalizeLearningEntry({});
      assert.equal(result.hit_count, 0);
      assert.equal(result.vitality, 0.5);
      assert.equal(result.vitality_zone, "active");
      assert.equal(result.source, "agent");
      assert.equal(result.stale, false);
      assert.equal(result.archived, false);
      assert.equal(result.last_accessed, null);
      assert.equal(result.merge_count, 0);
    });

    it("fills defaults for null input", () => {
      const result = normalizeLearningEntry(null);
      assert.equal(result.hit_count, 0);
      assert.equal(result.vitality, 0.5);
    });

    it("fills defaults for undefined input", () => {
      const result = normalizeLearningEntry(undefined);
      assert.equal(result.hit_count, 0);
    });

    it("preserves existing values", () => {
      const result = normalizeLearningEntry({
        hit_count: 5,
        vitality: 0.9,
        source: "human",
        stale: true,
        title: "test learning",
      });
      assert.equal(result.hit_count, 5);
      assert.equal(result.vitality, 0.9);
      assert.equal(result.source, "human");
      assert.equal(result.stale, true);
      assert.equal(result.title, "test learning");
    });

    it("preserves extra fields (forward compatibility)", () => {
      const result = normalizeLearningEntry({
        hit_count: 1,
        subsumes: ["old-learning"],
        maintenance: "manual",
        model: "claude-3.5-sonnet",
      });
      assert.equal(result.hit_count, 1);
      assert.deepEqual(result.subsumes, ["old-learning"]);
      assert.equal(result.maintenance, "manual");
      assert.equal(result.model, "claude-3.5-sonnet");
    });

    it("coerces stale/archived to boolean", () => {
      const result = normalizeLearningEntry({ stale: 1, archived: 0 });
      assert.equal(result.stale, true);
      assert.equal(result.archived, false);
    });

    it("handles boolean-string 'false' correctly", () => {
      const result = normalizeLearningEntry({ stale: "false", archived: "true" });
      assert.equal(result.stale, false);   // "false" → false
      assert.equal(result.archived, true); // "true" → true
    });

    it("coerces string numbers to numbers", () => {
      const result = normalizeLearningEntry({ hit_count: "5", vitality: "0.8", merge_count: "3" });
      assert.equal(result.hit_count, 5);
      assert.equal(result.vitality, 0.8);
      assert.equal(result.merge_count, 3);
    });

    it("falls back to default for non-numeric strings", () => {
      const result = normalizeLearningEntry({ hit_count: "abc", vitality: "high" });
      assert.equal(result.hit_count, 0);
      assert.equal(result.vitality, 0.5);
    });

    it("handles NaN and Infinity", () => {
      const result = normalizeLearningEntry({ hit_count: NaN, vitality: Infinity });
      assert.equal(result.hit_count, 0);
      assert.equal(result.vitality, 0.5); // Infinity → fallback 0.5 (from toNum), but clamp anyway
    });

    it("clamps vitality to [0, 1]", () => {
      assert.equal(normalizeLearningEntry({ vitality: 1.5 }).vitality, 1);
      assert.equal(normalizeLearningEntry({ vitality: -0.3 }).vitality, 0);
      assert.equal(normalizeLearningEntry({ vitality: 0 }).vitality, 0);
      assert.equal(normalizeLearningEntry({ vitality: 1 }).vitality, 1);
    });

    it("handles created_date: null (nullable)", () => {
      const result = normalizeLearningEntry({ created_date: null });
      assert.equal(result.created_date, null);
    });

    it("handles vitality_zone empty string → 'active'", () => {
      const result = normalizeLearningEntry({ vitality_zone: "" });
      assert.equal(result.vitality_zone, "active");
    });
  });

  // ── Zod Schemas (unit) ──

  describe("LearningsMetaSchema", () => {
    it("accepts valid meta", () => {
      const result = LearningsMetaSchema.safeParse({
        learnings: {
          "test-slug": { hit_count: 5, vitality: 0.8 }
        }
      });
      assert.equal(result.success, true);
    });

    it("accepts empty learnings", () => {
      const result = LearningsMetaSchema.safeParse({ learnings: {} });
      assert.equal(result.success, true);
    });

    it("rejects missing learnings key", () => {
      const result = LearningsMetaSchema.safeParse({ data: {} });
      assert.equal(result.success, false);
    });

    it("rejects learnings as array", () => {
      const result = LearningsMetaSchema.safeParse({ learnings: [] });
      assert.equal(result.success, false);
    });

    it("rejects learnings as string", () => {
      const result = LearningsMetaSchema.safeParse({ learnings: "bad" });
      assert.equal(result.success, false);
    });

    it("accepts entries with extra fields (passthrough)", () => {
      const result = LearningsMetaSchema.safeParse({
        learnings: {
          "slug": { hit_count: 1, subsumes: ["old"], custom_field: true }
        }
      });
      assert.equal(result.success, true);
    });

    it("rejects entry with wrong type for hit_count", () => {
      const result = LearningEntrySchema.safeParse({ hit_count: "five" });
      assert.equal(result.success, false);
    });

    it("accepts entry with all nullables as null", () => {
      const result = LearningEntrySchema.safeParse({
        last_accessed: null,
        last_confirmed: null,
        vitality_updated: null,
        archived_at: null,
        archived_by: null,
        superseded_by: null,
        created_date: null,
        file: null,
        title: null,
        type: null,
      });
      assert.equal(result.success, true);
    });
  });

  describe("RelationsSchema", () => {
    it("accepts valid relations", () => {
      const result = RelationsSchema.safeParse({
        concepts: {
          "javascript": { related_to: ["nodejs", "typescript"] },
          "python": { related_to: [] }
        }
      });
      assert.equal(result.success, true);
    });

    it("accepts empty concepts", () => {
      const result = RelationsSchema.safeParse({ concepts: {} });
      assert.equal(result.success, true);
    });

    it("rejects missing concepts key", () => {
      const result = RelationsSchema.safeParse({ nodes: {} });
      assert.equal(result.success, false);
    });

    it("accepts concepts with parent/children", () => {
      const result = ConceptEntrySchema.safeParse({
        related_to: ["a"],
        parent: "devops",
        children: ["ci", "cd"],
      });
      assert.equal(result.success, true);
    });

    it("accepts extra top-level keys (hierarchy)", () => {
      const result = RelationsSchema.safeParse({
        concepts: {},
        hierarchy: { roots: ["devops"] }
      });
      assert.equal(result.success, true);
    });

    it("rejects concepts as array", () => {
      const result = RelationsSchema.safeParse({ concepts: [] });
      assert.equal(result.success, false);
    });
  });

  // ── validatePersistedData (with injection overrides) ──

  describe("validatePersistedData", () => {
    it("returns valid when no data (null)", () => {
      const { valid, issues } = validatePersistedData({ meta: null, relations: null });
      assert.equal(valid, true);
      assert.equal(issues.length, 0);
    });

    it("returns valid for correct data", () => {
      const { valid, issues } = validatePersistedData({
        meta: { learnings: { "test": { hit_count: 1, vitality: 0.5 } } },
        relations: { concepts: { "js": { related_to: ["ts"] } } },
      });
      assert.equal(valid, true, `Unexpected issues: ${issues.join("; ")}`);
    });

    it("detects invalid learnings-meta shape", () => {
      const { valid, issues } = validatePersistedData({
        meta: { data: {} },  // missing 'learnings'
        relations: null,
      });
      assert.equal(valid, false);
      assert.ok(issues.some(i => i.includes("learnings-meta.json")));
    });

    it("detects invalid relations shape", () => {
      const { valid, issues } = validatePersistedData({
        meta: null,
        relations: { nodes: [] },  // missing 'concepts'
      });
      assert.equal(valid, false);
      assert.ok(issues.some(i => i.includes("relations.json")));
    });

    it("valid with only meta present", () => {
      const { valid } = validatePersistedData({
        meta: { learnings: {} },
        relations: null,
      });
      assert.equal(valid, true);
    });

    it("valid with only relations present", () => {
      const { valid } = validatePersistedData({
        meta: null,
        relations: { concepts: {} },
      });
      assert.equal(valid, true);
    });

    it("detects both files invalid at once", () => {
      const { valid, issues } = validatePersistedData({
        meta: { wrong: true },
        relations: "not an object",
      });
      assert.equal(valid, false);
      assert.ok(issues.length >= 2);
    });

    it("detects type mismatches in entries (Zod level)", () => {
      const { valid, issues } = validatePersistedData({
        meta: {
          learnings: {
            "bad-entry": { hit_count: "five", vitality: "high" },
          }
        },
        relations: null,
      });
      // Zod catches these at the entry level
      assert.equal(valid, false);
    });

    it("detects out-of-range semantic values", () => {
      const { valid, issues } = validatePersistedData({
        meta: {
          learnings: {
            "bad-vitality": { vitality: 2.5, hit_count: -3 },
          }
        },
        relations: null,
      });
      assert.equal(valid, false);
      assert.ok(issues.some(i => i.includes("out-of-range")));
    });
  });
});
