import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCompositeScore,
  sanitizeQuality,
  analyzeTrend,
  formatSparkline,
} from "../packages/brain/quality.js";

describe("computeCompositeScore", () => {
  it("returns 10 for perfect session", () => {
    assert.equal(computeCompositeScore({
      task_completed: true,
      rework_required: false,
      user_corrections: 0,
      tool_errors: 0,
      satisfaction: "high"
    }), 10);
  });

  it("returns null for null/undefined input", () => {
    assert.equal(computeCompositeScore(null), null);
    assert.equal(computeCompositeScore(undefined), null);
  });

  it("subtracts 4 for incomplete task", () => {
    assert.equal(computeCompositeScore({ task_completed: false }), 6);
  });

  it("subtracts 2 for rework", () => {
    assert.equal(computeCompositeScore({ rework_required: true }), 8);
  });

  it("caps correction penalty at 2", () => {
    assert.equal(computeCompositeScore({ user_corrections: 10 }), 8);
  });

  it("caps tool_error penalty at 1.5", () => {
    assert.equal(computeCompositeScore({ tool_errors: 100 }), 8.5);
  });

  it("subtracts 1 for low satisfaction", () => {
    assert.equal(computeCompositeScore({ satisfaction: "low" }), 9);
  });

  it("subtracts 0.5 for medium satisfaction", () => {
    assert.equal(computeCompositeScore({ satisfaction: "medium" }), 9.5);
  });

  it("floors at 1", () => {
    const score = computeCompositeScore({
      task_completed: false,
      rework_required: true,
      user_corrections: 10,
      tool_errors: 100,
      satisfaction: "low"
    });
    assert.equal(score, 1);
  });

  it("handles worst case with all penalties", () => {
    const score = computeCompositeScore({
      task_completed: false,   // -4
      rework_required: true,   // -2
      user_corrections: 5,     // -2 (capped)
      tool_errors: 10,         // -1.5 (capped)
      satisfaction: "low"      // -1
    });
    // 10 - 4 - 2 - 2 - 1.5 - 1 = -0.5 → clamped to 1
    assert.equal(score, 1);
  });
});

describe("sanitizeQuality", () => {
  it("returns null for null input", () => {
    assert.equal(sanitizeQuality(null), null);
  });

  it("returns null for empty object", () => {
    assert.equal(sanitizeQuality({}), null);
  });

  it("preserves valid fields", () => {
    const result = sanitizeQuality({
      task_completed: true,
      user_corrections: 3,
      satisfaction: "high"
    });
    assert.deepEqual(result, {
      task_completed: true,
      user_corrections: 3,
      satisfaction: "high"
    });
  });

  it("clamps negative numbers to 0", () => {
    assert.equal(sanitizeQuality({ tool_errors: -5 }).tool_errors, 0);
  });

  it("clamps huge numbers to 9999", () => {
    assert.equal(sanitizeQuality({ tools_used: 999999 }).tools_used, 9999);
  });

  it("normalizes invalid satisfaction to medium", () => {
    assert.equal(sanitizeQuality({ satisfaction: "GREAT" }).satisfaction, "medium");
  });
});

describe("analyzeTrend", () => {
  it("returns empty for no entries", () => {
    const result = analyzeTrend([]);
    assert.equal(result.scores.length, 0);
    assert.equal(result.alert, null);
  });

  it("computes avg and last correctly", () => {
    const entries = [
      { score: 8, date: "2026-03-29" },
      { score: 9, date: "2026-03-30" },
      { score: 10, date: "2026-03-31" },
    ];
    const result = analyzeTrend(entries);
    assert.equal(result.avg, 9);
    assert.equal(result.last, 10);
  });

  it("alerts on 3 consecutive low scores", () => {
    const entries = [
      { score: 5, date: "2026-03-29" },
      { score: 4, date: "2026-03-30" },
      { score: 3, date: "2026-03-31" },
    ];
    const result = analyzeTrend(entries);
    assert.ok(result.alert?.includes("Quality declining"));
  });

  it("no alert when only 2 low scores", () => {
    const entries = [
      { score: 8, date: "2026-03-29" },
      { score: 5, date: "2026-03-30" },
      { score: 4, date: "2026-03-31" },
    ];
    const result = analyzeTrend(entries);
    assert.equal(result.alert, null);
  });

  it("alerts on high tool error rate", () => {
    const entries = [
      { score: 7, date: "2026-03-31", tool_errors: 8, tools_used: 10 },
    ];
    const result = analyzeTrend(entries);
    assert.ok(result.alert?.includes("tool error rate"));
  });
});

describe("formatSparkline", () => {
  it("returns empty for empty input", () => {
    assert.equal(formatSparkline([]), "");
  });

  it("renders min and max correctly", () => {
    const result = formatSparkline([1, 10]);
    assert.equal(result[0], "▁");
    assert.equal(result[1], "█");
  });

  it("renders mid-range values", () => {
    const result = formatSparkline([5, 5, 5]);
    assert.equal(result.length, 3);
    // Each char should be in the middle range
    assert.ok("▃▄▅".includes(result[0]));
  });
});
