/**
 * Handler contract tests — exercise MCP tool handlers directly.
 * Verifies: param parsing, response envelope shape, persistence side-effects,
 * error handling, and session flow (get_context → search → remember → log_session).
 *
 * Runs with a temporary BRAIN_PATH — no real data affected.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("handler-contracts");

// ─── Setup: temporary BRAIN_PATH ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-handler-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";
process.env.BRAIN_LLM_BUDGET = "0"; // disable LLM calls in tests

// Create directory structure
for (const dir of [
  "memory/sessions",
  "memory/learnings",
  "memory/projects",
  "memory/todos",
  "knowledge/general",
  "self",
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
  }
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {}
}, null, 2));

// Seed a learning for search tests
const seedLearning = `---
title: "Docker container networking basics"
type: learning
tags: [docker, networking, containers]
created: ${today}
confidence: high
---

# Docker container networking basics

Docker containers communicate via bridge networks by default.
Use \`docker network create\` for custom networks.
Port mapping with \`-p host:container\` exposes services.
`;
fs.writeFileSync(
  path.join(tmpDir, "memory/learnings/docker-container-networking-basics.md"),
  seedLearning
);
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {
    "docker-container-networking-basics": {
      hit_count: 3, last_accessed: today,
      search_appearances: 5, search_followup_hits: 1,
      confirmation_count: 1, source: "agent",
      vitality: 0.7, vitality_zone: "active", stale: false
    }
  }
}, null, 2));

// Seed user prefs
fs.writeFileSync(path.join(tmpDir, "self/user-preferences.md"),
  "# User Preferences\n\n- Language: ca\n- Model: claude-opus\n");

// ─── Import tool handlers (after env is set) ─────────────────────────────────

const { handler: searchHandler } = await import("../tools/brain-search.js");
const { handler: rememberHandler } = await import("../tools/brain-remember.js");
const { handler: logSessionHandler } = await import("../tools/brain-log-session.js");
const { handler: getLearnHandler } = await import("../tools/brain-get-learnings.js");
const { handler: checkActionHandler } = await import("../tools/brain-check-action.js");
const { handler: todoHandler } = await import("../tools/brain-todo.js");

// ─── Helper: validate MCP response envelope ──────────────────────────────────

function isValidEnvelope(result) {
  return result
    && Array.isArray(result.content)
    && result.content.length > 0
    && result.content[0].type === "text"
    && typeof result.content[0].text === "string"
    && result.content[0].text.length > 0;
}

function getText(result) {
  return result?.content?.[0]?.text || "";
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. brain_search — contract tests
// ═════════════════════════════════════════════════════════════════════════════
t.section("brain_search");

// 1a. Valid search returns MCP envelope
const searchResult = await searchHandler({ query: "docker networking" });
t.assert(isValidEnvelope(searchResult), "search: returns valid MCP envelope");
t.assert(getText(searchResult).includes("docker"), "search: result mentions docker");

// 1b. Search with scope filter
const searchScoped = await searchHandler({ query: "docker", scope: "learnings" });
t.assert(isValidEnvelope(searchScoped), "search scoped: returns valid envelope");

// 1c. Search with no results
const searchEmpty = await searchHandler({ query: "xyznonexistent12345" });
t.assert(isValidEnvelope(searchEmpty), "search empty: returns valid envelope (even with no results)");

// 1d. Search with pagination params
const searchPaged = await searchHandler({ query: "docker", limit: 1, offset: 0 });
t.assert(isValidEnvelope(searchPaged), "search paged: returns valid envelope");

// ═════════════════════════════════════════════════════════════════════════════
// 2. brain_remember — contract tests
// ═════════════════════════════════════════════════════════════════════════════
t.section("brain_remember");

// 2a. Single learning creation
const rememberResult = await rememberHandler({
  content: "Test handler learning: This learning was created by the handler contract test.",
  type: "learning",
  tags: ["test", "handler-test"],
});
t.assert(isValidEnvelope(rememberResult), "remember: returns valid MCP envelope");
const rememberText = getText(rememberResult);
t.assert(
  rememberText.includes("Saved") || rememberText.includes("saved") || rememberText.includes("✅") || rememberText.includes("Merged") || rememberText.includes("merged") || rememberText.includes("Remembered") || rememberText.includes("✓"),
  "remember: response indicates success"
);

// 2b. Verify file was created on disk
// Single mode: slug = slugify(first line of content)
const learningFiles = fs.readdirSync(path.join(tmpDir, "memory/learnings"))
  .filter(f => f.includes("handler") && f.endsWith(".md"));
t.assert(learningFiles.length > 0, "remember: learning file created on disk");

// 2c. Verify file content has frontmatter
if (learningFiles.length > 0) {
  const content = fs.readFileSync(path.join(tmpDir, "memory/learnings", learningFiles[0]), "utf-8");
  t.assert(content.includes("title:"), "remember: file has title in frontmatter");
  t.assert(content.includes("handler-test"), "remember: file has tags");
  t.assert(content.includes("handler contract test"), "remember: file has body content");
}

// 2d. Batch mode
const batchResult = await rememberHandler({
  learnings: [
    { title: "Batch learning one", description: "First batch item", type: "pattern", tags: ["batch", "test"] },
    { title: "Batch learning two", description: "Second batch item", type: "warning", tags: ["batch", "test"] },
  ]
});
t.assert(isValidEnvelope(batchResult), "remember batch: returns valid MCP envelope");
t.assert(
  fs.existsSync(path.join(tmpDir, "memory/learnings/batch-learning-one.md")),
  "remember batch: first learning file created"
);
t.assert(
  fs.existsSync(path.join(tmpDir, "memory/learnings/batch-learning-two.md")),
  "remember batch: second learning file created"
);

// ═════════════════════════════════════════════════════════════════════════════
// 3. brain_get_learnings — contract tests
// ═════════════════════════════════════════════════════════════════════════════
t.section("brain_get_learnings");

// 3a. Get by tag
const getLearnResult = await getLearnHandler({ tags: ["test"] });
t.assert(isValidEnvelope(getLearnResult), "get_learnings: returns valid MCP envelope");
t.assert(getText(getLearnResult).includes("handler"), "get_learnings: finds test learning");

// 3b. Get by tag with type filter
const getLearnTyped = await getLearnHandler({ tags: ["batch"], type: "warning" });
t.assert(isValidEnvelope(getLearnTyped), "get_learnings typed: returns valid envelope");

// ═════════════════════════════════════════════════════════════════════════════
// 4. brain_check_action — contract tests
// ═════════════════════════════════════════════════════════════════════════════
t.section("brain_check_action");

const checkResult = await checkActionHandler({
  action: "docker deploy",
  tags: ["docker"],
});
t.assert(isValidEnvelope(checkResult), "check_action: returns valid MCP envelope");

// ═════════════════════════════════════════════════════════════════════════════
// 5. brain_todo — contract tests
// ═════════════════════════════════════════════════════════════════════════════
t.section("brain_todo");

// 5a. Add a todo
const todoAdd = await todoHandler({
  action: "add",
  text: "Test todo from handler test",
  project: "test-project",
});
t.assert(isValidEnvelope(todoAdd), "todo add: returns valid MCP envelope");
t.assert(getText(todoAdd).includes("Added") || getText(todoAdd).includes("added") || getText(todoAdd).includes("✅"),
  "todo add: response indicates success");

// 5b. List todos
const todoList = await todoHandler({ action: "list" });
t.assert(isValidEnvelope(todoList), "todo list: returns valid MCP envelope");
t.assert(getText(todoList).includes("handler test"), "todo list: finds the added todo");

// 5c. Update todo — use dynamic ID from list
const todoListText = getText(todoList);
const idMatch = todoListText.match(/\bid[=:]\s*(\d+)/i) || todoListText.match(/^\s*(\d+)[.)\s]/m);
const dynamicId = idMatch ? idMatch[1] : "1";
const todoUpdate = await todoHandler({
  action: "update",
  id: dynamicId,
  status: "done",
});
t.assert(isValidEnvelope(todoUpdate), "todo update: returns valid MCP envelope");

// ═════════════════════════════════════════════════════════════════════════════
// 6. brain_log_session — contract tests
// ═════════════════════════════════════════════════════════════════════════════
t.section("brain_log_session");

const logResult = await logSessionHandler({
  project: "test-project",
  summary: "Handler contract test session — verified all tool handlers work correctly.",
  learnings: ["MCP handlers return valid envelopes", "Batch remember creates multiple files"],
  tags: ["test", "handler-test", "mcp"],
});
t.assert(isValidEnvelope(logResult), "log_session: returns valid MCP envelope");

// Verify session file was created
const sessionFiles = fs.readdirSync(path.join(tmpDir, "memory/sessions"))
  .filter(f => f.endsWith(".md") && f.includes("test-project"));
t.assert(sessionFiles.length > 0, "log_session: session file created on disk");

// ═════════════════════════════════════════════════════════════════════════════
// 7. Session flow: remember → search (state continuity)
// ═════════════════════════════════════════════════════════════════════════════
t.section("Session flow (state continuity)");

// Remember something specific, then search for it
await rememberHandler({
  content: "PostgreSQL JSONB indexing\nUse GIN indexes for JSONB columns in PostgreSQL for fast containment queries.",
  type: "learning",
  tags: ["postgresql", "jsonb", "indexing"],
});

// Search should find it
const flowSearch = await searchHandler({ query: "postgresql jsonb index" });
t.assert(isValidEnvelope(flowSearch), "flow: search after remember returns valid envelope");
t.assert(
  getText(flowSearch).toLowerCase().includes("jsonb") || getText(flowSearch).toLowerCase().includes("postgresql"),
  "flow: search finds recently remembered learning"
);

// ═════════════════════════════════════════════════════════════════════════════
// 8. Error handling — safeTool-like behavior
// ═════════════════════════════════════════════════════════════════════════════
t.section("Error handling");

// Helper: check error envelope (handler returns error text, not crash)
function isErrorEnvelope(result) {
  return isValidEnvelope(result) && getText(result).toLowerCase().includes("error");
}

// 8a. Search with empty query should not crash
try {
  const emptySearch = await searchHandler({ query: "" });
  t.assert(isValidEnvelope(emptySearch), "error: empty query returns valid envelope (not crash)");
} catch (e) {
  // Throws are acceptable — safeTool catches them in production
  t.assert(e instanceof Error, `error: empty query threw Error (${e.message})`);
}

// 8b. Remember with missing required fields
try {
  const badRemember = await rememberHandler({});
  t.assert(isErrorEnvelope(badRemember), "error: remember with no params returns error envelope");
} catch (e) {
  t.assert(e instanceof Error, `error: remember with no params threw Error (${e.message})`);
}

// 8c. Remember with invalid type — Zod validates at MCP layer, handler accepts anything
try {
  const badType = await rememberHandler({ content: "test", tags: ["x"], type: "invalid-type" });
  // Handler-level: type is passed through (Zod validation happens in safeTool wrapper)
  t.assert(isValidEnvelope(badType), "error: invalid type returns valid envelope (Zod validates at MCP layer)");
} catch (e) {
  t.assert(e instanceof Error, `error: invalid type threw (${e.message})`);
}

// 8d. Todo with invalid action — returns "Unknown action" text
try {
  const badTodo = await todoHandler({ action: "nonexistent" });
  t.assert(isValidEnvelope(badTodo), "error: invalid todo action returns valid envelope");
  t.assert(
    getText(badTodo).toLowerCase().includes("unknown") || getText(badTodo).toLowerCase().includes("error"),
    "error: invalid todo action response indicates invalid action"
  );
} catch (e) {
  t.assert(e instanceof Error, `error: invalid todo action threw (${e.message})`);
}

// ═════════════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════════════

// Cleanup (best-effort — SQLite may hold file locks on Windows)
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // Windows: SQLite .db files may be locked — cleanup on next OS temp purge
}

const { passed, failed } = t.summary();
process.exit(failed > 0 ? 1 : 0);
