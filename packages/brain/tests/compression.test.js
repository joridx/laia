/**
 * Tests for compression.js — multi-level context compression
 */
import { createSuite } from "./harness.js";
import { autoSelectLevel, compressContext, COMPRESSION_LEVELS } from "../compression.js";

const t = createSuite("compression");

// ─── COMPRESSION_LEVELS structure ────────────────────────────────────────────

t.section("COMPRESSION_LEVELS");

t.assert(COMPRESSION_LEVELS.full != null, "full level exists");
t.assert(COMPRESSION_LEVELS.summary != null, "summary level exists");
t.assert(COMPRESSION_LEVELS.headlines != null, "headlines level exists");
t.assert(COMPRESSION_LEVELS.summary.targetChars === 3000, "summary target 3000");
t.assert(COMPRESSION_LEVELS.headlines.targetChars === 1200, "headlines target 1200");
t.assert(COMPRESSION_LEVELS.headlines.systemPrompt.includes("bullet"), "headlines prompt mentions bullet");

// ─── autoSelectLevel ─────────────────────────────────────────────────────────

t.section("autoSelectLevel");

// Without budget (auto by context size)
t.assert(autoSelectLevel(2000, null) === "full", "small context → full");
t.assert(autoSelectLevel(4000, null) === "full", "4000 chars → full");
t.assert(autoSelectLevel(5000, null) === "summary", "5000 chars → summary");
t.assert(autoSelectLevel(15000, null) === "summary", "15000 chars → summary");

// With budget
t.assert(autoSelectLevel(10000, 10000) === "full", "budget 10000 → full");
t.assert(autoSelectLevel(10000, 8000) === "full", "budget 8000 → full");
t.assert(autoSelectLevel(10000, 5000) === "summary", "budget 5000 → summary");
t.assert(autoSelectLevel(10000, 3000) === "summary", "budget 3000 → summary");
t.assert(autoSelectLevel(10000, 2999) === "headlines", "budget 2999 → headlines");
t.assert(autoSelectLevel(10000, 1000) === "headlines", "budget 1000 → headlines");
t.assert(autoSelectLevel(10000, 0) === "headlines", "budget 0 → headlines");

// ─── compressContext: full level ─────────────────────────────────────────────

t.section("compressContext full level");

{
  const text = "Short context that should not be compressed.";
  const result = await compressContext(text, { level: "full" });
  t.assert(result.level === "full", "explicit full → level=full");
  t.assert(result.text === text, "full → text unchanged");
  t.assert(result.originalLength === text.length, "originalLength correct");
  t.assert(result.compressedLength === text.length, "compressedLength same");
}

// ─── compressContext: auto selects full for small context ────────────────────

{
  const text = "A".repeat(3000);
  const result = await compressContext(text);
  t.assert(result.level === "full", "3000 chars auto → full");
}

// ─── compressContext: headlines-extractive fallback (no LLM) ─────────────────

t.section("compressContext headlines-extractive");

{
  const text = `# Project Status
This is a verbose description of the project.
More verbose description.

## Warnings
- ⚠ Jenkins pipeline failing since March 20
- Some normal line
- **Active TODO:** Fix the build

## Sessions
Long session narrative that should be removed.
Another session narrative.
Yet another.

## Paths
Config at C:\\laia\\config.json
API at https://api.example.com/v1
Normal line without path.

## More Content
${("Filler line.\n").repeat(50)}`;

  const result = await compressContext(text, { level: "headlines" });
  // Without LLM, should use extractive fallback
  t.assert(
    result.level === "headlines" || result.level === "headlines-extractive",
    `headlines level used (got ${result.level})`
  );
  t.assert(result.compressedLength < result.originalLength, "compressed is shorter");
  t.assert(result.text.includes("# Project Status"), "headers preserved");
  t.assert(result.text.includes("Jenkins"), "warning preserved");
  t.assert(result.text.includes("TODO"), "TODO preserved");
}

// ─── compressContext: summary without LLM → full-fallback ────────────────────

t.section("compressContext summary fallback");

{
  const text = "A".repeat(5000);
  const result = await compressContext(text, { level: "summary" });
  // Without LLM available, summary should fallback to full
  t.assert(
    result.level === "summary" || result.level === "full-fallback",
    `summary without LLM → fallback (got ${result.level})`
  );
}

// ─── compressContext: contextBudget auto-selection ────────────────────────────

t.section("compressContext auto via budget");

{
  const text = "A".repeat(10000);
  const result = await compressContext(text, { contextBudget: 1500 });
  t.assert(
    result.level.startsWith("headlines"),
    `budget 1500 → headlines (got ${result.level})`
  );
}

{
  const text = "A".repeat(10000);
  const result = await compressContext(text, { contextBudget: 15000 });
  t.assert(result.level === "full", "budget 15000 → full");
}

// ─── Summary ────────────────────────────────────────────────────────────────

const { passed, failed } = t.summary();
process.exit(failed > 0 ? 1 : 0);
