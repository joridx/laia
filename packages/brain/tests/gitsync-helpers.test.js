/**
 * Tests for git-sync merge strategies, schema validation, helpers, and file-io batch/self-heal.
 * Covers audit items 7.6, 7.8, 7.9, 7.10.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("gitsync-helpers");

// ─── Setup: temporary BRAIN_PATH ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-gs-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

for (const dir of [
  "memory/sessions",
  "memory/learnings",
  "memory/projects",
  "knowledge/general",
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}

fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({
  version: "2.0", sessions: [], consolidation: {}
}, null, 2));
fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({
  tag_hits: {}, search_hits: {}, total_queries: 0
}, null, 2));
fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({
  concepts: {}
}, null, 2));
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {}
}, null, 2));

const mod = await import("../index.js");
const {
  mergeJsonFile, validateMergedJson,
  readFile, writeFile, readJSON, invalidateJsonCache,
  invalidateAllContentCaches, cleanupOrphanedTmpFiles, batchWriteFiles,
  scoredSearch, BRAIN_PATH
} = mod;

const { rebuildFullIndex } = await import("../database.js");
// Also import helpers directly for testing
const helpers = await import("../helpers.js");
const { readProjectFile, serializeProject, getRecentSessions, getSessionsByProject, findSimilarProject } = helpers;

// ═══════════════════════════════════════════════════════════════════════════════
// 7.8: Merge schema validation
// ═══════════════════════════════════════════════════════════════════════════════

t.section("validateMergedJson");

t.assert(validateMergedJson("metrics.json", { total: 5 }) === true, "metrics: valid object");
t.assert(validateMergedJson("metrics.json", null) === false, "metrics: null rejected");
t.assert(validateMergedJson("metrics.json", [1, 2]) === false, "metrics: array rejected");
t.assert(validateMergedJson("metrics.json", "string") === false, "metrics: string rejected");

t.assert(validateMergedJson("relations.json", { concepts: {} }) === true, "relations: valid");
t.assert(validateMergedJson("relations.json", { concepts: null }) === false, "relations: concepts=null rejected");
t.assert(validateMergedJson("relations.json", { concepts: [] }) === false, "relations: concepts=array rejected");
t.assert(validateMergedJson("relations.json", {}) === false, "relations: missing concepts rejected");

t.assert(validateMergedJson("learnings-meta.json", { learnings: {} }) === true, "meta: valid");
t.assert(validateMergedJson("learnings-meta.json", { learnings: null }) === false, "meta: null learnings rejected");
t.assert(validateMergedJson("learnings-meta.json", {}) === false, "meta: missing learnings rejected");

t.assert(validateMergedJson("index.json", { sessions: [] }) === true, "index: valid");
t.assert(validateMergedJson("index.json", { sessions: {} }) === false, "index: sessions=object rejected");
t.assert(validateMergedJson("index.json", {}) === false, "index: missing sessions rejected");

t.assert(validateMergedJson("unknown.json", { anything: true }) === true, "unknown: any object accepted");

// ═══════════════════════════════════════════════════════════════════════════════
// 7.8: mergeJsonFile strategies
// ═══════════════════════════════════════════════════════════════════════════════

t.section("mergeJsonFile - metrics");

{
  const base = JSON.stringify({ total_queries: 10, tag_hits: { docker: 5 } });
  const ours = JSON.stringify({ total_queries: 15, tag_hits: { docker: 8, python: 3 } });
  const theirs = JSON.stringify({ total_queries: 12, tag_hits: { docker: 7, java: 1 } });
  const result = mergeJsonFile("metrics.json", base, ours, theirs);
  t.assert(result !== null, "metrics merge succeeds");
  // total_queries: base=10, ours=15 (+5), theirs=12 (+2) → 10+5+2=17
  t.assert(result.total_queries === 17, `metrics: total_queries merged (got ${result.total_queries}, expected 17)`);
  // docker: base=5, ours=8 (+3), theirs=7 (+2) → 5+3+2=10
  t.assert(result.tag_hits.docker === 10, `metrics: docker hits merged (got ${result.tag_hits.docker}, expected 10)`);
  t.assert(result.tag_hits.python === 3, "metrics: ours-only key preserved");
  t.assert(result.tag_hits.java === 1, "metrics: theirs-only key added");
}

t.section("mergeJsonFile - relations");

{
  const base = JSON.stringify({ concepts: { docker: { related_to: ["k8s"], children: [] } } });
  const ours = JSON.stringify({ concepts: { docker: { related_to: ["k8s", "compose"], children: [] }, python: { related_to: ["flask"], children: [] } } });
  const theirs = JSON.stringify({ concepts: { docker: { related_to: ["k8s", "swarm"], children: ["dockerfile"] }, java: { related_to: ["spring"], children: [] } } });
  const result = mergeJsonFile("relations.json", base, ours, theirs);
  t.assert(result !== null, "relations merge succeeds");
  t.assert(result.concepts.docker.related_to.includes("compose"), "relations: ours addition preserved");
  t.assert(result.concepts.docker.related_to.includes("swarm"), "relations: theirs addition merged");
  t.assert(result.concepts.docker.children.includes("dockerfile"), "relations: theirs children merged");
  t.assert(result.concepts.python, "relations: ours-only concept preserved");
  t.assert(result.concepts.java, "relations: theirs-only concept added");
  // No duplicates
  const k8sCount = result.concepts.docker.related_to.filter(r => r === "k8s").length;
  t.assert(k8sCount === 1, "relations: no duplicates in related_to");
}

t.section("mergeJsonFile - learnings-meta");

{
  const base = JSON.stringify({ learnings: { "ssl-fix": { hit_count: 5, last_accessed: "2026-01-01", created_date: "2025-06-01", stale: false } } });
  const ours = JSON.stringify({ learnings: { "ssl-fix": { hit_count: 8, last_accessed: "2026-02-01", created_date: "2025-06-01", stale: false }, "new-ours": { hit_count: 1 } } });
  const theirs = JSON.stringify({ learnings: { "ssl-fix": { hit_count: 7, last_accessed: "2026-03-01", created_date: "2025-06-01", stale: false }, "new-theirs": { hit_count: 2 } } });
  const result = mergeJsonFile("learnings-meta.json", base, ours, theirs);
  t.assert(result !== null, "meta merge succeeds");
  // hit_count: base=5, ours=8 (+3), theirs=7 (+2) → 5+3+2=10
  t.assert(result.learnings["ssl-fix"].hit_count === 10, `meta: hit_count merged (got ${result.learnings["ssl-fix"].hit_count})`);
  t.assert(result.learnings["ssl-fix"].last_accessed === "2026-03-01", "meta: latest last_accessed wins");
  t.assert(result.learnings["new-ours"], "meta: ours-only learning preserved");
  t.assert(result.learnings["new-theirs"], "meta: theirs-only learning added");
}

t.section("mergeJsonFile - index");

{
  const base = JSON.stringify({ sessions: [{ file: "s1.md", date: "2026-01-01" }], updated: "2026-01-01" });
  const ours = JSON.stringify({ sessions: [{ file: "s1.md", date: "2026-01-01" }, { file: "s2.md", date: "2026-02-01" }], updated: "2026-02-01" });
  const theirs = JSON.stringify({ sessions: [{ file: "s1.md", date: "2026-01-01" }, { file: "s3.md", date: "2026-03-01" }], updated: "2026-03-01" });
  const result = mergeJsonFile("index.json", base, ours, theirs);
  t.assert(result !== null, "index merge succeeds");
  t.assert(result.sessions.length === 3, `index: 3 unique sessions (got ${result.sessions.length})`);
  t.assert(result.sessions.some(s => s.file === "s2.md"), "index: ours session preserved");
  t.assert(result.sessions.some(s => s.file === "s3.md"), "index: theirs session added");
  t.assert(result.updated === "2026-03-01", "index: latest updated wins");
  // Sorted by date
  t.assert(result.sessions[0].date <= result.sessions[1].date, "index: sessions sorted by date");
}

t.section("mergeJsonFile - invalid inputs");

{
  const result = mergeJsonFile("metrics.json", null, "not json", "{}");
  t.assert(result === null, "mergeJsonFile returns null on invalid ours JSON");
}

{
  // Merge that would produce invalid schema
  const result = mergeJsonFile("index.json", null, '{"sessions": "not-array"}', '{"sessions": []}');
  t.assert(result === null, "mergeJsonFile returns null when schema validation fails");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7.6: Self-heal (cleanupOrphanedTmpFiles) + batchWriteFiles
// ═══════════════════════════════════════════════════════════════════════════════

t.section("cleanupOrphanedTmpFiles");

{
  // Use BRAIN_PATH (resolved at module load) for .tmp file creation
  const bp = BRAIN_PATH.replace(/\//g, path.sep);
  fs.mkdirSync(path.join(bp, "memory", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(bp, "knowledge", "general"), { recursive: true });
  fs.writeFileSync(path.join(bp, "orphan1.json.tmp"), "partial write");
  fs.writeFileSync(path.join(bp, "memory", "sessions", "orphan2.md.tmp"), "partial session");
  fs.writeFileSync(path.join(bp, "knowledge", "general", "orphan3.md.tmp"), "partial knowledge");

  const cleaned = cleanupOrphanedTmpFiles();
  t.assert(cleaned >= 3, `Cleaned >= 3 orphaned .tmp files (got ${cleaned})`);
  t.assert(!fs.existsSync(path.join(bp, "orphan1.json.tmp")), "orphan1 removed");
  t.assert(!fs.existsSync(path.join(bp, "memory", "sessions", "orphan2.md.tmp")), "orphan2 removed");
  t.assert(!fs.existsSync(path.join(bp, "knowledge", "general", "orphan3.md.tmp")), "orphan3 removed");
}

{
  // Second call with no .tmp files
  const cleaned2 = cleanupOrphanedTmpFiles();
  t.assert(cleaned2 === 0, "No orphans to clean on second run");
}

t.section("batchWriteFiles");

{
  batchWriteFiles([
    { path: "batch-test-1.txt", content: "file one" },
    { path: "batch-test-2.txt", content: "file two" },
    { path: "deep/batch/file3.md", content: "nested file" }
  ]);
  t.assert(readFile("batch-test-1.txt") === "file one", "batch: file 1 written");
  t.assert(readFile("batch-test-2.txt") === "file two", "batch: file 2 written");
  t.assert(readFile("deep/batch/file3.md") === "nested file", "batch: nested file written");
  // No .tmp files left
  t.assert(!fs.existsSync(path.join(tmpDir, "batch-test-1.txt.tmp")), "batch: no .tmp left for file 1");
  t.assert(!fs.existsSync(path.join(tmpDir, "batch-test-2.txt.tmp")), "batch: no .tmp left for file 2");
}

{
  // Path traversal in batch should throw
  let threw = false;
  try {
    batchWriteFiles([
      { path: "safe.txt", content: "ok" },
      { path: "../../evil.txt", content: "pwned" }
    ]);
  } catch (e) {
    threw = true;
    t.assert(e.message.includes("Path traversal"), "batch: error mentions path traversal");
  }
  t.assert(threw, "batchWriteFiles throws on path traversal");
  // safe.txt should NOT exist (batch rolled back .tmp files)
  t.assert(!fs.existsSync(path.join(tmpDir, "safe.txt.tmp")), "batch: .tmp cleaned up on failure");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7.9: Helpers tests
// ═══════════════════════════════════════════════════════════════════════════════

t.section("readProjectFile + serializeProject");

{
  writeFile("memory/projects/test-project.md", `---
name: test-project
status: active
tags: [brain, mcp]
---

## Architecture
Single index.js file with modules.

## Decisions
Keep it simple.
`);

  const parsed = readProjectFile("test-project");
  t.assert(parsed !== null, "readProjectFile parses project file");
  t.assert(parsed.frontmatter.name === "test-project", "frontmatter: name parsed");
  t.assert(parsed.frontmatter.status === "active", "frontmatter: status parsed");
  t.assert(Array.isArray(parsed.frontmatter.tags), "frontmatter: tags is array");
  t.assert(parsed.frontmatter.tags.includes("brain"), "frontmatter: tags contains brain");
  t.assert(parsed.sections["Architecture"], "sections: Architecture found");
  t.assert(parsed.sections["Architecture"].includes("Single index.js"), "sections: Architecture content");
  t.assert(parsed.sections["Decisions"], "sections: Decisions found");

  // Roundtrip
  const serialized = serializeProject(parsed);
  t.assert(serialized.includes("name: test-project"), "serialize: name present");
  t.assert(serialized.includes("## Architecture"), "serialize: Architecture section");
  t.assert(serialized.includes("## Decisions"), "serialize: Decisions section");

  // Re-parse serialized
  writeFile("memory/projects/roundtrip.md", serialized);
  const reparsed = readProjectFile("roundtrip");
  t.assert(reparsed.frontmatter.name === "test-project", "roundtrip: name preserved");
  t.assert(reparsed.sections["Architecture"], "roundtrip: Architecture preserved");
}

{
  t.assert(readProjectFile("nonexistent") === null, "readProjectFile returns null for missing");
}

t.section("getRecentSessions");

{
  invalidateAllContentCaches();
  writeFile("memory/sessions/2026-03-10_proj-a.md", "# Session: 2026-03-10\nContent A");
  writeFile("memory/sessions/2026-03-11_proj-b.md", "# Session: 2026-03-11\nContent B");
  writeFile("memory/sessions/2026-03-12_proj-c.md", "# Session: 2026-03-12\nContent C");

  const recent = getRecentSessions(2);
  t.assert(recent.length === 2, `getRecentSessions(2) returns 2 (got ${recent.length})`);
  t.assert(recent[0].file.includes("2026-03-12"), "Most recent first");
  t.assert(recent[1].file.includes("2026-03-11"), "Second most recent second");
}

t.section("getSessionsByProject");

{
  const projSessions = getSessionsByProject("proj-b");
  t.assert(projSessions.length >= 1, "getSessionsByProject finds matching sessions");
  t.assert(projSessions[0].file.includes("proj-b"), "Correct project session found");

  const none = getSessionsByProject("nonexistent-project-xyz");
  t.assert(none.length === 0, "getSessionsByProject returns empty for no matches");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7.10: Search pagination
// ═══════════════════════════════════════════════════════════════════════════════

t.section("Search pagination");

{
  invalidateAllContentCaches();
  invalidateJsonCache();

  // Create multiple learnings for pagination test
  for (let i = 1; i <= 5; i++) {
    writeFile(`memory/learnings/pagination-test-${i}.md`, `---
title: "Pagination test ${i}"
headline: "Docker deployment pattern ${i}"
type: learning
created: 2026-03-01
tags: [docker, pagination]
slug: pagination-test-${i}
---

Docker deployment pattern number ${i}.

#docker #pagination`);
  }

  // Rebuild SQLite index so learnings are searchable
  rebuildFullIndex();
  invalidateAllContentCaches();

  // Search without pagination
  const all = await scoredSearch("docker pagination");
  const totalL = all.learnings.length;
  t.assert(totalL >= 5, `Found >= 5 learnings without pagination (got ${totalL})`);

  // Search with limit
  const page1 = await scoredSearch("docker pagination", "all", null, false, { limit: 2, offset: 0 });
  t.assert(page1.learnings.length === 2, `Page 1: limit=2 returns 2 (got ${page1.learnings.length})`);
  t.assert(page1.pagination, "Pagination metadata present");
  t.assert(page1.pagination.limit === 2, "Pagination: limit=2");
  t.assert(page1.pagination.offset === 0, "Pagination: offset=0");
  t.assert(page1.pagination.totalLearnings >= 5, `Pagination: totalLearnings >= 5 (got ${page1.pagination.totalLearnings})`);

  // Page 2
  const page2 = await scoredSearch("docker pagination", "all", null, false, { limit: 2, offset: 2 });
  t.assert(page2.learnings.length === 2, `Page 2: returns 2 (got ${page2.learnings.length})`);
  // Different results than page 1
  const p1Slugs = new Set(page1.learnings.map(l => l.slug));
  const p2Slugs = new Set(page2.learnings.map(l => l.slug));
  let overlap = 0;
  for (const s of p2Slugs) { if (p1Slugs.has(s)) overlap++; }
  t.assert(overlap === 0, "Page 2 has different results than page 1");

  // Beyond results
  const pageBeyond = await scoredSearch("docker pagination", "all", null, false, { limit: 2, offset: 100 });
  t.assert(pageBeyond.learnings.length === 0, "Offset beyond results returns empty");
  t.assert(pageBeyond.pagination.totalLearnings >= 5, "Total still reported correctly");

  // No pagination (limit=0)
  const noPag = await scoredSearch("docker pagination", "all", null, false, { limit: 0, offset: 0 });
  t.assert(!noPag.pagination, "No pagination metadata when limit=0");
  t.assert(noPag.learnings.length >= 5, "All results returned without limit");
}

// ─── gitExec string rejection ────────────────────────────────────────────────

t.section("gitExec string rejection");

{
  const { gitExec } = await import("../git-sync.js");
  let threw = false;
  try { gitExec("status --porcelain"); } catch (e) {
    threw = true;
    t.assert(e.message.includes("array"), "gitExec error mentions array requirement");
  }
  t.assert(threw, "gitExec throws on string argument");
}

// ═══════════════════════════════════════════════════════════════════════════════
// findSimilarProject — duplicate detection
// ═══════════════════════════════════════════════════════════════════════════════

t.section("findSimilarProject");

{
  // Setup: create project files that mirror the real duplicates
  invalidateAllContentCaches();
  const projDir = path.join(BRAIN_PATH, "memory", "projects");

  writeFile("memory/projects/bi-azt-adp-binary-engine.md", `---
title: bi-azt-adp-binary-engine
status: active
tags: [scala, spark, cobol, parquet, binary, allianz, azes]
---

## What
Motor de conversió de fitxers binaris COBOL a Parquet.
`);

  writeFile("memory/projects/rap-actuarial-platform.md", `---
title: rap-actuarial-platform
status: active
tags: [rap, actuarial, pyspark, synapse, azes, azpt]
---

## What
Pipeline PySpark que genera triangles actuarials.
`);

  writeFile("memory/projects/dynatrace-observability.md", `---
title: dynatrace-observability
status: active
tags: [dynatrace, observability, dql, giam, allianz]
---

## What
Accés i monitorització de logs Dynatrace.
`);

  writeFile("memory/projects/laia-local-brain.md", `---
title: laia-local-brain
status: active
tags: [mcp, memory, brain, claude-code]
---

## What
MCP server for persistent memory.
`);

  // ── Test 1: "binary-engine" should be blocked by "bi-azt-adp-binary-engine" (substring)
  const r1 = findSimilarProject("binary-engine", ["cobol", "binary"]);
  t.assert(r1 !== null, "binary-engine: finds similar project");
  t.assert(r1.level === "block", `binary-engine: blocks (got ${r1?.level})`);
  t.assert(r1.slug === "bi-azt-adp-binary-engine", `binary-engine: matches bi-azt-adp-binary-engine (got ${r1?.slug})`);
  t.assert(r1.isSubstring === true, "binary-engine: detected as substring");

  // ── Test 2: "dynatrace-giam-observability" should be blocked by "dynatrace-observability" (substring)
  const r2 = findSimilarProject("dynatrace-giam-observability", ["dynatrace", "giam"]);
  t.assert(r2 !== null, "dynatrace-giam-observability: finds similar project");
  t.assert(r2.level === "block", `dynatrace-giam-observability: blocks (got ${r2?.level})`);
  t.assert(r2.slug === "dynatrace-observability", `dynatrace-giam-observability: matches dynatrace-observability (got ${r2?.slug})`);

  // ── Test 3: "adp-workspace-rap" should warn or block due to high tag overlap with rap-actuarial-platform
  const r3 = findSimilarProject("adp-workspace-rap", ["rap", "actuarial", "synapse", "azpt", "azes"]);
  t.assert(r3 !== null, "adp-workspace-rap: finds similar project");
  t.assert(r3.level === "block" || r3.level === "warn", `adp-workspace-rap: warns or blocks (got ${r3?.level})`);
  t.assert(r3.slug === "rap-actuarial-platform", `adp-workspace-rap: matches rap-actuarial-platform (got ${r3?.slug})`);

  // ── Test 4: Exact same slug should NOT trigger (it's updating, not creating)
  const r4 = findSimilarProject("bi-azt-adp-binary-engine", ["scala"]);
  t.assert(r4 === null, "exact slug match returns null (same project, OK)");

  // ── Test 5: Completely unrelated project should return null
  const r5 = findSimilarProject("terraform-infra-prod", ["terraform", "aws", "iac"]);
  t.assert(r5 === null, `unrelated project returns null (got ${JSON.stringify(r5)})`);

  // ── Test 6: "laia-brain" should be blocked by "laia-local-brain" (substring)
  const r6 = findSimilarProject("laia-brain", ["mcp", "memory"]);
  t.assert(r6 !== null, "laia-brain: finds similar project");
  t.assert(r6.level === "block", `laia-brain: blocks (got ${r6?.level})`);
  t.assert(r6.slug === "laia-local-brain", `laia-brain: matches laia-local-brain (got ${r6?.slug})`);

  // ── Test 7: High Jaccard without substring — e.g. "binary-cobol-engine" vs "bi-azt-adp-binary-engine"
  const r7 = findSimilarProject("binary-cobol-engine", ["scala", "cobol"]);
  t.assert(r7 !== null, "binary-cobol-engine: finds similar (shared tokens: binary, engine)");
  t.assert(r7.slug === "bi-azt-adp-binary-engine", `binary-cobol-engine: matches bi-azt-adp-binary-engine (got ${r7?.slug})`);

  // ── Test 8: No projects directory → graceful null
  const origBP = process.env.LAIA_BRAIN_PATH;
  process.env.LAIA_BRAIN_PATH = "/nonexistent/path";
  // Need to reimport or use a fresh call — but since findSimilarProject reads BRAIN_PATH from config,
  // we test the catch path by temporarily removing the dir
  // (skip this — BRAIN_PATH is read at import time)
  process.env.LAIA_BRAIN_PATH = origBP;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* may not exist if BRAIN_PATH differs */ }
try {
  const bp = BRAIN_PATH.replace(/\//g, path.sep);
  if (bp !== tmpDir) fs.rmSync(bp, { recursive: true, force: true });
} catch { /* best effort */ }

export const results = t.summary();
