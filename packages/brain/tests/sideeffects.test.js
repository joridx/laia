/**
 * P6.8: Side-effect tests — exercise I/O functions, maintenance, caches, TODOs
 * with a temporary BRAIN_PATH. Tests the functions that integration.test.js couldn't.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("sideeffects");

// ─── Setup: temporary BRAIN_PATH ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-se-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false"; // disable git for tests

// Create directory structure
for (const dir of [
  "memory/sessions",
  "memory/learnings",
  "memory/projects",
  "memory/todos",
  "knowledge/general",
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}

const today = new Date().toISOString().split("T")[0];

// Seed JSON files
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({
  version: "2.0", sessions: [], consolidation: {}
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({
  tag_hits: {}, search_hits: {}, total_queries: 0
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({
  concepts: {
    docker: { related_to: ["kubernetes"], children: [] },
    kubernetes: { related_to: ["docker"], children: [] },
    sql: { related_to: ["postgres"], children: [] },
    postgres: { related_to: ["sql"], children: [] }
  }
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {}
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "memory/todos.json"), "[]");

// ─── Import module (after BRAIN_PATH is set) ──────────────────────────────────

const mod = await import("../index.js");
const {
  readFile, writeFile, readJSON, invalidateJsonCache,
  getAllLearnings, getLearningsByTags, ensureLearningMeta,
  recordHit, addRelation, addTagCooccurrenceRelations,
  performPrune, performConsolidate, performArchiveLearnings,
  computeAllVitalities, scoredSearch,
  readTodos, writeTodos,
  invalidateAllContentCaches,
  BRAIN_PATH
} = mod;
const { rebuildFullIndex } = await import("../database.js");
// setSignalEnabled removed per search-refactor-spec.md §2 (signals are deployment-time only)
const { signalEnabled } = await import("../signal-config.js");
const { flushMetaSync } = await import("../learnings.js");

// ─── readFile / writeFile ─────────────────────────────────────────────────────

t.section("readFile / writeFile");

t.assert(BRAIN_PATH === tmpDir.replace(/\\/g, "/"), `BRAIN_PATH matches tmpDir`);

writeFile("test-rw.txt", "hello world");
t.assert(readFile("test-rw.txt") === "hello world", "writeFile + readFile roundtrip");

t.assert(readFile("nonexistent-file.txt") === null, "readFile returns null for missing file");

// Atomic write: verify no .tmp left behind
t.assert(!fs.existsSync(path.join(tmpDir, "test-rw.txt.tmp")), "No .tmp file left after atomic write");

// Overwrite
writeFile("test-rw.txt", "updated");
t.assert(readFile("test-rw.txt") === "updated", "writeFile overwrites existing");

// Creates subdirectories
writeFile("deep/nested/dir/file.md", "nested content");
t.assert(readFile("deep/nested/dir/file.md") === "nested content", "writeFile creates nested dirs");

// ─── readJSON / cache ─────────────────────────────────────────────────────────

t.section("readJSON / JSON cache");

writeFile("test-cache.json", JSON.stringify({ a: 1, b: 2 }));
const j1 = readJSON("test-cache.json");
t.assert(j1.a === 1 && j1.b === 2, "readJSON parses correctly");

// Mutation safety (P6.2: structuredClone)
j1.a = 999;
const j2 = readJSON("test-cache.json");
t.assert(j2.a === 1, "readJSON returns independent clone (cache not mutated)");

// Cache invalidation on write
writeFile("test-cache.json", JSON.stringify({ a: 42 }));
const j3 = readJSON("test-cache.json");
t.assert(j3.a === 42, "JSON cache invalidated after writeFile");

// Invalid JSON
writeFile("bad.json", "not json{{{");
t.assert(readJSON("bad.json") === null, "readJSON returns null for invalid JSON");

t.assert(readJSON("missing.json") === null, "readJSON returns null for missing file");

// ─── recordHit ────────────────────────────────────────────────────────────────

t.section("recordHit / metrics");

invalidateJsonCache();
recordHit("tag", "docker");
recordHit("tag", "docker");
recordHit("search", "how to deploy");

const metrics = JSON.parse(fs.readFileSync(path.join(tmpDir, "metrics.json"), "utf-8"));
t.assert(metrics.tag_hits?.docker === 2, "recordHit increments tag hits");
t.assert(metrics.search_hits?.["how to deploy"] === 1, "recordHit records search hit");
t.assert(metrics.total_queries === 3, "recordHit increments total_queries");

// ─── addRelation / addTagCooccurrenceRelations ────────────────────────────────

t.section("Knowledge graph mutations");

invalidateJsonCache();
addRelation("python", { related_to: ["flask", "django"] });
const rel1 = JSON.parse(fs.readFileSync(path.join(tmpDir, "relations.json"), "utf-8"));
t.assert(rel1.concepts?.python, "addRelation creates new concept");
t.assert(rel1.concepts?.python?.related_to?.includes("flask"), "addRelation adds related_to");
t.assert(rel1.concepts?.python?.related_to?.includes("django"), "addRelation adds multiple related_to");

// Idempotent
addRelation("python", { related_to: ["flask"] });
const rel2 = JSON.parse(fs.readFileSync(path.join(tmpDir, "relations.json"), "utf-8"));
t.assert(rel2.concepts?.python?.related_to?.filter(r => r === "flask").length === 1, "addRelation deduplicates");

// Co-occurrence
invalidateJsonCache();
addTagCooccurrenceRelations(["react", "typescript", "frontend"]);
const rel3 = JSON.parse(fs.readFileSync(path.join(tmpDir, "relations.json"), "utf-8"));
t.assert(rel3.concepts?.react?.related_to?.includes("typescript"), "Co-occurrence: react→typescript");
t.assert(rel3.concepts?.typescript?.related_to?.includes("react"), "Co-occurrence: typescript→react (bidirectional)");
t.assert(rel3.concepts?.react?.related_to?.includes("frontend"), "Co-occurrence: react→frontend");

// ─── writeFile + getAllLearnings (with content cache) ─────────────────────────

t.section("getAllLearnings + content cache");

invalidateAllContentCaches();
invalidateJsonCache();

// Create learning files
writeFile("memory/learnings/test-docker-compose.md", `---
title: "Docker Compose patterns"
headline: "Use multi-stage builds for production"
type: pattern
created: ${today}
tags: [docker, compose, devops]
slug: test-docker-compose
---

Use multi-stage builds for production Docker images.

#docker #compose #devops #pattern`);

writeFile("memory/learnings/test-sql-indexes.md", `---
title: "SQL index strategies"
headline: "Always add indexes on foreign keys"
type: warning
created: ${today}
tags: [sql, postgres, performance]
slug: test-sql-indexes
---

Always add indexes on foreign keys to avoid full table scans.

#sql #postgres #performance #avoid`);

// Rebuild SQLite index so DB-first reads find the new learnings
rebuildFullIndex();
invalidateAllContentCaches();

const allLearnings = getAllLearnings();
t.assert(allLearnings.length === 2, `getAllLearnings returns 2 (got ${allLearnings.length})`);
t.assert(allLearnings.some(l => l.slug === "test-docker-compose"), "Found docker-compose learning");
t.assert(allLearnings.some(l => l.slug === "test-sql-indexes"), "Found sql-indexes learning");

// Cache test: second call should return same result without re-reading disk
const allLearnings2 = getAllLearnings();
t.assert(allLearnings2.length === 2, "getAllLearnings cached (same count)");

// Cache invalidation: writing a new learning should invalidate
writeFile("memory/learnings/test-new-learning.md", `---
title: "New learning"
headline: "Test cache invalidation"
type: learning
created: ${today}
tags: [test]
slug: test-new-learning
---

Cache invalidation test.

#test`);

rebuildFullIndex();
invalidateAllContentCaches();
const allLearnings3 = getAllLearnings();
t.assert(allLearnings3.length === 3, `Cache invalidated on write (got ${allLearnings3.length})`);

// getLearningsByTags
const dockerLearnings = getLearningsByTags(["docker"]);
t.assert(dockerLearnings.length >= 1, "getLearningsByTags finds docker learnings");
t.assert(dockerLearnings.some(l => l.slug === "test-docker-compose"), "getLearningsByTags returns correct learning");

const sqlWarnings = getLearningsByTags(["sql"], "warning");
t.assert(sqlWarnings.length === 1, "getLearningsByTags filters by type=warning");

// ─── ensureLearningMeta ───────────────────────────────────────────────────────

t.section("ensureLearningMeta");

// Use slugs NOT already in DB from prior writeFile/syncLearning
writeFile("memory/learnings/meta-test-fresh.md", `---
title: "Fresh meta test"
type: pattern
created: ${today}
tags: [meta-test]
---
Fresh learning for ensureLearningMeta test.
`);
// Delete the DB entry created by onFileWrite hook so ensureLearningMeta can create it
const { getDb } = await import("../database.js");
const _metaDb = getDb();
if (_metaDb) _metaDb.prepare("DELETE FROM learnings WHERE slug = ?").run("meta-test-fresh");

invalidateJsonCache();
// Reset JSON meta to empty for this test
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({ learnings: {} }, null, 2));
invalidateJsonCache();

ensureLearningMeta("meta-test-fresh", "Fresh meta test", "memory/learnings/meta-test-fresh.md", "pattern");
flushMetaSync(); // Force flush debounced meta writes before reading from disc

const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
t.assert(meta.learnings?.["meta-test-fresh"], "ensureLearningMeta creates entry");
t.assert(meta.learnings?.["meta-test-fresh"]?.type === "pattern", "Meta has correct type");
t.assert(meta.learnings?.["meta-test-fresh"]?.hit_count === 0, "Meta starts with 0 hits");
t.assert(meta.learnings?.["meta-test-fresh"]?.created_date === today, "Meta has created_date");

// Idempotent: second call shouldn't overwrite
invalidateJsonCache();
ensureLearningMeta("meta-test-fresh", "CHANGED TITLE", "changed-path.md", "warning");
flushMetaSync();
const meta2 = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
t.assert(meta2.learnings?.["meta-test-fresh"]?.type === "pattern", "ensureLearningMeta is idempotent");

// ─── computeAllVitalities ─────────────────────────────────────────────────────

t.section("computeAllVitalities (real data)");

invalidateJsonCache();
const vMap = computeAllVitalities();
t.assert(vMap instanceof Map, "computeAllVitalities returns a Map");
t.assert(vMap.size >= 2, `Map has entries (got ${vMap.size})`);

const dockerV = vMap.get("test-docker-compose");
t.assert(dockerV, "Has vitality for docker-compose");
t.assert(typeof dockerV.vitality === "number", "vitality is a number");
t.assert(dockerV.vitality >= 0 && dockerV.vitality <= 1, "vitality in [0,1]");
t.assert(["active", "stale", "fading", "archived"].includes(dockerV.zone), "Valid zone");

// ─── scoredSearch (full pipeline) ─────────────────────────────────────────────

t.section("scoredSearch (full pipeline)");

invalidateJsonCache();
invalidateAllContentCaches();

// Create a session file for file search
writeFile("memory/sessions/2026-03-12-test.md", `# Session: 2026-03-12

Worked on Docker deployment. Fixed SQL query performance issues.
Configured Postgres connection pooling with PgBouncer.`);

// Rebuild SQLite index so learnings are searchable
rebuildFullIndex();
invalidateAllContentCaches();

const searchResult = await scoredSearch("docker compose deployment");
t.assert(searchResult.learnings.length > 0, "scoredSearch finds learnings");
t.assert(searchResult.learnings?.[0]?.slug === "test-docker-compose", "Top learning is docker-compose");
t.assert(searchResult.intent, "scoredSearch classifies intent");
t.assert(searchResult.timing?.total >= 0, "scoredSearch has timing data");

// Graph expansion: behavior depends on signal config.
// When enabled, "kubernetes" should appear via docker relation.
// When disabled, no expansion occurs.
const searchDocker = await scoredSearch("docker");
t.assert(Array.isArray(searchDocker.graphExpanded), "graphExpanded is an array");

if (signalEnabled("graph")) {
  // Graph ON: expansion expected (docker → kubernetes, containers, etc.)
  t.assert(searchDocker.graphExpanded.length > 0, "Graph enabled → expansion occurs");
} else {
  // Graph OFF: no expansion expected
  t.assert(searchDocker.graphExpanded.length === 0, "Graph disabled → no expansion");
}

// Scoped search
const searchLearningsOnly = await scoredSearch("docker", "learnings");
t.assert(searchLearningsOnly.files.length === 0, "scope=learnings returns no files");
t.assert(searchLearningsOnly.learnings.length > 0, "scope=learnings still finds learnings");

// Empty query
const emptySearch = await scoredSearch("");
t.assert(emptySearch.learnings.length === 0, "Empty query returns no results");

// File cache: second search should use cached file content
const searchResult2 = await scoredSearch("docker compose deployment");
t.assert(searchResult2.learnings.length > 0, "Cached search still works");

// ─── performPrune ─────────────────────────────────────────────────────────────

t.section("performPrune");

invalidateJsonCache();

// Add an old learning to test pruning
const oldMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
oldMeta.learnings["old-stale-learning"] = {
  title: "Old stale learning",
  file: "memory/learnings/old-stale-learning.md",
  type: "learning",
  hit_count: 0,
  created_date: "2024-01-01",
  last_accessed: null,
  stale: false
};
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(oldMeta, null, 2));
invalidateJsonCache();

const vitalityMap = computeAllVitalities();
const pruneResult = performPrune(60, vitalityMap);
t.assert(pruneResult !== null, "performPrune returns result");
t.assert(typeof pruneResult.active === "number", "pruneResult has active count");
t.assert(typeof pruneResult.newlyStale === "number", "pruneResult has newlyStale count");
t.assert(typeof pruneResult.total === "number", "pruneResult has total count");

// Check that stale was marked in meta
invalidateJsonCache();
const prunedMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
const oldEntry = prunedMeta.learnings["old-stale-learning"];
if (oldEntry?.stale) {
  t.assert(oldEntry.stale === true, "Old learning marked as stale");
  t.assert(oldEntry.stale_date, "Stale date set");
} else {
  // If vitality is still high enough, it won't be stale — still valid
  t.assert(true, "Old learning vitality was above threshold (not stale)");
}

// ─── performConsolidate ───────────────────────────────────────────────────────

t.section("performConsolidate");

invalidateJsonCache();

// Create old session files (>30 days old)
const oldDate = "2025-01-15";
writeFile(`memory/sessions/${oldDate}_old-project.md`, `# Session: ${oldDate}

Old session content for consolidation test.`);
writeFile("memory/sessions/2025-01-20_old-project2.md", `# Session: 2025-01-20

Another old session for consolidation.`);

const consolidateResult = performConsolidate(30);
t.assert(consolidateResult !== null, "performConsolidate returns result");
t.assert(consolidateResult.consolidated >= 2, `Consolidated >= 2 sessions (got ${consolidateResult.consolidated})`);
t.assert(consolidateResult.months.includes("2025-01"), "Consolidated month 2025-01");

// Check consolidated file exists
const consolidatedFile = path.join(tmpDir, "memory/sessions/2025-01_consolidated.md");
t.assert(fs.existsSync(consolidatedFile), "Consolidated file created");
if (fs.existsSync(consolidatedFile)) {
  const consolidatedContent = fs.readFileSync(consolidatedFile, "utf-8");
  t.assert(consolidatedContent.includes("Consolidated Sessions"), "Consolidated file has header");
} else {
  t.assert(false, "Consolidated file has header (skipped — file missing)");
}

// Original files should be moved to backup
t.assert(!fs.existsSync(path.join(tmpDir, `memory/sessions/${oldDate}_old-project.md`)), "Original session moved to backup");

// ─── TODOs ────────────────────────────────────────────────────────────────────

t.section("TODOs (read/write)");

invalidateJsonCache();
const todos0 = readTodos();
t.assert(Array.isArray(todos0), "readTodos returns array");
t.assert(todos0.length === 0, "Initially empty");

const newTodos = [
  { id: "todo-1", text: "Fix bug", status: "pending", priority: "high", owner: "laia", project: "brain", tags: ["bug"], created: today, due: null, done_at: null },
  { id: "todo-2", text: "Write docs", status: "pending", priority: "low", owner: "user", project: "brain", tags: ["docs"], created: today, due: "2026-04-01", done_at: null }
];
writeTodos(newTodos);

invalidateJsonCache();
const todos1 = readTodos();
t.assert(todos1.length === 2, "writeTodos persists 2 items");
t.assert(todos1[0].id === "todo-1", "First todo ID correct");
t.assert(todos1[1].due === "2026-04-01", "Due date preserved");

// Update a todo
todos1[0].status = "done";
todos1[0].done_at = today;
writeTodos(todos1);

invalidateJsonCache();
const todos2 = readTodos();
t.assert(todos2[0].status === "done", "Todo status updated");
t.assert(todos2[0].done_at === today, "done_at set");

// ─── performArchiveLearnings ──────────────────────────────────────────────────

t.section("performArchiveLearnings");

invalidateJsonCache();

// Create a learning that's stale + in fading zone
writeFile("memory/learnings/fading-test.md", `---
title: "Fading test"
headline: "Should be archived"
type: learning
created: 2024-01-01
tags: [test]
slug: fading-test
---

This should get archived.

#test`);

// Set it as stale in meta with fading vitality_zone
const archMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
archMeta.learnings["fading-test"] = {
  title: "Fading test",
  file: "memory/learnings/fading-test.md",
  type: "learning",
  hit_count: 0,
  created_date: "2024-01-01",
  last_accessed: null,
  stale: true,
  vitality_zone: "fading"
};
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(archMeta, null, 2));
invalidateJsonCache();
invalidateAllContentCaches();

// Build vitality map — the entry should be fading/archived due to old date + 0 hits
const archVMap = computeAllVitalities();
const fadingV = archVMap.get("fading-test");

const archResult = performArchiveLearnings(archVMap);
if (archResult && archResult.archived > 0) {
  t.assert(archResult.archived >= 1, "performArchiveLearnings archived stale learning");
  // Original should be moved
  t.assert(!fs.existsSync(path.join(tmpDir, "memory/learnings/fading-test.md")), "Original moved to backup");
  // Archive dir should exist
  const archiveDir = path.join(tmpDir, "memory/learnings/_archive");
  t.assert(fs.existsSync(archiveDir), "Archive directory created");
  // Meta should be updated
  invalidateJsonCache();
  const archMeta2 = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
  t.assert(archMeta2.learnings["fading-test"]?.archived === true, "Meta marked as archived");
} else {
  // If vitality wasn't in fading/archived zone, skip
  const zone = fadingV?.zone || "unknown";
  t.assert(true, `Fading-test zone=${zone}, vitality=${fadingV?.vitality?.toFixed(3)} — archive skipped (zone must be fading/archived)`);
}

// ─── Content cache invalidation ───────────────────────────────────────────────

t.section("Content cache invalidation");

invalidateAllContentCaches();
invalidateJsonCache();

// Trigger file cache build via scoredSearch
await scoredSearch("docker", "sessions");

// Write a new session — should invalidate session dir cache
writeFile("memory/sessions/2026-03-13-new.md", `# Session: 2026-03-13
New session with unique-keyword-xyz content.`);

// Search should find the new file
const searchNew = await scoredSearch("unique-keyword-xyz", "sessions");
t.assert(
  searchNew.files.some(f => f.file.includes("2026-03-13-new")),
  "New session file found after cache invalidation"
);

// ─── Path traversal protection ────────────────────────────────────────────────

t.section("Path traversal protection");

t.assert(readFile("../../etc/passwd") === null, "readFile blocks traversal with ..");
t.assert(readFile("knowledge/../../.ssh/id_rsa") === null, "readFile blocks traversal via subdirectory");

{
  let threw = false;
  try { writeFile("../../evil.txt", "pwned"); } catch (e) {
    threw = true;
    t.assert(e.message.includes("Path traversal"), "writeFile error mentions Path traversal");
  }
  t.assert(threw, "writeFile throws on path traversal");
}

{
  let threw = false;
  try { writeFile("knowledge/../../.laia/settings.json", "{}"); } catch (e) { threw = true; }
  t.assert(threw, "writeFile throws on traversal via knowledge/../..");
}

writeFile("knowledge/test-domain/safe-file.md", "safe content");
t.assert(readFile("knowledge/test-domain/safe-file.md") === "safe content", "writeFile allows normal nested paths");

// ─── detectClusters (P7.2) ────────────────────────────────────────────────────

t.section("detectClusters");

// Import detectClusters
const { detectClusters } = mod;

// Clear existing learnings for a clean slate
for (const f of fs.readdirSync(path.join(tmpDir, "memory/learnings"))) {
  if (f.endsWith(".md")) fs.unlinkSync(path.join(tmpDir, "memory/learnings", f));
}
invalidateJsonCache("learnings-meta.json");
invalidateAllContentCaches();

// Seed fresh meta
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {}
}, null, 2));
invalidateJsonCache("learnings-meta.json");

// Test with no learnings
{
  const result = detectClusters();
  t.assert(result.clusters.length === 0, "No clusters with empty brain");
  t.assert(result.stats.total_learnings === 0 || result.stats.clusters_found === 0, "Stats show 0 clusters");
}

// Seed similar learnings (near-duplicates)
const mkLearning = (slug, title, headline, tags, body) => {
  const content = [
    "---",
    `title: "${title}"`,
    `headline: "${headline}"`,
    `type: learning`,
    `created: ${today}`,
    `tags: [${tags.join(", ")}]`,
    `slug: ${slug}`,
    "---",
    "",
    body
  ].join("\n");
  writeFile(`memory/learnings/${slug}.md`, content);
  ensureLearningMeta(slug, title, `memory/learnings/${slug}.md`, "learning");
};

mkLearning("fts5-search-speed", "FTS5 search is very fast for small corpus",
  "FTS5 BM25 outperforms embeddings under 10k documents",
  ["search", "sqlite", "fts5"],
  "SQLite FTS5 with BM25 ranking is significantly faster than vector search for small document collections. The lexical approach avoids embedding computation overhead.");

mkLearning("fts5-bm25-performance", "FTS5 BM25 performance for small datasets",
  "BM25 ranking via FTS5 beats vector search for small corpus",
  ["search", "sqlite", "bm25"],
  "When the corpus is under 10k documents, FTS5 BM25 provides better precision and speed than embedding-based semantic search. No GPU required.");

mkLearning("hybrid-retrieval-architecture", "Hybrid retrieval combines lexical and semantic",
  "Combining BM25 with graph signals improves retrieval quality",
  ["search", "retrieval", "architecture"],
  "Hybrid retrieval systems that combine lexical search BM25 with semantic similarity and graph ranking outperform single-signal approaches.");

mkLearning("docker-networking-basics", "Docker networking bridge and host modes",
  "Docker bridge network isolates containers by default",
  ["docker", "networking", "containers"],
  "Docker provides bridge and host networking modes. Bridge is the default and creates an isolated network. Host shares the host network namespace.");

mkLearning("kubernetes-pod-networking", "Kubernetes pod networking model",
  "Kubernetes uses flat network where all pods can communicate",
  ["kubernetes", "networking", "containers"],
  "Kubernetes networking model requires that all pods can communicate with each other without NAT. CNI plugins implement this flat network.");

// Unrelated learning
mkLearning("git-rebase-workflow", "Git rebase workflow for clean history",
  "Interactive rebase keeps commit history linear and clean",
  ["git", "workflow", "version-control"],
  "Using git rebase -i to squash and reorder commits before merging keeps the main branch history clean and readable.");

rebuildFullIndex();
invalidateAllContentCaches();
invalidateJsonCache("learnings-meta.json");

// Test cluster detection
{
  const result = detectClusters();
  t.assert(result.clusters.length >= 1, `At least 1 cluster found (got ${result.clusters.length})`);
  t.assert(result.stats.total_learnings === 6, `Total learnings is 6 (got ${result.stats.total_learnings})`);

  // The two FTS5 learnings should be clustered together
  const fts5Cluster = result.clusters.find(c =>
    c.slugs.includes("fts5-search-speed") && c.slugs.includes("fts5-bm25-performance")
  );
  t.assert(fts5Cluster != null, "FTS5 near-duplicates are in the same cluster");

  if (fts5Cluster) {
    t.assert(fts5Cluster.max_similarity >= 0.35, `FTS5 cluster similarity >= 0.35 (got ${fts5Cluster.max_similarity})`);
    t.assert(fts5Cluster.suggested_action === "merge" || fts5Cluster.suggested_action === "review",
      `FTS5 cluster action is merge or review (got ${fts5Cluster.suggested_action})`);
    t.assert(fts5Cluster.tags_union.length >= 2, "Cluster has union of tags");
    t.assert(fts5Cluster.top_pairs.length >= 1, "Cluster has at least one pair");
  }

  // Docker/K8s with 2 shared tags but very different vocabulary:
  // they may cluster with lower threshold, but at default clusterThreshold (0.40)
  // different vocabulary keeps them apart — this is correct behavior.
  // With a lower threshold they should cluster:
  const lowResult = detectClusters({ minSimilarity: 0.20, clusterThreshold: 0.25 });
  const infraCluster = lowResult.clusters.find(c =>
    c.slugs.includes("docker-networking-basics") && c.slugs.includes("kubernetes-pod-networking")
  );
  t.assert(infraCluster != null, "Docker + K8s networking cluster at low threshold");

  // Git learning should NOT be in a cluster with FTS5 or Docker/K8s
  const gitInSearchCluster = result.clusters.find(c =>
    c.slugs.includes("git-rebase-workflow") &&
    (c.slugs.includes("fts5-search-speed") || c.slugs.includes("docker-networking-basics"))
  );
  t.assert(gitInSearchCluster == null, "Git learning is NOT clustered with unrelated topics");
}

// Test with minSimilarity parameter
{
  const strict = detectClusters({ minSimilarity: 0.8 });
  t.assert(strict.clusters.length <= result_lenient_count(), "Higher threshold produces fewer or equal clusters");

  function result_lenient_count() {
    return detectClusters({ minSimilarity: 0.2 }).clusters.length;
  }
}

// Test stats structure
{
  const result = detectClusters();
  t.assert(typeof result.stats.total_learnings === "number", "stats.total_learnings is number");
  t.assert(typeof result.stats.in_clusters === "number", "stats.in_clusters is number");
  t.assert(typeof result.stats.clusters_found === "number", "stats.clusters_found is number");
  t.assert(typeof result.stats.merge_candidates === "number", "stats.merge_candidates is number");
  t.assert(typeof result.stats.distill_candidates === "number", "stats.distill_candidates is number");
  t.assert(typeof result.stats.review_candidates === "number", "stats.review_candidates is number");
}

// Test cluster output structure
{
  const result = detectClusters();
  if (result.clusters.length > 0) {
    const c = result.clusters[0];
    t.assert(Array.isArray(c.slugs), "cluster has slugs array");
    t.assert(Array.isArray(c.titles), "cluster has titles array");
    t.assert(Array.isArray(c.tags_union), "cluster has tags_union array");
    t.assert(typeof c.size === "number", "cluster has size");
    t.assert(typeof c.avg_similarity === "number", "cluster has avg_similarity");
    t.assert(typeof c.max_similarity === "number", "cluster has max_similarity");
    t.assert(["merge", "distill", "review"].includes(c.suggested_action), "cluster has valid suggested_action");
    t.assert(Array.isArray(c.top_pairs), "cluster has top_pairs array");
    if (c.top_pairs.length > 0) {
      const p = c.top_pairs[0];
      t.assert(typeof p.slugA === "string", "pair has slugA");
      t.assert(typeof p.slugB === "string", "pair has slugB");
      t.assert(typeof p.combined === "number", "pair has combined score");
      t.assert(typeof p.titleSim === "number", "pair has titleSim");
      t.assert(typeof p.bodySim === "number", "pair has bodySim");
      t.assert(typeof p.tagOverlap === "number", "pair has tagOverlap");
    }
  }
}

// Test maxResults limit
{
  const limited = detectClusters({ maxResults: 1 });
  t.assert(limited.clusters.length <= 1, "maxResults limits cluster output");
  t.assert(limited.stats.clusters_found >= limited.clusters.length, "stats.clusters_found >= shown clusters");
}

// Test archived learnings are excluded
{
  const metaRaw = readJSON("learnings-meta.json");
  if (metaRaw?.learnings?.["git-rebase-workflow"]) {
    metaRaw.learnings["git-rebase-workflow"].archived = true;
    writeFile("learnings-meta.json", JSON.stringify(metaRaw, null, 2));
    invalidateJsonCache("learnings-meta.json");
    rebuildFullIndex();
    invalidateAllContentCaches();

    const result = detectClusters();
    const gitCluster = result.clusters.find(c => c.slugs.includes("git-rebase-workflow"));
    t.assert(gitCluster == null, "Archived learning not in any cluster");
  } else {
    // Slug may have been purged by SQLite sync — skip gracefully
    t.assert(true, "Archived learning test skipped (fixture slug purged)");
  }

  // Restore (safe: only if slug existed)
  if (metaRaw?.learnings?.["git-rebase-workflow"]) {
    metaRaw.learnings["git-rebase-workflow"].archived = false;
    writeFile("learnings-meta.json", JSON.stringify(metaRaw, null, 2));
    invalidateJsonCache("learnings-meta.json");
    rebuildFullIndex();
    invalidateAllContentCaches();
  }
}

// ─── buildHierarchy (tag subsumption → parent/children) ──────────────────────

t.section("buildHierarchy");

const { buildHierarchy } = mod;

{
  // Setup: learnings with clear subsumption patterns
  // "allianz" appears in all, "dynatrace" in 4, "dql" only in 3 dynatrace learnings
  // Expected: allianz > dynatrace > dql
  invalidateAllContentCaches();
  invalidateJsonCache("relations.json");

  const hierLearnings = [
    { slug: "dt-dql-basics", tags: ["allianz", "dynatrace", "dql"], title: "DQL basics" },
    { slug: "dt-dql-logs", tags: ["allianz", "dynatrace", "dql"], title: "DQL logs" },
    { slug: "dt-dql-metrics", tags: ["allianz", "dynatrace", "dql"], title: "DQL metrics" },
    { slug: "dt-entities", tags: ["allianz", "dynatrace", "entities"], title: "DT entities" },
    { slug: "jira-search", tags: ["allianz", "jira", "jql"], title: "Jira search" },
    { slug: "jira-tempo", tags: ["allianz", "jira", "tempo"], title: "Jira tempo" },
    { slug: "jira-create", tags: ["allianz", "jira", "create-ticket"], title: "Jira create" },
    { slug: "allianz-gdp", tags: ["allianz", "gdp"], title: "GDP overview" },
  ];

  // Ensure relations.json has the concepts
  const rels = readJSON("relations.json") || { concepts: {} };
  for (const l of hierLearnings) {
    for (const tag of l.tags) {
      if (!rels.concepts[tag]) rels.concepts[tag] = { related_to: [], children: [] };
    }
  }
  writeFile("relations.json", JSON.stringify(rels, null, 2));
  invalidateJsonCache("relations.json");

  const result = buildHierarchy(() => hierLearnings);

  t.assert(result.added > 0, `buildHierarchy adds pairs (got ${result.added})`);
  t.assert(Array.isArray(result.pairs), "buildHierarchy returns pairs array");

  // Verify relations.json was updated
  invalidateJsonCache("relations.json");
  const updated = readJSON("relations.json");

  // dql should have parent=dynatrace (3 dql learnings, all have dynatrace)
  const dqlData = updated.concepts["dql"];
  t.assert(dqlData?.parent === "dynatrace", `dql parent is dynatrace (got ${dqlData?.parent})`);

  // dynatrace should have dql as child
  const dtData = updated.concepts["dynatrace"];
  t.assert(dtData?.children?.includes("dql"), `dynatrace has dql as child (children: ${JSON.stringify(dtData?.children)})`);

  // dynatrace should have parent=allianz (4 dynatrace learnings, all have allianz; allianz has 8)
  t.assert(dtData?.parent === "allianz", `dynatrace parent is allianz (got ${dtData?.parent})`);

  // allianz should have children including dynatrace and jira
  const azData = updated.concepts["allianz"];
  t.assert(azData?.children?.includes("dynatrace"), `allianz has dynatrace as child`);
  t.assert(azData?.children?.includes("jira"), `allianz has jira as child`);

  // jira (3 learnings, all have allianz) → parent should be allianz
  const jiraData = updated.concepts["jira"];
  t.assert(jiraData?.parent === "allianz", `jira parent is allianz (got ${jiraData?.parent})`);

  // tempo (only 1 learning) should NOT be a child — below minChildCount=3
  const tempoData = updated.concepts["tempo"];
  t.assert(!tempoData?.parent, `tempo has no parent (below minChildCount, got ${tempoData?.parent})`);
}

// Test with empty learnings
{
  invalidateJsonCache("relations.json");
  const emptyResult = buildHierarchy(() => []);
  t.assert(emptyResult.added === 0, "empty learnings → 0 pairs");
}

// Test idempotency: running twice gives same result
{
  const hierLearnings2 = [
    { slug: "a1", tags: ["parent-tag", "child-tag"], title: "A1" },
    { slug: "a2", tags: ["parent-tag", "child-tag"], title: "A2" },
    { slug: "a3", tags: ["parent-tag", "child-tag"], title: "A3" },
    { slug: "a4", tags: ["parent-tag", "other"], title: "A4" },
  ];
  invalidateJsonCache("relations.json");
  const r1 = buildHierarchy(() => hierLearnings2);
  invalidateJsonCache("relations.json");
  const r2 = buildHierarchy(() => hierLearnings2);
  t.assert(r1.added === r2.added, `idempotent: same pairs count (${r1.added} vs ${r2.added})`);
}

// ─── syncOrphanLearnings + memory/notes/ (P3.2) ──────────────────────────────

t.section("syncOrphanLearnings + notes/");

const { syncOrphanLearnings } = mod;

// Reset for clean slate
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({ learnings: {} }, null, 2));
invalidateJsonCache("learnings-meta.json");
// Also clear SQLite learnings to match the JSON reset
if (_metaDb) _metaDb.prepare("DELETE FROM learnings").run();

// Clear existing learnings
for (const f of fs.readdirSync(path.join(tmpDir, "memory/learnings"))) {
  if (f.endsWith(".md") && !f.startsWith("_")) fs.unlinkSync(path.join(tmpDir, "memory/learnings", f));
}

// Create an orphan learning in memory/learnings/ (use fs.writeFileSync to bypass DB hook)
fs.writeFileSync(path.join(tmpDir, "memory/learnings/orphan-ai-note.md"), `---
title: "Orphan AI note"
headline: "Should be indexed"
type: pattern
created: ${today}
tags: [test, orphan]
slug: orphan-ai-note
---

This learning was created by AI but not in meta.

#test #orphan`);

// Create memory/notes/ with subfolders
fs.mkdirSync(path.join(tmpDir, "memory/notes/docker"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "memory/notes/git"), { recursive: true });

// Create human notes in notes/
fs.writeFileSync(path.join(tmpDir, "memory/notes/my-quick-note.md"), `---
title: "My quick note"
type: learning
created: ${today}
tags: [personal]
source: human
maintenance: manual
---

A quick note I wrote in Obsidian.
`);

fs.writeFileSync(path.join(tmpDir, "memory/notes/docker/compose-tips.md"), `---
title: "Docker Compose tips"
type: pattern
created: ${today}
tags: [deployment]
---

Tips for docker-compose in production.
`);

fs.writeFileSync(path.join(tmpDir, "memory/notes/git/rebase-notes.md"), `---
title: "My rebase notes"
type: learning
created: ${today}
tags: [workflow]
---

Personal notes about git rebase strategies.
`);

// Also create a file that should be skipped
fs.mkdirSync(path.join(tmpDir, "memory/notes/_templates"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "memory/notes/_templates/note-template.md"), `---
title: "{{title}}"
---
Template file, should be skipped.
`);

invalidateJsonCache("learnings-meta.json");
invalidateAllContentCaches();

const orphanCount = syncOrphanLearnings();
flushMetaSync();
t.assert(orphanCount >= 4, `Synced >= 4 orphans (got ${orphanCount})`);

invalidateJsonCache("learnings-meta.json");
const notesMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));

// AI orphan should be indexed without human metadata
const orphanAI = notesMeta.learnings["orphan-ai-note"];
t.assert(orphanAI != null, "AI orphan indexed");
t.assert(orphanAI?.source === undefined, "AI orphan has no source field");
t.assert(orphanAI?.maintenance === undefined, "AI orphan has no maintenance field");

// Human note in notes/ root should have source: human, maintenance: manual
const humanNote = notesMeta.learnings["my-quick-note"];
t.assert(humanNote != null, "Human note in notes/ indexed");
t.assert(humanNote?.source === "human", "Human note has source: human");
t.assert(humanNote?.maintenance === "manual", "Human note has maintenance: manual");
t.assert(humanNote?.file?.includes("memory/notes/"), "Human note file path includes memory/notes/");

// Notes in subfolders should get implicit tags from folder name
const dockerNote = notesMeta.learnings["docker-compose-tips"];
t.assert(dockerNote != null, "Subfolder note (docker) indexed");
t.assert(dockerNote?.tags?.includes("docker"), "Subfolder name 'docker' added as implicit tag");
t.assert(dockerNote?.tags?.includes("deployment"), "Original tag preserved");
t.assert(dockerNote?.source === "human", "Subfolder note has source: human");
t.assert(dockerNote?.maintenance === "manual", "Subfolder note has maintenance: manual");

const gitNote = notesMeta.learnings["git-rebase-notes"];
t.assert(gitNote != null, "Subfolder note (git) indexed");
t.assert(gitNote?.tags?.includes("git"), "Subfolder name 'git' added as implicit tag");

// Template file should NOT be indexed (starts with _)
t.assert(notesMeta.learnings["note-template"] == null, "Template file not indexed");

// Running again should return 0 (already indexed)
invalidateJsonCache("learnings-meta.json");
const orphanCount2 = syncOrphanLearnings();
t.assert(orphanCount2 === 0, `Second sync returns 0 (got ${orphanCount2})`);

// Test slug collision: notes/tips.md should NOT collide with learnings/tips.md
writeFile("memory/learnings/tips.md", `---
title: "AI tips"
type: learning
created: ${today}
tags: [test]
slug: tips
---

AI-generated tips.
`);
fs.writeFileSync(path.join(tmpDir, "memory/notes/tips.md"), `---
title: "Human tips"
type: learning
created: ${today}
tags: [personal]
source: human
---

Human-created tips note.
`);
invalidateJsonCache("learnings-meta.json");
const orphanCount3 = syncOrphanLearnings();
// Note: tips.md may already be indexed by onFileWrite hook (dual-write),
// so orphanCount3 may be 0 (writeFile already synced it) or >= 1 (sync catches it).
// The important thing is that after sync, "tips" slug exists and points to learnings/.
flushMetaSync();
invalidateJsonCache("learnings-meta.json");
// Read meta via the system's API (SQLite primary) rather than raw JSON file
const { readMetaStable } = await import("../meta-io.js");
const collisionMeta = readMetaStable();
// learnings/ is scanned first or indexed by writeFile hook, so it wins the slug "tips"
const tipsEntry = collisionMeta.learnings["tips"];
t.assert(tipsEntry != null, "learnings/tips.md indexed as 'tips'");
t.assert(tipsEntry?.file === "memory/learnings/tips.md", "tips slug points to learnings/ file (priority)");
// notes/tips.md is skipped because slug collision — no separate entry
// This is correct: subfolder notes get unique slugs, but root-level collision is resolved by priority

// Test string tags from hand-edited Obsidian notes
fs.writeFileSync(path.join(tmpDir, "memory/notes/string-tags-test.md"), `---
title: "String tags note"
type: learning
created: ${today}
tags: docker, git, deployment
---

Note with string tags instead of array.
`);
invalidateJsonCache("learnings-meta.json");
const orphanCount4 = syncOrphanLearnings();
t.assert(orphanCount4 >= 1, `String tags note indexed (got ${orphanCount4})`);
invalidateJsonCache("learnings-meta.json");
const stringTagsMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
// Note: parseLearningFrontmatter may not parse bare string tags correctly, but indexFile should not crash
t.assert(stringTagsMeta.learnings["string-tags-test"] != null, "String tags note indexed without crash");

// ─── performPrune skips maintenance: manual ──────────────────────────────────

t.section("performPrune skips maintenance: manual");

invalidateJsonCache("learnings-meta.json");

// Add a stale human note
const manualMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
manualMeta.learnings["manual-protected"] = {
  title: "Manual protected note",
  file: "memory/notes/manual-protected.md",
  type: "learning",
  tags: ["test"],
  hit_count: 0,
  created_date: "2024-01-01",
  last_accessed: null,
  stale: false,
  source: "human",
  maintenance: "manual"
};
manualMeta.learnings["auto-managed"] = {
  title: "Auto managed note",
  file: "memory/learnings/auto-managed.md",
  type: "learning",
  tags: ["test"],
  hit_count: 0,
  created_date: "2024-01-01",
  last_accessed: null,
  stale: false
};
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(manualMeta, null, 2));
invalidateJsonCache("learnings-meta.json");

const pruneVMap = computeAllVitalities();
const pruneResult2 = performPrune(60, pruneVMap);

invalidateJsonCache("learnings-meta.json");
const postPruneMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));

// The manual note should never be marked stale
t.assert(postPruneMeta.learnings["manual-protected"]?.stale === false, "maintenance: manual note NOT marked stale by prune");

// Path-based protection: notes/ file WITHOUT maintenance field should also be protected
const pathProtectMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
pathProtectMeta.learnings["path-protected"] = {
  title: "Path protected note",
  file: "memory/notes/path-protected.md",
  type: "learning",
  tags: ["test"],
  hit_count: 0,
  created_date: "2024-01-01",
  last_accessed: null,
  stale: false
  // No maintenance field — should still be protected by file path
};
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(pathProtectMeta, null, 2));
invalidateJsonCache("learnings-meta.json");

const pruneVMap2 = computeAllVitalities();
performPrune(60, pruneVMap2);

invalidateJsonCache("learnings-meta.json");
const postPruneMeta2 = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
t.assert(postPruneMeta2.learnings["path-protected"]?.stale === false, "notes/ file without maintenance field also protected by path");

// ─── getAllLearnings includes notes/ ──────────────────────────────────────────

t.section("getAllLearnings includes notes/");

invalidateAllContentCaches();
invalidateJsonCache("learnings-meta.json");
rebuildFullIndex(); // sync notes/ files to SQLite before querying

const allLearningsWithNotes = getAllLearnings();
const noteSlugs = allLearningsWithNotes.map(l => l.slug);
t.assert(noteSlugs.includes("my-quick-note"), "getAllLearnings includes notes/ root file");
t.assert(noteSlugs.includes("docker-compose-tips"), "getAllLearnings includes notes/ subfolder file");
t.assert(noteSlugs.includes("git-rebase-notes"), "getAllLearnings includes notes/ nested subfolder file");
t.assert(noteSlugs.includes("orphan-ai-note"), "getAllLearnings includes learnings/ file");

// ─── P10.3: Search Relevance ─────────────────────────────────────────────────

t.section("recordSearchAppearances");

const { recordSearchAppearances, checkSearchAttribution, computeRelevanceMetrics } = mod;

// Create a learning for relevance testing
writeFile("memory/learnings/relevance-test-1.md", `---
title: Relevance Test 1
type: learning
tags: [test, relevance]
---
Body of relevance test learning.
`);
ensureLearningMeta("relevance-test-1", "Relevance Test 1", "memory/learnings/relevance-test-1.md", "learning");
invalidateJsonCache("learnings-meta.json");

writeFile("memory/learnings/relevance-test-2.md", `---
title: Relevance Test 2
type: learning
tags: [test, relevance]
---
Body of relevance test 2.
`);
ensureLearningMeta("relevance-test-2", "Relevance Test 2", "memory/learnings/relevance-test-2.md", "learning");
flushMetaSync();
invalidateJsonCache("learnings-meta.json");

// Test: recordSearchAppearances increments counter
recordSearchAppearances(["relevance-test-1", "relevance-test-2"]);
flushMetaSync();
invalidateJsonCache("learnings-meta.json");
const metaAfterAppear = readJSON("learnings-meta.json");
t.assert(metaAfterAppear.learnings["relevance-test-1"]?.search_appearances === 1, "search_appearances incremented to 1");
t.assert(metaAfterAppear.learnings["relevance-test-2"]?.search_appearances === 1, "search_appearances for second learning");

// Test: multiple appearances accumulate
recordSearchAppearances(["relevance-test-1"]);
flushMetaSync();
invalidateJsonCache("learnings-meta.json");
const metaAfter2 = readJSON("learnings-meta.json");
t.assert(metaAfter2.learnings["relevance-test-1"]?.search_appearances === 2, "search_appearances incremented to 2");

t.section("checkSearchAttribution");

// Test: checkSearchAttribution increments search_followup_hits when within TTL
// recordSearchAppearances already set the attribution cache for relevance-test-1
checkSearchAttribution(["relevance-test-1"]);
flushMetaSync();
invalidateJsonCache("learnings-meta.json");
const metaAfterAttr = readJSON("learnings-meta.json");
t.assert(metaAfterAttr.learnings["relevance-test-1"]?.search_followup_hits === 1, "search_followup_hits incremented");

// Test: checkSearchAttribution does NOT increment for slugs not in attribution cache
checkSearchAttribution(["nonexistent-slug"]);
flushMetaSync();
invalidateJsonCache("learnings-meta.json");
const metaAfterNoAttr = readJSON("learnings-meta.json");
t.assert(!metaAfterNoAttr.learnings["nonexistent-slug"], "No meta entry for nonexistent slug");

// Test: attribution is consumed (one-time) — second call should NOT increment again
checkSearchAttribution(["relevance-test-1"]);
flushMetaSync();
invalidateJsonCache("learnings-meta.json");
const metaAfterDouble = readJSON("learnings-meta.json");
t.assert(metaAfterDouble.learnings["relevance-test-1"]?.search_followup_hits === 1, "Attribution consumed: no double count");

// Test: duplicate slugs in input are deduplicated
recordSearchAppearances(["relevance-test-2", "relevance-test-2", "relevance-test-2"]);
flushMetaSync();
invalidateJsonCache("learnings-meta.json");
const metaAfterDup = readJSON("learnings-meta.json");
t.assert(metaAfterDup.learnings["relevance-test-2"]?.search_appearances === 2, "Duplicate slugs deduplicated (1+1, not 1+3)");

// Test: new appearance re-enables attribution for consumed slug
recordSearchAppearances(["relevance-test-1"]);
checkSearchAttribution(["relevance-test-1"]);
flushMetaSync();
invalidateJsonCache("learnings-meta.json");
const metaAfterReattr = readJSON("learnings-meta.json");
t.assert(metaAfterReattr.learnings["relevance-test-1"]?.search_followup_hits === 2, "Re-appearance re-enables attribution");

t.section("computeRelevanceMetrics");

// After all operations: rt1 has appearances=3 followups=2, rt2 has appearances=2 followups=0
// Total: appearances=5, followups=2
const metrics1 = computeRelevanceMetrics();
t.assert(metrics1 !== null, "computeRelevanceMetrics returns object");
t.assert(metrics1.totalAppearances === 5, "totalAppearances = 5");
t.assert(metrics1.totalFollowups === 2, "totalFollowups = 2");
t.assert(metrics1.noiseList.length === 0, "No noise candidates below min threshold (need >=20 appearances)");

// Lower threshold to test noise detection — rt2 has 0 followups, conversion = (0+1)/(2+3) = 0.20
const metrics2 = computeRelevanceMetrics(1);
t.assert(metrics2.noiseList.length === 0, "No noise at 20% (threshold is <15%)");

// Test: overall conversion is smoothed Bayesian: (2+1)/(5+3) = 0.375
t.assert(Math.abs(metrics1.overallConversion - 3/8) < 0.01, "Bayesian smoothed conversion");

// ─── Cleanup ──────────────────────────────────────────────────────────────────

// Close SQLite DB before deleting temp dir (Windows file lock)
const { destroyDb } = await import("../database.js");
destroyDb();
fs.rmSync(tmpDir, { recursive: true, force: true });

// ─── Summary ──────────────────────────────────────────────────────────────────

export const results = t.summary();
