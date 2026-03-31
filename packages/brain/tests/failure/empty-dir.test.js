/**
 * 16.6 Failure-mode test: brain-data dir buit
 * Verifies that all core functions handle an empty BRAIN_PATH gracefully
 * (safe defaults, no crashes).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "../harness.js";

const t = createSuite("empty-dir");

// ─── Setup: completely empty BRAIN_PATH (no subdirs, no files) ───────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-empty-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

// Import module AFTER setting BRAIN_PATH
const mod = await import("../../index.js");
const {
  readFile, writeFile, readJSON, invalidateJsonCache,
  getAllLearnings, computeAllVitalities, scoredSearch,
} = mod;

// Also import handler directly
const { handler: getContextHandler } = await import("../../tools/brain-get-context.js");
const { handler: searchHandler } = await import("../../tools/brain-search.js");

// ─── readFile / readJSON on missing files ────────────────────────────────────

t.section("readFile/readJSON with empty dir");

t.assert(readFile("memory/user/preferences.md") === null, "readFile returns null for missing file");
// Note: index.json is auto-created on module import, so it won't be null
const idx = readJSON("index.json");
t.assert(idx !== null, "index.json auto-created on startup");
t.assert(readJSON("metrics.json") === null, "readJSON returns null for missing metrics.json");
t.assert(readJSON("relations.json") === null, "readJSON returns null for missing relations.json");
t.assert(readJSON("learnings-meta.json") === null, "readJSON returns null for missing learnings-meta.json");

// ─── getAllLearnings with no files ───────────────────────────────────────────

t.section("getAllLearnings with empty dir");

const learnings = getAllLearnings();
t.assert(Array.isArray(learnings), "getAllLearnings returns array");
t.assert(learnings.length === 0, `getAllLearnings returns empty (got ${learnings.length})`);

// ─── computeAllVitalities with no data ───────────────────────────────────────

t.section("computeAllVitalities with empty dir");

const vMap = computeAllVitalities();
t.assert(vMap instanceof Map, "computeAllVitalities returns Map");
t.assert(vMap.size === 0, `Map is empty (got ${vMap.size})`);

// ─── scoredSearch with no data ───────────────────────────────────────────────

t.section("scoredSearch with empty dir");

const searchResult = await scoredSearch("docker deployment");
t.assert(searchResult !== null && searchResult !== undefined, "scoredSearch returns result object");
t.assert(Array.isArray(searchResult.learnings), "scoredSearch.learnings is array");
t.assert(searchResult.learnings.length === 0, "scoredSearch returns 0 learnings");

// ─── brain_search handler with empty dir ─────────────────────────────────────

t.section("brain_search handler with empty dir");

let searchHandlerResult;
try {
  searchHandlerResult = await searchHandler({ query: "test query" });
  t.assert(searchHandlerResult !== null, "brain_search handler returns result");
  t.assert(true, "brain_search handler doesn't crash on empty dir");
} catch (e) {
  t.assert(false, `brain_search handler crashed: ${e.message}`);
}

// ─── brain_get_context handler with empty dir ────────────────────────────────

t.section("brain_get_context handler with empty dir");

let contextResult;
try {
  contextResult = await getContextHandler({});
  t.assert(contextResult !== null, "brain_get_context returns result");
  t.assert(typeof contextResult === "object", "brain_get_context returns object");
  t.assert(true, "brain_get_context doesn't crash on empty dir");
} catch (e) {
  t.assert(false, `brain_get_context crashed on empty dir: ${e.message}`);
}

// ─── writeFile creates dirs on demand ────────────────────────────────────────

t.section("writeFile auto-creates dirs");

writeFile("memory/sessions/test-session.md", "# Test session");
const written = readFile("memory/sessions/test-session.md");
t.assert(written === "# Test session", "writeFile creates nested dirs and writes content");

// ─── Cleanup ─────────────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

t.summary();
