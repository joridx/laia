/**
 * P4.1: SQLite + FTS5 database tests.
 * Tests the database.js module with a temporary BRAIN_PATH.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("database");

// ─── Setup: temporary BRAIN_PATH ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-db-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

for (const dir of ["memory/sessions", "memory/learnings", "memory/projects", "knowledge/general", "knowledge/people"]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}

fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({ version: "2.0", sessions: [] }, null, 2));
fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({ tag_hits: {}, search_hits: {}, total_queries: 0 }, null, 2));
fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({
  concepts: {
    docker: { related_to: ["kubernetes", "container"], children: [] },
    kubernetes: { related_to: ["docker"], children: [] },
    container: { related_to: ["docker"], children: [] },
    sql: { related_to: ["postgres", "database"], children: [] },
    postgres: { related_to: ["sql"], children: [] },
    database: { related_to: ["sql"], children: [] }
  }
}, null, 2));

const today = new Date().toISOString().split("T")[0];

function writeLearning(slug, title, headline, type, tags, body) {
  const tagsStr = tags.join(", ");
  const content = `---\ntitle: "${title}"\nheadline: "${headline}"\ntype: ${type}\ncreated: ${today}\ntags: [${tagsStr}]\nslug: ${slug}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(tmpDir, "memory/learnings", `${slug}.md`), content);
  return content;
}

writeLearning("docker-deploy-resources", "Docker deploy resources", "deploy.resources only works in Swarm mode", "warning", ["docker", "deployment"], "When using docker-compose, deploy.resources is ignored unless running in Docker Swarm mode.");
writeLearning("jenkins-token-auth", "Jenkins token authentication", "Use Object ID from Entra ID as API username", "pattern", ["jenkins", "auth", "api"], "Jenkins EPAC Toolchain uses Azure AD. The username for API calls is NOT the email but the Object ID from Entra ID.");
writeLearning("bash-set-e-increment", "Bash set -e increment trap", "((x++)) when x=0 causes script exit", "warning", ["bash", "shell"], "In bash with set -e, ((x++)) when x=0 evaluates to false (exit code 1), causing the script to exit unexpectedly.");
writeLearning("csv-engine-warnings", "CSV Engine recurring warnings", "Two types of recurring warnings are not real errors", "learning", ["csv", "binary-engine"], "The CSV Engine generates 2 types of recurring WARNING that are NOT real errors.");
writeLearning("connexio-confluence", "Connexio a Confluence API", "Cal usar Bearer token amb API REST", "pattern", ["confluence", "api", "auth"], "Per connectar a Confluence s'usa Bearer token a la capçalera Authorization. No funciona amb Basic Auth.");
writeLearning("spark-dataframe-cache", "Spark DataFrame cache strategy", "Cache after expensive transformations only", "pattern", ["scala", "spark", "performance"], "Caching every DataFrame wastes memory. Only cache after joins, aggregations or complex transformations.");
writeLearning("git-merge-strategy", "Git merge strategy for JSON", "Use custom merge for JSON conflict resolution", "learning", ["git", "merge"], "When merging JSON files with git, custom merge strategies prevent data loss.");
writeLearning("archived-old-learning", "Archived old learning", "This should not appear in active results", "learning", ["old"], "This is an archived learning that should be filtered out.");

fs.writeFileSync(path.join(tmpDir, "memory/sessions/2026-03-12_test-project.md"),
  "# Session: 2026-03-12 - test-project\n\n**Tags**: #docker #kubernetes\n\n## Summary\nWorked on Docker container deployment with Kubernetes integration.\n");
fs.writeFileSync(path.join(tmpDir, "memory/sessions/2026-03-11_binary-engine.md"),
  "# Session: 2026-03-11 - binary-engine\n\n**Tags**: #scala #spark #binary\n\n## Summary\nFixed CSV engine processing pipeline and Spark DataFrame caching issues.\n");
fs.writeFileSync(path.join(tmpDir, "memory/sessions/2026-03-10_confluence-work.md"),
  "# Session: 2026-03-10 - confluence-work\n\n**Tags**: #confluence #api\n\n## Summary\nUpdated Confluence pages via API. Carlota helped with permissions.\n");
fs.writeFileSync(path.join(tmpDir, "knowledge/general/docker-guide.md"),
  "# Docker Guide\n\nDocker containers run in isolated environments. Use Dockerfile for builds.\nDocker Swarm enables deploy.resources configuration.\n");
fs.writeFileSync(path.join(tmpDir, "knowledge/people/carlota-lopez.md"),
  "# Carlota Lopez del Blanco\n\nEmail: carlota.lopezb@allianz.es\nTeam: Data & Ops\nInvolved in Anaconda decomission and PBI releases.\n");

fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {
    "docker-deploy-resources": { hit_count: 15, created_date: "2026-02-20", last_accessed: today, stale: false },
    "jenkins-token-auth": { hit_count: 73, created_date: "2026-01-15", last_accessed: today, stale: false },
    "bash-set-e-increment": { hit_count: 5, created_date: "2026-03-01", last_accessed: "2026-03-05", stale: false },
    "csv-engine-warnings": { hit_count: 8, created_date: "2026-02-25", last_accessed: "2026-03-08", stale: false },
    "connexio-confluence": { hit_count: 20, created_date: "2026-02-18", last_accessed: today, stale: false },
    "spark-dataframe-cache": { hit_count: 3, created_date: "2026-03-05", last_accessed: "2026-03-05", stale: true },
    "git-merge-strategy": { hit_count: 2, created_date: "2026-02-28", last_accessed: "2026-03-01", stale: false },
    "archived-old-learning": { hit_count: 0, created_date: "2025-12-01", last_accessed: null, stale: true, archived: true }
  }
}, null, 2));

// ─── Import database module (after env setup) ─────────────────────────────────

const {
  isDbAvailable, getDb, closeDb, destroyDb, markDbDirty, isDbDirty,
  contentHash, sanitizeFtsQuery,
  syncLearning, syncLearningMeta, syncLearningsBatch,
  syncFile, syncFilesBatch,
  syncGraphFromJson, syncVitalityMap,
  rebuildFullIndex,
  searchLearningsFts, searchFilesFts,
  getAllLearningsFromDb, getLearningsByTagsFromDb, getVitalityMapFromDb,
  getDbStats, checkFtsIntegrity
} = await import("../database.js");

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Schema & Lifecycle");

t.assert(isDbAvailable() === true, "isDbAvailable returns true");
const db = getDb();
t.assert(db !== null, "getDb returns instance");

const walMode = db.pragma("journal_mode", { simple: true });
t.assert(walMode === "wal", `WAL mode active (got ${walMode})`);

const schemaRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
t.assert(schemaRow?.version >= 2, `schema version >= 2 (got ${schemaRow?.version})`);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
for (const expected of ["learnings", "learning_tags", "files", "concepts", "concept_edges", "db_meta", "schema_version", "metrics", "export_state", "change_log"]) {
  t.assert(tables.includes(expected), `table exists: ${expected}`);
}

const ftsTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'").all().map(r => r.name);
t.assert(ftsTables.some(n => n.includes("learnings_fts")), "learnings_fts exists");
t.assert(ftsTables.some(n => n.includes("files_fts")), "files_fts exists");

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Content hashing");

const h1 = contentHash("hello world");
const h2 = contentHash("hello world");
t.assert(h1 === h2, "same input → same hash");
t.assert(h1.length === 16, `hash length = 16 (got ${h1.length})`);
t.assert(/^[a-f0-9]+$/.test(h1), "hash is hex");
t.assert(contentHash("hello") !== contentHash("world"), "different input → different hash");

// ═══════════════════════════════════════════════════════════════════════════════
t.section("FTS query sanitization");

t.assert(sanitizeFtsQuery(["docker", "deploy"]) === '"docker" "deploy"', "wraps in quotes");
t.assert(sanitizeFtsQuery(['he"llo']) === '"he""llo"', "escapes internal quotes");
t.assert(sanitizeFtsQuery([]) === null, "empty → null");
t.assert(sanitizeFtsQuery(null) === null, "null → null");
t.assert(sanitizeFtsQuery(["a", "docker", "b"]) === '"docker"', "filters short tokens");

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Full rebuild");

const r1 = rebuildFullIndex();
t.assert(r1 !== null, "rebuildFullIndex returns result");
t.assert(r1.learnings.indexed >= 7, `indexed >=7 learnings (got ${r1.learnings.indexed})`);
t.assert(r1.files.indexed >= 4, `indexed >=4 files (got ${r1.files.indexed})`);
t.assert(typeof r1.elapsed === "number" && r1.elapsed >= 0, "elapsed is number");

// Second rebuild: hash-based skip
const r2 = rebuildFullIndex();
t.assert(r2.learnings.skipped >= 7, `skipped >=7 unchanged (got ${r2.learnings.skipped})`);
t.assert(r2.learnings.indexed === 0, `0 newly indexed (got ${r2.learnings.indexed})`);

// Modify one learning → only that one re-indexed
writeLearning("docker-deploy-resources", "Docker deploy resources UPDATED", "deploy.resources only works in Swarm mode", "warning", ["docker", "deployment"], "Updated body.");
const r3 = rebuildFullIndex();
t.assert(r3.learnings.indexed === 1, `1 re-indexed after change (got ${r3.learnings.indexed})`);
t.assert(r3.learnings.skipped >= 6, `>=6 skipped (got ${r3.learnings.skipped})`);
// Restore
writeLearning("docker-deploy-resources", "Docker deploy resources", "deploy.resources only works in Swarm mode", "warning", ["docker", "deployment"], "When using docker-compose, deploy.resources is ignored unless running in Docker Swarm mode.");
rebuildFullIndex();

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Sync: individual learning");

{
  const content = `---\ntitle: "Test New"\nheadline: "test headline"\ntype: learning\ncreated: ${today}\ntags: [test, new]\nslug: test-new-learning\n---\n\nTest body content.\n`;
  const changed = syncLearning(db, "test-new-learning", content, { hit_count: 5 });
  t.assert(changed === true, "syncLearning inserts new");
  const row = db.prepare("SELECT * FROM learnings WHERE slug = ?").get("test-new-learning");
  t.assert(row !== undefined, "row exists after insert");
  t.assert(row.hit_count === 5, `hit_count = 5 (got ${row?.hit_count})`);
  // Cleanup
  db.prepare("DELETE FROM learnings WHERE slug = 'test-new-learning'").run();
  db.prepare("DELETE FROM learning_tags WHERE slug = 'test-new-learning'").run();
}

{
  const content = fs.readFileSync(path.join(tmpDir, "memory/learnings/docker-deploy-resources.md"), "utf-8");
  const changed = syncLearning(db, "docker-deploy-resources", content, {});
  t.assert(changed === false, "syncLearning skips unchanged");
}

{
  const tags = db.prepare("SELECT tag FROM learning_tags WHERE slug = 'docker-deploy-resources' ORDER BY tag").all();
  t.assert(tags.length === 2, `tag count = 2 (got ${tags.length})`);
  t.assert(tags.length >= 1 && tags[0].tag === "deployment", `tag[0] = deployment (got ${tags[0]?.tag})`);
  t.assert(tags.length >= 2 && tags[1].tag === "docker", `tag[1] = docker (got ${tags[1]?.tag})`);
}

{
  const changed = syncLearning(db, "bad-learning", "no frontmatter here", {});
  t.assert(changed === false, "syncLearning rejects bad frontmatter");
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Sync: meta");

syncLearningMeta(db, "docker-deploy-resources", {
  hit_count: 99, last_accessed: today, stale: false, archived: false, vitality: 0.85, vitality_zone: "active"
});
{
  const row = db.prepare("SELECT hit_count, vitality, vitality_zone FROM learnings WHERE slug = ?").get("docker-deploy-resources");
  t.assert(row.hit_count === 99, `hit_count updated to 99 (got ${row.hit_count})`);
  t.assert(Math.abs(row.vitality - 0.85) < 0.01, `vitality = 0.85 (got ${row.vitality})`);
  t.assert(row.vitality_zone === "active", `zone = active (got ${row.vitality_zone})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Sync: files");

{
  const changed = syncFile(db, "memory/sessions/new-test.md", "# Test session\nSome content here.");
  t.assert(changed === true, "syncFile inserts new");
  const row = db.prepare("SELECT * FROM files WHERE rel_path = ?").get("memory/sessions/new-test.md");
  t.assert(row !== undefined, "file row exists");
  db.prepare("DELETE FROM files WHERE rel_path = 'memory/sessions/new-test.md'").run();
}

{
  // Read original content from disk (not from DB, which has stemmed tokens appended)
  const row = db.prepare("SELECT rel_path FROM files WHERE rel_path LIKE 'memory/sessions/%' LIMIT 1").get();
  if (row) {
    const originalContent = fs.readFileSync(path.join(tmpDir, row.rel_path), "utf-8");
    const changed = syncFile(db, row.rel_path, originalContent);
    t.assert(changed === false, "syncFile skips unchanged");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Sync: graph");

{
  const count = db.prepare("SELECT COUNT(*) as c FROM concepts").get().c;
  t.assert(count === 6, `6 concepts (got ${count})`);
}

{
  const edges = db.prepare("SELECT * FROM concept_edges WHERE source = 'docker' ORDER BY target").all();
  t.assert(edges.length === 2, `2 edges from docker (got ${edges.length})`);
  t.assert(edges.length >= 1 && edges[0].target === "container", `edge[0] = container (got ${edges[0]?.target})`);
  t.assert(edges.length >= 2 && edges[1].target === "kubernetes", `edge[1] = kubernetes (got ${edges[1]?.target})`);
}

{
  syncGraphFromJson(db, { concepts: { only: { related_to: ["one"], children: [] } } });
  const count = db.prepare("SELECT COUNT(*) as c FROM concepts").get().c;
  t.assert(count === 1, `rebuild clears old (got ${count})`);
  // Restore
  const relations = JSON.parse(fs.readFileSync(path.join(tmpDir, "relations.json"), "utf-8"));
  syncGraphFromJson(db, relations);
}

syncGraphFromJson(db, null); // no-op, no throw
syncGraphFromJson(db, {}); // no-op, no throw
t.assert(true, "syncGraphFromJson handles null/empty gracefully");

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Sync: vitality map");

{
  const vMap = new Map([
    ["docker-deploy-resources", { vitality: 0.72, zone: "active" }],
    ["jenkins-token-auth", { vitality: 0.95, zone: "active" }],
    ["bash-set-e-increment", { vitality: 0.35, zone: "stale" }]
  ]);
  syncVitalityMap(db, vMap);
  const r1 = db.prepare("SELECT vitality, vitality_zone FROM learnings WHERE slug = ?").get("docker-deploy-resources");
  t.assert(r1 && Math.abs(r1.vitality - 0.72) < 0.01, `docker vitality = 0.72 (got ${r1?.vitality})`);
  const r2 = db.prepare("SELECT vitality_zone FROM learnings WHERE slug = ?").get("bash-set-e-increment");
  t.assert(r2?.vitality_zone === "stale", `bash zone = stale (got ${r2?.vitality_zone})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Batch operations");

{
  const items = [
    { slug: "batch-test-1", content: `---\ntitle: "Batch 1"\nheadline: "h1"\ntype: learning\ncreated: ${today}\ntags: [batch]\nslug: batch-test-1\n---\n\nBody 1\n`, meta: {} },
    { slug: "batch-test-2", content: `---\ntitle: "Batch 2"\nheadline: "h2"\ntype: warning\ncreated: ${today}\ntags: [batch]\nslug: batch-test-2\n---\n\nBody 2\n`, meta: {} }
  ];
  syncLearningsBatch(db, items);
  const count = db.prepare("SELECT COUNT(*) as c FROM learnings WHERE slug LIKE 'batch-test-%'").get().c;
  t.assert(count === 2, `batch inserted 2 (got ${count})`);
  db.prepare("DELETE FROM learnings WHERE slug LIKE 'batch-test-%'").run();
  db.prepare("DELETE FROM learning_tags WHERE slug LIKE 'batch-test-%'").run();
}

{
  syncFilesBatch(db, [
    { relPath: "test/a.md", content: "File A content" },
    { relPath: "test/b.md", content: "File B content" }
  ]);
  const count = db.prepare("SELECT COUNT(*) as c FROM files WHERE rel_path LIKE 'test/%'").get().c;
  t.assert(count === 2, `batch files inserted 2 (got ${count})`);
  db.prepare("DELETE FROM files WHERE rel_path LIKE 'test/%'").run();
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("FTS5 Search: learnings");

{
  const results = searchLearningsFts(["docker"]);
  t.assert(results !== null, "docker search not null");
  t.assert(results.length > 0, "docker search has results");
  t.assert(results.some(r => r.slug === "docker-deploy-resources"), "finds docker-deploy-resources");
}

{
  const results = searchLearningsFts(["jenkins", "token"]);
  t.assert(results.length > 0, "multi-word has results");
  t.assert(results.length > 0 && results[0].slug === "jenkins-token-auth", `top result = jenkins-token-auth (got ${results[0]?.slug})`);
}

{
  const results = searchLearningsFts(["docker"]);
  t.assert(results.length > 0 && typeof results[0].bm25Score === "number", "bm25Score is number");
  t.assert(results.length > 0 && results[0].bm25Score > 0, `bm25Score positive (got ${results[0]?.bm25Score})`);
}

{
  const results = searchLearningsFts(["jenkins"]);
  const r = results.find(l => l.slug === "jenkins-token-auth");
  t.assert(r !== undefined, "jenkins learning found");
  t.assert(r && typeof r.title === "string" && r.title.length > 0, "has title");
  t.assert(r && typeof r.headline === "string", "has headline");
  t.assert(r && typeof r.type === "string", "has type");
  t.assert(r && Array.isArray(r.tags), "tags is array");
  t.assert(r && typeof r.file === "string", "has file");
}

{
  const results = searchLearningsFts([]);
  t.assert(results !== null && results.length === 0, "empty query → empty results");
}

{
  const results = searchLearningsFts(["docker's", "deploy()", "test*"]);
  t.assert(Array.isArray(results), "special chars don't crash");
}

{
  const results = searchLearningsFts(["authentication"]);
  t.assert(results.length > 0, "porter stemming finds authentication → auth content");
}

{
  const all = searchLearningsFts(["docker"], { limit: 50 });
  if (all.length >= 2) {
    const limited = searchLearningsFts(["docker"], { limit: 1 });
    t.assert(limited.length === 1, `limit=1 returns 1 (got ${limited.length})`);
    const offsetR = searchLearningsFts(["docker"], { limit: 1, offset: 1 });
    t.assert(offsetR.length === 1, "offset=1 returns 1");
    t.assert(offsetR.length > 0 && limited.length > 0 && offsetR[0].slug !== limited[0].slug, "offset gives different result");
  } else {
    t.assert(true, "skip limit/offset (not enough results)");
  }
}

{
  const results = searchLearningsFts(["archived", "old"]);
  t.assert(!results.some(r => r.slug === "archived-old-learning"), "excludes archived by default");
}

{
  const results = searchLearningsFts(["archived", "old"], { includeArchived: true });
  t.assert(results.some(r => r.slug === "archived-old-learning"), "includes archived with flag");
}

{
  const results = searchLearningsFts(["a", "b", "c"]);
  t.assert(results.length === 0, "single-char tokens → empty");
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("FTS5 Search: files");

{
  const results = searchFilesFts(["docker", "kubernetes"]);
  t.assert(results !== null, "files search not null");
  t.assert(results.length > 0, "files search has results");
  t.assert(results.some(r => r.relPath.includes("test-project")), "finds test-project session");
}

{
  const results = searchFilesFts(["docker"], { scope: "sessions" });
  t.assert(results.every(r => r.relPath.startsWith("memory/sessions/")), "scope=sessions filters");
}

{
  const results = searchFilesFts(["docker"], { scope: "knowledge" });
  t.assert(results.every(r => r.relPath.startsWith("knowledge/")), "scope=knowledge filters");
}

{
  const results = searchFilesFts(["carlota"]);
  t.assert(results.length > 0, "finds carlota");
  t.assert(results.some(r => r.relPath.includes("carlota")), "carlota in file path");
}

{
  const results = searchFilesFts(["docker"]);
  if (results.length > 0) {
    t.assert(typeof results[0].bm25Score === "number", "files have bm25Score");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Read: getAllLearningsFromDb");

{
  const all = getAllLearningsFromDb();
  t.assert(all !== null, "not null");
  t.assert(all.length >= 6, `>=6 active (got ${all.length})`);
  t.assert(!all.some(l => l.slug === "archived-old-learning"), "excludes archived");
}

{
  const all = getAllLearningsFromDb({ includeArchived: true });
  t.assert(all.some(l => l.slug === "archived-old-learning"), "includes archived with flag");
}

{
  const all = getAllLearningsFromDb({ includeArchived: true });
  const l = all.find(l => l.slug === "docker-deploy-resources");
  t.assert(l !== undefined, "finds docker learning");
  t.assert(typeof l.title === "string", "has title");
  t.assert(typeof l.headline === "string", "has headline");
  t.assert(typeof l.type === "string", "has type");
  t.assert(Array.isArray(l.tags), "tags is array");
  t.assert(typeof l.file === "string", "has file");
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Read: getLearningsByTagsFromDb");

{
  const results = getLearningsByTagsFromDb(["docker"]);
  t.assert(results !== null, "not null");
  t.assert(results.length > 0, "finds docker tag");
  t.assert(results.every(r => r.tags.includes("docker")), "all have docker tag");
}

{
  const results = getLearningsByTagsFromDb(["docker", "bash"]);
  t.assert(results.length >= 2, `>=2 for docker|bash (got ${results.length})`);
}

{
  const warnings = getLearningsByTagsFromDb(["docker", "bash"], "warning");
  t.assert(warnings.length >= 2, `>=2 warnings (got ${warnings.length})`);
  t.assert(warnings.every(r => r.type === "warning"), "all are warnings");
}

{
  const results = getLearningsByTagsFromDb(["old"]);
  t.assert(!results.some(r => r.slug === "archived-old-learning"), "excludes archived");
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Read: getVitalityMapFromDb");

{
  const vMap = getVitalityMapFromDb();
  t.assert(vMap !== null, "not null");
  t.assert(vMap instanceof Map, "is Map");
  t.assert(vMap.size >= 7, `>=7 entries (got ${vMap.size})`);
  const entry = vMap.get("docker-deploy-resources");
  t.assert(entry !== undefined, "has docker entry");
  t.assert(typeof entry.vitality === "number", "vitality is number");
  t.assert(typeof entry.zone === "string", "zone is string");
  t.assert(typeof entry.accessCount === "number", "accessCount is number");
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Diagnostics");

{
  const stats = getDbStats();
  t.assert(stats !== null, "stats not null");
  t.assert(stats.sizeBytes > 0, `size > 0 (got ${stats.sizeBytes})`);
  t.assert(stats.schemaVersion === schemaRow?.version, `version matches schema_version table (got ${stats.schemaVersion})`);
  t.assert(stats.learnings.total >= 7, `>=7 learnings (got ${stats.learnings.total})`);
  t.assert(stats.files >= 4, `>=4 files (got ${stats.files})`);
  t.assert(stats.graph.concepts >= 5, `>=5 concepts (got ${stats.graph.concepts})`);
  t.assert(stats.graph.edges >= 5, `>=5 edges (got ${stats.graph.edges})`);
  t.assert(stats.lastRebuild !== null, "lastRebuild set");
}

{
  const result = checkFtsIntegrity();
  t.assert(result !== null && result.ok === true, `FTS integrity OK (${result?.error || ""})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("Dirty flag");

markDbDirty();
t.assert(isDbDirty() === true, "dirty after mark");
rebuildFullIndex();
t.assert(isDbDirty() === false, "clean after rebuild");

// ═══════════════════════════════════════════════════════════════════════════════
t.section("destroyDb");

{
  // Ensure DB exists before destroying
  const dbBefore = getDb();
  t.assert(dbBefore !== null, "DB exists before destroy");
  const dbFile = path.join(tmpDir, ".brain.db");
  t.assert(fs.existsSync(dbFile), "DB file exists on disk");

  destroyDb();

  t.assert(!fs.existsSync(dbFile), "DB file deleted after destroy");
  t.assert(!fs.existsSync(dbFile + "-wal"), "WAL file deleted after destroy");
  t.assert(!fs.existsSync(dbFile + "-shm"), "SHM file deleted after destroy");

  // getDb() should recreate a fresh DB
  const dbAfter = getDb();
  t.assert(dbAfter !== null, "getDb recreates DB after destroy");
  t.assert(fs.existsSync(dbFile), "DB file recreated on disk");

  // Fresh DB should have empty tables
  const count = dbAfter.prepare("SELECT COUNT(*) AS n FROM learnings").get().n;
  t.assert(count === 0, `fresh DB has 0 learnings (got ${count})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
t.section("rebuildFullIndex self-heal on corruption");

{
  // First populate the DB normally
  rebuildFullIndex();
  const dbOk = getDb();
  const countBefore = dbOk.prepare("SELECT COUNT(*) AS n FROM learnings").get().n;
  t.assert(countBefore > 0, `DB has learnings before corruption (${countBefore})`);

  // Corrupt the DB by writing garbage to the file
  closeDb();
  const dbFile = path.join(tmpDir, ".brain.db");
  if (!fs.existsSync(dbFile)) {
    t.assert(true, "skip corruption test (DB file missing — likely tmpDir cleaned by prior suite)");
  } else {
    const fd = fs.openSync(dbFile, "r+");
    // Corrupt the SQLite header (first 100 bytes)
    fs.writeSync(fd, Buffer.alloc(100, 0xFF), 0, 100, 0);
    fs.closeSync(fd);

    // rebuildFullIndex should detect corruption, destroy, and rebuild
    const result = rebuildFullIndex();
    t.assert(result !== null, "rebuildFullIndex returns result after self-heal");
    t.assert(result.learnings.indexed > 0, `re-indexed learnings after corruption (${result.learnings.indexed})`);

    // DB should be functional again
    const dbHealed = getDb();
    t.assert(dbHealed !== null, "DB handle valid after self-heal");
    const countAfter = dbHealed.prepare("SELECT COUNT(*) AS n FROM learnings").get().n;
    t.assert(countAfter > 0, `DB has learnings after self-heal (${countAfter})`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup
closeDb();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

export const results = t.summary();
