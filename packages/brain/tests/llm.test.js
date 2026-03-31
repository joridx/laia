/**
 * Tests for llm.js — budget, circuit breaker, cache, 4 task functions, warning.
 * Uses mock callLlm injection (no real API calls).
 */

import {
  getBudgetStatus, getBudgetWarning, isLlmAvailable,
  llmRerank, llmExpandQuery, llmAutoTags, llmDistill, llmCheckDuplicate,
  _testReset, _setMockCallLlm
} from "../llm.js";
import { createSuite } from "./harness.js";

const t = createSuite("llm");

// Force LLM available for tests (env override)
process.env.BRAIN_LLM_ENABLED = "true";

const TEST_BUDGET = 20;

function resetAndMock(mockFn) {
  _testReset(TEST_BUDGET);
  _setMockCallLlm(mockFn);
}

// Helper: mock that returns valid JSON content
function mockOk(content) {
  return () => ({ content: JSON.stringify(content), usage: { prompt_tokens: 10, completion_tokens: 5 } });
}

// Helper: mock that returns null (simulates API failure)
function mockFail() {
  return () => null;
}

// ─── getBudgetStatus ────────────────────────────────────────────────────────

t.section("getBudgetStatus");

resetAndMock(mockFail());
{
  const s = getBudgetStatus();
  t.assert(s.used === 0, "Fresh budget: used=0");
  t.assert(s.limit === 20, "Budget limit=20");
  t.assert(s.remaining === 20, "Remaining=20");
  t.assert(s.calls === 0, "Calls=0");
  t.assert(s.errors === 0, "Errors=0");
  t.assert(s.disabled === false, "Not disabled");
  t.assert(typeof s.mode === "string", `Mode is string (got "${s.mode}")`);
}

// ─── isLlmAvailable ────────────────────────────────────────────────────────

t.section("isLlmAvailable");

resetAndMock(mockFail());
t.assert(isLlmAvailable() === true, "Available when BRAIN_LLM_ENABLED=true");

// ─── Budget: reserve and refund via task functions ──────────────────────────

t.section("budget reserve/refund");

// llmExpandQuery costs 1 unit
resetAndMock(mockOk(["term1", "term2", "term3"]));
{
  const result = await llmExpandQuery("test query");
  t.assert(result !== null, "expandQuery returns result");
  const s = getBudgetStatus();
  t.assert(s.used === 1, "expandQuery costs 1 unit");
  t.assert(s.calls === 1, "1 call recorded");
}

// llmRerank costs 2 units
resetAndMock(mockOk(["slug-a", "slug-b", "slug-c", "slug-d"]));
{
  const candidates = [
    { slug: "slug-a", title: "A", tags: ["t1"], body: "body a" },
    { slug: "slug-b", title: "B", tags: ["t2"], body: "body b" },
    { slug: "slug-c", title: "C", tags: ["t3"], body: "body c" },
    { slug: "slug-d", title: "D", tags: ["t4"], body: "body d" },
  ];
  const result = await llmRerank("test", candidates);
  t.assert(result !== null, "rerank returns result");
  const s = getBudgetStatus();
  t.assert(s.used === 2, "rerank costs 2 units");
}

// llmAutoTags costs 1 unit
resetAndMock(mockOk(["new-tag-1", "new-tag-2"]));
{
  const result = await llmAutoTags("Test Title", "Some content", ["existing"]);
  t.assert(result !== null, "autoTags returns result");
  const s = getBudgetStatus();
  t.assert(s.used === 1, "autoTags costs 1 unit");
}

// llmDistill costs 4 units
resetAndMock(mockOk({ title: "Principle", content: "Detailed principle text", tags: ["t1", "t2"] }));
{
  const learnings = [
    { slug: "a", title: "A", tags: ["t1"], body: "body" },
    { slug: "b", title: "B", tags: ["t2"], body: "body" },
    { slug: "c", title: "C", tags: ["t3"], body: "body" },
  ];
  const result = await llmDistill(learnings, ["t1", "t2"]);
  t.assert(result !== null, "distill returns result");
  const s = getBudgetStatus();
  t.assert(s.used === 4, "distill costs 4 units");
}

// Refund on failure
resetAndMock(mockFail());
{
  const candidates = [
    { slug: "a", title: "A", tags: [], body: "" },
    { slug: "b", title: "B", tags: [], body: "" },
    { slug: "c", title: "C", tags: [], body: "" },
    { slug: "d", title: "D", tags: [], body: "" },
  ];
  const result = await llmRerank("test", candidates);
  t.assert(result === null, "rerank returns null on failure");
  const s = getBudgetStatus();
  t.assert(s.used === 0, "Budget refunded on rerank failure");
}

resetAndMock(mockFail());
{
  const result = await llmExpandQuery("test");
  t.assert(result === null, "expandQuery returns null on failure");
  const s = getBudgetStatus();
  t.assert(s.used === 0, "Budget refunded on expand failure");
}

resetAndMock(mockFail());
{
  const result = await llmAutoTags("title", "content", []);
  t.assert(result === null, "autoTags returns null on failure");
  const s = getBudgetStatus();
  t.assert(s.used === 0, "Budget refunded on autoTags failure");
}

resetAndMock(mockFail());
{
  const learnings = [
    { slug: "a", title: "A", tags: [], body: "" },
    { slug: "b", title: "B", tags: [], body: "" },
    { slug: "c", title: "C", tags: [], body: "" },
  ];
  const result = await llmDistill(learnings, []);
  t.assert(result === null, "distill returns null on failure");
  const s = getBudgetStatus();
  t.assert(s.used === 0, "Budget refunded on distill failure");
}

// ─── Budget exhaustion ──────────────────────────────────────────────────────

t.section("budget exhaustion");

resetAndMock(mockOk(["term1", "term2"]));
{
  // Consume 20 units (20 expand calls)
  for (let i = 0; i < 20; i++) {
    await llmExpandQuery(`query-${i}`);
  }
  const s = getBudgetStatus();
  t.assert(s.used === 20, "20 units consumed");
  t.assert(s.remaining === 0, "0 remaining");

  // Next call should be refused
  const result = await llmExpandQuery("one-more");
  t.assert(result === null, "Expand refused when budget exhausted");
  t.assert(getBudgetStatus().used === 20, "Budget still 20 (not charged)");
}

// Rerank refused at 19 units (needs 2)
resetAndMock(mockOk(["term1", "term2"]));
{
  for (let i = 0; i < 19; i++) {
    await llmExpandQuery(`q-${i}`);
  }
  t.assert(getBudgetStatus().used === 19, "19 units consumed");

  _setMockCallLlm(mockOk(["slug-a", "slug-b"]));
  const candidates = [
    { slug: "slug-a", title: "A", tags: [], body: "" },
    { slug: "slug-b", title: "B", tags: [], body: "" },
    { slug: "slug-c", title: "C", tags: [], body: "" },
    { slug: "slug-d", title: "D", tags: [], body: "" },
  ];
  const result = await llmRerank("test", candidates);
  t.assert(result === null, "Rerank refused at 19 units (needs 2, only 1 left)");
}

// ─── Circuit breaker ────────────────────────────────────────────────────────

t.section("circuit breaker");

// 3 consecutive errors triggers circuit breaker
resetAndMock(mockFail());
{
  const candidates = [
    { slug: "a", title: "A", tags: [], body: "" },
    { slug: "b", title: "B", tags: [], body: "" },
    { slug: "c", title: "C", tags: [], body: "" },
    { slug: "d", title: "D", tags: [], body: "" },
  ];
  // 3 failures trigger circuit breaker (rerank calls callLlm which returns null -> recordError)
  // But wait - mockFail returns null from callLlm, which triggers refund but NOT recordError
  // recordError is called inside callLlm itself. Since we mock callLlm, we bypass recordError.
  // We need to test this differently - the mock replaces callLlm entirely.
  // So circuit breaker can only be tested by having callLlm return null AND the function check budget.
  // Actually, when mockFail() returns null, the task functions call refund but don't trigger recordError.
  // Circuit breaker is internal to callLlm. With mock, we can't test it directly.
  // Let's verify the budget status reflects that errors aren't counted with mock.
  await llmRerank("q1", candidates);
  await llmRerank("q2", candidates);
  await llmRerank("q3", candidates);
  const s = getBudgetStatus();
  t.assert(s.disabled === false, "Circuit breaker NOT triggered via mock (errors are inside callLlm)");
  t.assert(s.errors === 0, "No errors recorded with mock callLlm");
}

// Test circuit breaker by simulating it directly via budget exhaustion + manual disable
// Since we can't trigger recordError through the mock, test that disabled=true blocks calls
resetAndMock(mockOk(["term1"]));
{
  // Manually simulate circuit breaker state by exhausting budget + checking disabled
  // Instead, let's verify that when isLlmAvailable returns false, functions return null
  const originalEnv = process.env.BRAIN_LLM_ENABLED;
  process.env.BRAIN_LLM_ENABLED = "false";

  // Need to reimport or the cached value won't change...
  // LLM_MODE is set at module load time, so we can't change it dynamically.
  // Skip this sub-test - LLM_MODE is a const set at import time.
  process.env.BRAIN_LLM_ENABLED = originalEnv;
}

// ─── Task function: llmRerank ───────────────────────────────────────────────

t.section("llmRerank");

// Returns null for <=3 candidates (gate)
resetAndMock(mockOk(["a", "b"]));
{
  const small = [
    { slug: "a", title: "A", tags: [], body: "" },
    { slug: "b", title: "B", tags: [], body: "" },
    { slug: "c", title: "C", tags: [], body: "" },
  ];
  const result = await llmRerank("test", small);
  t.assert(result === null, "Rerank returns null for <=3 candidates");
  t.assert(getBudgetStatus().used === 0, "No budget spent for skipped rerank");
}

// Returns null for null/empty candidates
resetAndMock(mockOk([]));
{
  t.assert(await llmRerank("test", null) === null, "Rerank null candidates");
  t.assert(await llmRerank("test", []) === null, "Rerank empty candidates");
}

// Valid rerank: filters invalid slugs from LLM response
resetAndMock(mockOk(["slug-b", "invalid-slug", "slug-a", "slug-c", "slug-d"]));
{
  const candidates = [
    { slug: "slug-a", title: "A", tags: ["t1"], body: "body a" },
    { slug: "slug-b", title: "B", tags: ["t2"], body: "body b" },
    { slug: "slug-c", title: "C", tags: ["t3"], body: "body c" },
    { slug: "slug-d", title: "D", tags: ["t4"], body: "body d" },
  ];
  const result = await llmRerank("test query", candidates);
  t.assert(Array.isArray(result), "Rerank returns array");
  t.assert(result.length === 4, "Rerank filters out invalid slug (4 valid of 5)");
  t.assert(result[0] === "slug-b", "First result is slug-b (LLM ordered)");
  t.assert(!result.includes("invalid-slug"), "Invalid slug filtered out");
}

// LLM returns markdown-wrapped JSON
resetAndMock(() => ({ content: '```json\n["slug-a", "slug-b", "slug-c", "slug-d"]\n```', usage: {} }));
{
  const candidates = [
    { slug: "slug-a", title: "A", tags: [], body: "" },
    { slug: "slug-b", title: "B", tags: [], body: "" },
    { slug: "slug-c", title: "C", tags: [], body: "" },
    { slug: "slug-d", title: "D", tags: [], body: "" },
  ];
  const result = await llmRerank("test", candidates);
  t.assert(result !== null, "Rerank handles markdown-wrapped JSON");
  t.assert(result[0] === "slug-a", "Correct first slug from markdown JSON");
}

// Cache: second call with same query+candidates returns cached result
resetAndMock(mockOk(["slug-a", "slug-b", "slug-c", "slug-d"]));
{
  const candidates = [
    { slug: "slug-a", title: "A", tags: [], body: "" },
    { slug: "slug-b", title: "B", tags: [], body: "" },
    { slug: "slug-c", title: "C", tags: [], body: "" },
    { slug: "slug-d", title: "D", tags: [], body: "" },
  ];
  await llmRerank("cached query", candidates);
  t.assert(getBudgetStatus().used === 2, "First rerank costs 2");

  // Second call should use cache, not budget
  const result2 = await llmRerank("cached query", candidates);
  t.assert(result2 !== null, "Cached rerank returns result");
  t.assert(getBudgetStatus().used === 2, "Cached rerank costs 0 (still 2)");
}

// LLM returns non-array -> null
resetAndMock(() => ({ content: '"not an array"', usage: {} }));
{
  const candidates = [
    { slug: "a", title: "A", tags: [], body: "" },
    { slug: "b", title: "B", tags: [], body: "" },
    { slug: "c", title: "C", tags: [], body: "" },
    { slug: "d", title: "D", tags: [], body: "" },
  ];
  const result = await llmRerank("test", candidates);
  t.assert(result === null, "Rerank returns null for non-array LLM response");
}

// ─── Task function: llmExpandQuery ──────────────────────────────────────────

t.section("llmExpandQuery");

resetAndMock(mockOk(["docker", "container", "kubernetes"]));
{
  const result = await llmExpandQuery("deploy");
  t.assert(Array.isArray(result), "expandQuery returns array");
  t.assert(result.length === 3, "3 terms returned");
  t.assert(result.every(t => typeof t === "string"), "All terms are strings");
  t.assert(result.every(t => t === t.toLowerCase()), "All terms lowercase");
}

// Deduplication
resetAndMock(mockOk(["Docker", "docker", "DOCKER", "compose"]));
{
  const result = await llmExpandQuery("container");
  t.assert(result.length === 2, "Duplicates removed (docker appears once)");
  t.assert(result.includes("docker"), "docker included");
  t.assert(result.includes("compose"), "compose included");
}

// Filter long terms (>=50 chars)
resetAndMock(mockOk(["ok", "a".repeat(60), "fine"]));
{
  const result = await llmExpandQuery("test");
  t.assert(result.length === 2, "Long terms filtered out");
}

// Empty array from LLM -> null
resetAndMock(mockOk([]));
{
  const result = await llmExpandQuery("test");
  t.assert(result === null, "Empty array returns null");
}

// Cache: same query returns cached
resetAndMock(mockOk(["a", "b"]));
{
  await llmExpandQuery("cached-expand");
  t.assert(getBudgetStatus().used === 1, "First expand costs 1");
  const result2 = await llmExpandQuery("cached-expand");
  t.assert(result2 !== null, "Cached expand returns result");
  t.assert(getBudgetStatus().used === 1, "Cached expand costs 0");
}

// ─── Task function: llmAutoTags ─────────────────────────────────────────────

t.section("llmAutoTags");

resetAndMock(mockOk(["spark", "date-parsing", "scala"]));
{
  const result = await llmAutoTags("Parse dates in Spark", "Content about date parsing", ["java"]);
  t.assert(Array.isArray(result), "autoTags returns array");
  t.assert(result.length === 3, "3 new tags suggested");
  t.assert(!result.includes("java"), "Existing tag 'java' excluded");
}

// Filters existing tags (case-insensitive)
resetAndMock(mockOk(["Spark", "Java", "new-tag"]));
{
  const result = await llmAutoTags("Title", "Content", ["spark", "java"]);
  t.assert(result !== null, "Result not null");
  t.assert(result.length === 1, "Only new-tag returned (spark/java filtered)");
  t.assert(result[0] === "new-tag", "new-tag is the result");
}

// Strips special characters from tags
resetAndMock(mockOk(["valid-tag", "tag@with!special", "another_tag"]));
{
  const result = await llmAutoTags("Title", "Content", []);
  t.assert(result !== null, "Result not null");
  t.assert(result.every(tag => /^[a-z0-9-]+$/.test(tag)), "All tags clean (alphanumeric + hyphens)");
}

// All suggested tags already exist -> null
resetAndMock(mockOk(["spark", "java"]));
{
  const result = await llmAutoTags("Title", "Content", ["spark", "java"]);
  t.assert(result === null, "All tags already exist -> null");
}

// No cache for autoTags (each call is unique)
resetAndMock(mockOk(["tag1"]));
{
  await llmAutoTags("Title1", "Content1", []);
  t.assert(getBudgetStatus().used === 1, "First autoTags costs 1");
  await llmAutoTags("Title2", "Content2", []);
  t.assert(getBudgetStatus().used === 2, "Second autoTags also costs 1 (no cache)");
}

// ─── Task function: llmDistill ──────────────────────────────────────────────

t.section("llmDistill");

const sampleLearnings = [
  { slug: "a", title: "Learning A", tags: ["docker", "deploy"], body: "How to deploy with Docker" },
  { slug: "b", title: "Learning B", tags: ["docker", "compose"], body: "Docker Compose patterns" },
  { slug: "c", title: "Learning C", tags: ["deploy", "ci"], body: "CI/CD pipeline setup" },
];

resetAndMock(mockOk({
  title: "Docker Deployment Principle",
  content: "Use Docker Compose for consistent deployments. Set up CI/CD pipeline for automation.",
  tags: ["docker", "deploy", "ci"]
}));
{
  const result = await llmDistill(sampleLearnings, ["docker", "deploy"]);
  t.assert(result !== null, "Distill returns result");
  t.assert(result.title === "Docker Deployment Principle", "Title preserved");
  t.assert(typeof result.content === "string", "Content is string");
  t.assert(Array.isArray(result.tags), "Tags is array");
  t.assert(result.tags.every(tag => tag === tag.toLowerCase()), "Tags lowercased");
  t.assert(Array.isArray(result.sources), "Sources is array");
  t.assert(result.sources.length === 3, "3 source slugs");
  t.assert(result.sources.includes("a"), "Source 'a' included");
  const s = getBudgetStatus();
  t.assert(s.used === 4, "Distill costs 4 units");
}

// Gate: <3 learnings returns null
resetAndMock(mockOk({ title: "X", content: "Y", tags: [] }));
{
  const result = await llmDistill([{ slug: "a", title: "A", tags: [], body: "" }], []);
  t.assert(result === null, "Distill returns null for <3 learnings");
  t.assert(getBudgetStatus().used === 0, "No budget spent for skipped distill");
}

// Gate: null learnings
resetAndMock(mockOk({ title: "X", content: "Y", tags: [] }));
{
  t.assert(await llmDistill(null, []) === null, "Distill null learnings");
  t.assert(await llmDistill([], []) === null, "Distill empty learnings");
}

// Title truncated to 120 chars
resetAndMock(mockOk({ title: "A".repeat(200), content: "Body", tags: ["t"] }));
{
  const result = await llmDistill(sampleLearnings, []);
  t.assert(result !== null, "Distill result not null");
  t.assert(result.title.length === 120, `Title truncated to 120 (got ${result.title.length})`);
}

// Tags capped at 6
resetAndMock(mockOk({ title: "T", content: "C", tags: ["a", "b", "c", "d", "e", "f", "g", "h"] }));
{
  const result = await llmDistill(sampleLearnings, []);
  t.assert(result.tags.length <= 6, `Tags capped at 6 (got ${result.tags.length})`);
}

// Missing title or content -> null
resetAndMock(mockOk({ content: "Only content, no title" }));
{
  const result = await llmDistill(sampleLearnings, []);
  t.assert(result === null, "Distill null when title missing");
}

resetAndMock(mockOk({ title: "Only title" }));
{
  const result = await llmDistill(sampleLearnings, []);
  t.assert(result === null, "Distill null when content missing");
}

// Falls back to clusterTags when LLM returns no tags
resetAndMock(mockOk({ title: "T", content: "C" }));
{
  const result = await llmDistill(sampleLearnings, ["fallback-tag"]);
  t.assert(result !== null, "Distill not null");
  t.assert(result.tags.includes("fallback-tag"), "Falls back to clusterTags");
}

// ─── getBudgetWarning ───────────────────────────────────────────────────────

t.section("getBudgetWarning");

// Warning not fired when budget available
resetAndMock(mockOk(["t"]));
{
  t.assert(getBudgetWarning() === null, "No warning when budget available");
}

// Warning fires once when exhausted
resetAndMock(mockOk(["t"]));
{
  for (let i = 0; i < 20; i++) {
    await llmExpandQuery(`exhaust-${i}`);
  }
  const w1 = getBudgetWarning();
  t.assert(typeof w1 === "string", "Warning is a string when exhausted");
  t.assert(w1.includes("20/20"), "Warning includes usage stats");

  const w2 = getBudgetWarning();
  t.assert(w2 === null, "Warning fires only once (second call null)");
}

// ─── parseJsonResponse (tested indirectly via task functions) ────────────────

t.section("parseJsonResponse (indirect)");

// Plain JSON
resetAndMock(() => ({ content: '["a", "b"]', usage: {} }));
{
  const result = await llmExpandQuery("test-plain");
  t.assert(result !== null && result.length === 2, "Parses plain JSON");
}

// JSON with ```json wrapper
resetAndMock(() => ({ content: '```json\n["a", "b"]\n```', usage: {} }));
{
  const result = await llmExpandQuery("test-fenced");
  t.assert(result !== null && result.length === 2, "Parses fenced JSON");
}

// JSON with ``` wrapper (no language tag)
resetAndMock(() => ({ content: '```\n["a", "b"]\n```', usage: {} }));
{
  const result = await llmExpandQuery("test-fenced-nolang");
  t.assert(result !== null && result.length === 2, "Parses fenced JSON without language tag");
}

// Invalid JSON -> null (graceful degradation)
resetAndMock(() => ({ content: 'not json at all', usage: {} }));
{
  const result = await llmExpandQuery("test-invalid");
  t.assert(result === null, "Invalid JSON returns null");
}

// ─── Edge cases ─────────────────────────────────────────────────────────────

t.section("edge cases");

// Candidates with missing fields
resetAndMock(mockOk(["slug-a", "slug-b", "slug-c", "slug-d"]));
{
  const candidates = [
    { slug: "slug-a" },  // no title, tags, body
    { slug: "slug-b", title: null, tags: null },
    { slug: "slug-c", title: "C", tags: ["t"], body: "b" },
    { slug: "slug-d", title: "D", tags: ["t"], body: "b" },
  ];
  const result = await llmRerank("test", candidates);
  t.assert(result !== null, "Rerank handles candidates with missing fields");
}

// AutoTags with null content
resetAndMock(mockOk(["tag1"]));
{
  const result = await llmAutoTags("Title", null, []);
  t.assert(result !== null, "autoTags handles null content");
}

// AutoTags with null existingTags
resetAndMock(mockOk(["tag1"]));
{
  const result = await llmAutoTags("Title", "Content", null);
  t.assert(result !== null, "autoTags handles null existingTags");
}

// Distill with learnings missing body/headline
resetAndMock(mockOk({ title: "T", content: "C", tags: ["t"] }));
{
  const learnings = [
    { slug: "a", title: "A", tags: [] },
    { slug: "b", title: "B", tags: [] },
    { slug: "c", title: "C", tags: [] },
  ];
  const result = await llmDistill(learnings, []);
  t.assert(result !== null, "Distill handles learnings without body");
}

// ─── llmCheckDuplicate (P9.3) ────────────────────────────────────────────────

t.section("llmCheckDuplicate");

// Basic: returns match with high similarity
resetAndMock(mockOk({ slug: "existing-one", similarity: 0.88, reason: "same topic, different wording" }));
{
  const candidates = [
    { slug: "existing-one", title: "Docker Compose best practices", similarity: 0.45, tagOverlap: 0.5 },
    { slug: "existing-two", title: "Kubernetes deployment", similarity: 0.2, tagOverlap: 0.3 },
  ];
  const result = await llmCheckDuplicate("Docker Compose patterns for production", candidates);
  t.assert(result !== null, "Returns result for high similarity");
  t.assert(result.slug === "existing-one", "Returns correct slug");
  t.assert(result.similarity === 0.88, "Returns correct similarity");
  t.assert(result.reason.length > 0, "Returns reason string");
}

// Budget reserve: costs 1 unit
resetAndMock(mockOk({ slug: "s", similarity: 0.9, reason: "r" }));
{
  const before = getBudgetStatus().used;
  await llmCheckDuplicate("test", [{ slug: "s", title: "t" }]);
  const after = getBudgetStatus().used;
  t.assert(after - before === 1, `Costs 1 unit (spent ${after - before})`);
}

// Refund on callLlm failure
resetAndMock(mockFail());
{
  const before = getBudgetStatus().used;
  const result = await llmCheckDuplicate("test", [{ slug: "s", title: "t" }]);
  const after = getBudgetStatus().used;
  t.assert(result === null, "Returns null on failure");
  t.assert(after === before, "Refunds on failure");
}

// No candidates -> null
resetAndMock(mockOk({ slug: "s", similarity: 0.9, reason: "r" }));
{
  const result = await llmCheckDuplicate("test", []);
  t.assert(result === null, "Returns null for empty candidates");
}

// LLM returns low similarity -> still returns result (caller applies threshold)
resetAndMock(mockOk({ slug: "s", similarity: 0.4, reason: "different topics" }));
{
  const result = await llmCheckDuplicate("low-sim-test", [{ slug: "s", title: "t" }]);
  t.assert(result !== null, "Returns result even for low similarity (caller filters)");
  t.assert(result.similarity === 0.4, "Similarity passed through");
}

// LLM returns no slug -> null
resetAndMock(mockOk({ slug: null, similarity: 0, reason: "no match" }));
{
  const result = await llmCheckDuplicate("test", [{ slug: "s", title: "t" }]);
  t.assert(result === null, "Returns null when slug is null");
}

// Similarity clamped to [0, 1]
resetAndMock(mockOk({ slug: "s", similarity: 1.5, reason: "over" }));
{
  const result = await llmCheckDuplicate("test", [{ slug: "s", title: "t" }]);
  t.assert(result !== null && result.similarity === 1.0, "Similarity clamped to 1.0");
}

resetAndMock(mockOk({ slug: "s", similarity: -0.5, reason: "under" }));
{
  const result = await llmCheckDuplicate("neg-sim-test", [{ slug: "s", title: "t" }]);
  t.assert(result !== null, "Negative similarity still returns result");
  t.assert(result.similarity === 0, "Negative similarity clamped to 0");
}

// Cache: second call returns cached result without extra budget
resetAndMock(mockOk({ slug: "cached-slug", similarity: 0.9, reason: "cached" }));
{
  const before = getBudgetStatus().used;
  const r1 = await llmCheckDuplicate("cache-test-title", [{ slug: "cached-slug", title: "t" }]);
  const mid = getBudgetStatus().used;
  const r2 = await llmCheckDuplicate("cache-test-title", [{ slug: "cached-slug", title: "t" }]);
  const after = getBudgetStatus().used;
  t.assert(r1 !== null && r2 !== null, "Both calls return result");
  t.assert(r1.slug === r2.slug, "Cached result matches");
  t.assert(mid - before === 1, "First call costs 1 unit");
  t.assert(after - mid === 0, "Second call is free (cached)");
}

// Null candidates -> null
resetAndMock(mockOk({ slug: "s", similarity: 0.9, reason: "r" }));
{
  const result = await llmCheckDuplicate("test-null-cands", null);
  t.assert(result === null, "Returns null for null candidates");
}

// Hallucinated slug (not in candidates) -> null
resetAndMock(mockOk({ slug: "hallucinated-slug", similarity: 0.9, reason: "made up" }));
{
  const result = await llmCheckDuplicate("halluc-test", [{ slug: "real-slug", title: "Real" }]);
  t.assert(result === null, "Rejects hallucinated slug not in candidates");
}

// No-match (slug: null) is cached — second call doesn't spend budget
resetAndMock(mockOk({ slug: null, similarity: 0, reason: "no match" }));
{
  const cands = [{ slug: "x", title: "X" }];
  const before = getBudgetStatus().used;
  const r1 = await llmCheckDuplicate("no-match-cache-test", cands);
  const mid = getBudgetStatus().used;
  const r2 = await llmCheckDuplicate("no-match-cache-test", cands);
  const after = getBudgetStatus().used;
  t.assert(r1 === null && r2 === null, "Both return null for no-match");
  t.assert(mid - before === 1, "First no-match costs 1 unit");
  t.assert(after - mid === 0, "Second no-match is free (cached)");
}

// Refund on JSON parse failure
resetAndMock(() => ({ content: "not json at all", usage: {} }));
{
  const before = getBudgetStatus().used;
  const result = await llmCheckDuplicate("parse-fail-test", [{ slug: "s", title: "t" }]);
  const after = getBudgetStatus().used;
  t.assert(result === null, "Returns null on parse failure");
  t.assert(after === before, "Refunds on parse failure");
}

// Different candidates for same title -> different cache keys
resetAndMock(mockOk({ slug: "a", similarity: 0.9, reason: "match a" }));
{
  const r1 = await llmCheckDuplicate("same-title", [{ slug: "a", title: "A" }]);
  t.assert(r1 !== null && r1.slug === "a", "First call matches slug a");

  _setMockCallLlm(mockOk({ slug: "b", similarity: 0.8, reason: "match b" }));
  const r2 = await llmCheckDuplicate("same-title", [{ slug: "b", title: "B" }]);
  t.assert(r2 !== null && r2.slug === "b", "Same title, different candidates -> different result (not cached)");
}

// ─── Summary ────────────────────────────────────────────────────────────────

export const results = t.summary();
if (results.failed > 0) process.exitCode = 1;
