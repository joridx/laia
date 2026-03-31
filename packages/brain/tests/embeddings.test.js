/**
 * Tests for embeddings.js — P9.2 local ONNX embeddings.
 * Uses mock pipeline injection (no real model download).
 */

import {
  isEmbeddingsAvailable, embedText, embedBatch,
  cosineSimilarity, findTopK,
  buildEmbeddingText, computeEmbeddingHash,
  embeddingToBlob, blobToEmbedding,
  getEmbeddingStats,
  _testReset, _setMockPipeline
} from "../embeddings.js";
import { createSuite } from "./harness.js";

const t = createSuite("embeddings");

const DIM = 384;

// Helper: create a deterministic fake embedding from a string
function fakeEmbed(text) {
  const vec = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    vec[i] = Math.sin((text.charCodeAt(i % text.length) + i) * 0.1);
  }
  // L2-normalize
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

// Mock pipeline: returns deterministic embeddings
function mockPipeline(text, _opts) {
  return { data: fakeEmbed(text) };
}

// ─── Availability ─────────────────────────────────────────────────────────────

t.section("availability");

_testReset();
t.assert(!isEmbeddingsAvailable(), "Not available after reset");

_setMockPipeline(mockPipeline);
t.assert(isEmbeddingsAvailable(), "Available after mock pipeline set");

_testReset();
t.assert(!isEmbeddingsAvailable(), "Reset clears availability");

// ─── embedText ───────────────────────────────────────────────────────────────

t.section("embedText");

_testReset();
_setMockPipeline(mockPipeline);

{
  const result = await embedText("docker compose patterns");
  t.assert(result instanceof Float32Array, "embedText returns Float32Array");
  t.assert(result.length === DIM, `embedText returns ${DIM}d vector (got ${result.length})`);

  // L2-normalized: magnitude should be ~1.0
  let mag = 0;
  for (let i = 0; i < DIM; i++) mag += result[i] * result[i];
  t.assert(Math.abs(Math.sqrt(mag) - 1.0) < 0.01, "Embedding is L2-normalized");
}

// Not available → returns null
{
  _testReset();
  const result = await embedText("test");
  t.assert(result === null, "embedText returns null when not available");
}

// ─── embedBatch ──────────────────────────────────────────────────────────────

t.section("embedBatch");

_testReset();
_setMockPipeline(mockPipeline);

{
  const texts = ["docker", "kubernetes", "postgres"];
  const results = await embedBatch(texts);
  t.assert(Array.isArray(results), "embedBatch returns array");
  t.assert(results.length === 3, "embedBatch returns correct count");
  t.assert(results[0] instanceof Float32Array, "Each result is Float32Array");
  t.assert(results[0].length === DIM, `Each result is ${DIM}d`);
}

// Empty input
{
  const results = await embedBatch([]);
  t.assert(results === null, "embedBatch returns null for empty input");
}

// Not available → returns null
{
  _testReset();
  const results = await embedBatch(["test"]);
  t.assert(results === null, "embedBatch returns null when not available");
}

// ─── cosineSimilarity ────────────────────────────────────────────────────────

t.section("cosineSimilarity");

{
  // Same vector → similarity = 1.0
  const v = fakeEmbed("test");
  const sim = cosineSimilarity(v, v);
  t.assert(Math.abs(sim - 1.0) < 0.001, `Self-similarity is 1.0 (got ${sim.toFixed(4)})`);
}

{
  // Different vectors → similarity < 1.0
  const a = fakeEmbed("docker compose deployment");
  const b = fakeEmbed("kubernetes networking pods");
  const sim = cosineSimilarity(a, b);
  t.assert(sim < 1.0, `Different vectors: similarity < 1.0 (got ${sim.toFixed(4)})`);
  t.assert(sim > -1.0, `Similarity > -1.0 (got ${sim.toFixed(4)})`);
}

{
  // Null inputs → 0
  t.assert(cosineSimilarity(null, null) === 0, "null inputs → 0");
  t.assert(cosineSimilarity(fakeEmbed("a"), null) === 0, "one null → 0");
}

{
  // Different lengths → 0
  const a = new Float32Array(10);
  const b = new Float32Array(20);
  t.assert(cosineSimilarity(a, b) === 0, "Different lengths → 0");
}

// ─── findTopK ────────────────────────────────────────────────────────────────

t.section("findTopK");

{
  const query = fakeEmbed("docker");
  const map = new Map();
  map.set("docker-compose", fakeEmbed("docker compose patterns"));
  map.set("kubernetes", fakeEmbed("kubernetes pods networking"));
  map.set("postgres", fakeEmbed("postgres indexes queries"));
  map.set("docker-networking", fakeEmbed("docker networking bridge"));

  const results = findTopK(query, map, 3);
  t.assert(Array.isArray(results), "findTopK returns array");
  t.assert(results.length <= 3, "findTopK respects k limit");
  t.assert(results.every(r => r.slug && typeof r.similarity === "number"), "Results have slug + similarity");
  t.assert(results[0].similarity >= results[results.length - 1].similarity, "Results sorted by similarity desc");
}

// Empty map
{
  const query = fakeEmbed("test");
  const results = findTopK(query, new Map(), 5);
  t.assert(results.length === 0, "Empty map → empty results");
}

// Null query
{
  const results = findTopK(null, new Map([["a", fakeEmbed("a")]]), 5);
  t.assert(results.length === 0, "Null query → empty results");
}

// k > map size
{
  const query = fakeEmbed("test");
  const map = new Map();
  map.set("a", fakeEmbed("alpha"));
  map.set("b", fakeEmbed("beta"));
  const results = findTopK(query, map, 100);
  t.assert(results.length <= 2, "findTopK doesn't exceed map size");
}

// ─── buildEmbeddingText ──────────────────────────────────────────────────────

t.section("buildEmbeddingText");

{
  const text = buildEmbeddingText({
    title: "Docker Compose",
    headline: "Multi-stage builds",
    body: "Use multi-stage builds for production Docker images. This reduces image size."
  });
  t.assert(text.includes("Docker Compose"), "Includes title");
  t.assert(text.includes("Multi-stage builds"), "Includes headline");
  t.assert(text.includes("Use multi-stage"), "Includes body");
}

{
  // Long body truncated to 400 chars
  const longBody = "x".repeat(1000);
  const text = buildEmbeddingText({ title: "Test", body: longBody });
  t.assert(text.length < 500, `Body truncated (text length: ${text.length})`);
}

{
  // Missing fields
  const text = buildEmbeddingText({ title: "Only title" });
  t.assert(text === "Only title", "Handles missing headline and body");
}

{
  // All empty
  const text = buildEmbeddingText({});
  t.assert(text === "", "Empty learning → empty text");
}

// ─── computeEmbeddingHash ────────────────────────────────────────────────────

t.section("computeEmbeddingHash");

{
  const hash1 = computeEmbeddingHash("Docker Compose patterns");
  const hash2 = computeEmbeddingHash("Docker Compose patterns");
  t.assert(hash1 === hash2, "Same text → same hash");
  t.assert(typeof hash1 === "string", "Hash is a string");
  t.assert(hash1.length === 16, `Hash is 16 chars (got ${hash1.length})`);
}

{
  const hash1 = computeEmbeddingHash("Docker");
  const hash2 = computeEmbeddingHash("Kubernetes");
  t.assert(hash1 !== hash2, "Different text → different hash");
}

{
  // Case insensitive (lowercase canonical)
  const hash1 = computeEmbeddingHash("Docker Compose");
  const hash2 = computeEmbeddingHash("docker compose");
  t.assert(hash1 === hash2, "Hash is case-insensitive");
}

{
  // Whitespace trimming
  const hash1 = computeEmbeddingHash("Docker");
  const hash2 = computeEmbeddingHash("  Docker  ");
  t.assert(hash1 === hash2, "Hash trims whitespace");
}

// ─── embeddingToBlob / blobToEmbedding ───────────────────────────────────────

t.section("blob conversion");

{
  const original = fakeEmbed("test roundtrip");
  const blob = embeddingToBlob(original);
  t.assert(blob instanceof Buffer, "embeddingToBlob returns Buffer");
  t.assert(blob.length === DIM * 4, `Blob is ${DIM}*4 bytes (got ${blob.length})`);

  const recovered = blobToEmbedding(blob);
  t.assert(recovered instanceof Float32Array, "blobToEmbedding returns Float32Array");
  t.assert(recovered.length === DIM, `Recovered is ${DIM}d`);

  // Values preserved
  let maxDiff = 0;
  for (let i = 0; i < DIM; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(original[i] - recovered[i]));
  }
  t.assert(maxDiff < 1e-6, `Roundtrip preserves values (max diff: ${maxDiff})`);
}

// ─── getEmbeddingStats ───────────────────────────────────────────────────────

t.section("getEmbeddingStats");

{
  _testReset();
  const stats = getEmbeddingStats();
  t.assert(typeof stats === "object", "Stats is an object");
  t.assert(stats.available === false, "Not available after reset");
  t.assert(typeof stats.model === "string", "Model is a string");
  t.assert(stats.dimension === 384, "Dimension is 384");
  t.assert(typeof stats.embedCount === "number", "embedCount is a number");
}

{
  _testReset();
  _setMockPipeline(mockPipeline);
  await embedText("test1");
  await embedText("test2");
  const stats = getEmbeddingStats();
  t.assert(stats.available === true, "Available after mock set");
  t.assert(stats.embedCount === 2, `embedCount is 2 (got ${stats.embedCount})`);
}

// ─── Edge cases ──────────────────────────────────────────────────────────────

t.section("edge cases");

// Pipeline that throws
{
  _testReset();
  _setMockPipeline(() => { throw new Error("ONNX crash"); });
  const result = await embedText("test");
  t.assert(result === null, "Pipeline error → null (graceful degradation)");
}

// Pipeline returns unexpected shape
{
  _testReset();
  _setMockPipeline(() => ({ data: new Float32Array(10) })); // Wrong dimension
  const result = await embedText("test");
  // Still returns the result — we don't validate dimensions in embedText
  t.assert(result instanceof Float32Array, "Returns whatever pipeline produces");
}

// ─── Search integration: embedding as 8th signal ─────────────────────────────

t.section("search integration concepts");

{
  // Verify embedding weight exists in scoring config
  const { DEFAULT_SIGNAL_WEIGHTS, INTENT_WEIGHTS } = await import("../scoring.js");
  t.assert(typeof DEFAULT_SIGNAL_WEIGHTS.embedding === "number", "embedding weight in DEFAULT_SIGNAL_WEIGHTS");
  t.assert(DEFAULT_SIGNAL_WEIGHTS.embedding > 0, `embedding weight > 0 (got ${DEFAULT_SIGNAL_WEIGHTS.embedding})`);

  for (const [intent, weights] of Object.entries(INTENT_WEIGHTS)) {
    t.assert(typeof weights.embedding === "number", `${intent} has embedding weight`);
    t.assert(weights.embedding > 0, `${intent} embedding weight > 0`);
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export const results = t.summary();
