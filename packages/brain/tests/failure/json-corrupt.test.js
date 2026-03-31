/**
 * 16.4 Failure-mode test: JSON corrupte
 * Verifies that corrupted JSON files (index.json, relations.json, learnings-meta.json,
 * metrics.json) don't crash the system — fallback to SQLite or safe defaults.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "../harness.js";

const t = createSuite("json-corrupt");

// ─── Setup: BRAIN_PATH with valid structure but we'll corrupt files ──────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-corrupt-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

// Create directory structure
for (const dir of [
  "memory/sessions", "memory/learnings", "memory/projects",
  "memory/todos", "knowledge/general"
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}

const today = new Date().toISOString().split("T")[0];

// Seed valid JSON files first
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({
  version: "2.0", sessions: [], consolidation: {}
}));
fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({
  tag_hits: {}, search_hits: {}, total_queries: 0
}));
fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({
  concepts: { docker: { related_to: ["kubernetes"] } }
}));
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {}
}));

// Create a test learning
fs.mkdirSync(path.join(tmpDir, "memory/learnings"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "memory/learnings/test-learning.md"), `---
title: "Test Learning"
headline: "A test learning"
type: learning
created: ${today}
tags: [test, docker]
slug: test-learning
---

This is a test learning about docker.
`);

// Import module AFTER setup
const mod = await import("../../index.js");
const {
  readFile, writeFile, readJSON, invalidateJsonCache, invalidateAllContentCaches,
  getAllLearnings, computeAllVitalities, scoredSearch,
  recordHit, addRelation,
  rebuildFullIndex
} = mod;

// getRelatedConcepts not exported from index.js, import directly
const { getRelatedConcepts } = await import("../../graph.js");

// Rebuild index so SQLite has data before we corrupt JSON
rebuildFullIndex();
invalidateAllContentCaches();

// ─── Test 1: Corrupt metrics.json → recordHit doesn't crash ─────────────────

t.section("Corrupt metrics.json");

fs.writeFileSync(path.join(tmpDir, "metrics.json"), "{{{not json at all");
invalidateJsonCache("metrics.json");

try {
  recordHit("tag", "docker");
  t.assert(true, "recordHit doesn't crash with corrupt metrics.json");
} catch (e) {
  t.assert(false, `recordHit crashed: ${e.message}`);
}

// Verify it recovered (wrote a fresh valid file)
invalidateJsonCache("metrics.json");
const metricsAfter = readJSON("metrics.json");
t.assert(metricsAfter !== null, "metrics.json recovered after recordHit");
t.assert(metricsAfter?.total_queries >= 1, "metrics has queries after recovery");

// ─── Test 2: Corrupt relations.json → getRelatedConcepts doesn't crash ──────

t.section("Corrupt relations.json");

fs.writeFileSync(path.join(tmpDir, "relations.json"), "BROKEN{{{{");
invalidateJsonCache("relations.json");

try {
  const related = getRelatedConcepts("docker");
  t.assert(Array.isArray(related), "getRelatedConcepts returns array with corrupt relations.json");
  t.assert(true, "getRelatedConcepts doesn't crash");
} catch (e) {
  t.assert(false, `getRelatedConcepts crashed: ${e.message}`);
}

try {
  addRelation("python", { related_to: ["flask"] });
  t.assert(true, "addRelation doesn't crash with corrupt relations.json");
} catch (e) {
  t.assert(false, `addRelation crashed: ${e.message}`);
}

// ─── Test 3: Corrupt learnings-meta.json → scoredSearch falls back to SQLite ─

t.section("Corrupt learnings-meta.json");

fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), "NOT_JSON!!!");
invalidateJsonCache("learnings-meta.json");

try {
  const searchResult = await scoredSearch("docker test");
  t.assert(searchResult !== null, "scoredSearch returns result with corrupt meta");
  t.assert(Array.isArray(searchResult.learnings), "scoredSearch.learnings is array");
  t.assert(true, "scoredSearch doesn't crash with corrupt learnings-meta.json");
} catch (e) {
  t.assert(false, `scoredSearch crashed with corrupt meta: ${e.message}`);
}

// ─── Test 4: Corrupt index.json → brain_log_session doesn't crash ────────────

t.section("Corrupt index.json");

fs.writeFileSync(path.join(tmpDir, "index.json"), "<<<CORRUPT>>>");
invalidateJsonCache("index.json");

const { handler: logSessionHandler } = await import("../../tools/brain-log-session.js");

try {
  await logSessionHandler({
    project: "test-project",
    summary: "Test session summary",
    tags: ["test"]
  });
  t.assert(true, "brain_log_session doesn't crash with corrupt index.json");
} catch (e) {
  t.assert(false, `brain_log_session crashed: ${e.message}`);
}

// Verify session file was written (even with corrupt index)
const sessionFiles = fs.readdirSync(path.join(tmpDir, "memory/sessions"));
t.assert(sessionFiles.length > 0, "Session file written despite corrupt index.json");

// Note: index.json is NOT auto-recovered — log_session skips index update when corrupt.
// The session file is still written, just not indexed. This is acceptable degradation.
invalidateJsonCache("index.json");
const indexAfter = readJSON("index.json");
// index stays corrupt — brain_get_context will recreate it on next startup
t.assert(indexAfter === null, "index.json stays corrupt (not auto-recovered by log_session)");

// ─── Test 5: ALL JSON files corrupt simultaneously → brain_get_context ───────

t.section("All JSON files corrupt simultaneously");

fs.writeFileSync(path.join(tmpDir, "index.json"), "BROKEN");
fs.writeFileSync(path.join(tmpDir, "metrics.json"), "BROKEN");
fs.writeFileSync(path.join(tmpDir, "relations.json"), "BROKEN");
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), "BROKEN");
invalidateJsonCache();

const { handler: getContextHandler } = await import("../../tools/brain-get-context.js");

try {
  const result = await getContextHandler({});
  t.assert(result !== null, "brain_get_context returns result with all JSON corrupt");
  t.assert(typeof result === "object", "Result is object");
  t.assert(true, "brain_get_context doesn't crash with all JSON corrupt");
} catch (e) {
  t.assert(false, `brain_get_context crashed with all JSON corrupt: ${e.message}`);
}

// ─── Test 6: Zero-byte JSON files ────────────────────────────────────────────

t.section("Zero-byte JSON files");

fs.writeFileSync(path.join(tmpDir, "metrics.json"), "");
fs.writeFileSync(path.join(tmpDir, "relations.json"), "");
invalidateJsonCache();

t.assert(readJSON("metrics.json") === null, "readJSON returns null for empty metrics.json");
t.assert(readJSON("relations.json") === null, "readJSON returns null for empty relations.json");

try {
  recordHit("tag", "test");
  t.assert(true, "recordHit handles zero-byte metrics.json");
} catch (e) {
  t.assert(false, `recordHit crashed with zero-byte file: ${e.message}`);
}

// ─── Test 7: Truncated JSON (partial write / crash mid-write) ────────────────

t.section("Truncated JSON (mid-write crash simulation)");

fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), '{"learnings":{"test-learning":{"title":"Test"');
invalidateJsonCache("learnings-meta.json");

try {
  const vMap = computeAllVitalities();
  t.assert(vMap instanceof Map, "computeAllVitalities handles truncated JSON");
  t.assert(true, "computeAllVitalities doesn't crash with truncated meta");
} catch (e) {
  t.assert(false, `computeAllVitalities crashed with truncated JSON: ${e.message}`);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

t.summary();
