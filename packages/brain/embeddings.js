/**
 * Local ONNX embeddings for semantic search (P9.2).
 * Uses @huggingface/transformers (WASM or native backend, auto-detected).
 * Graceful degradation: all exports return null if model fails to load.
 *
 * Default model: paraphrase-multilingual-MiniLM-L12-v2 (384d, 50+ languages)
 * Zero budget cost — all computation is local.
 */

import * as crypto from "crypto";

// ─── Configuration ───────────────────────────────────────────────────────────

const EMBED_MODEL = process.env.BRAIN_EMBED_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const EMBED_ENABLED = (process.env.BRAIN_EMBEDDINGS_ENABLED || "auto").toLowerCase();
const EMBED_DIM = 384;
const INIT_TIMEOUT = 15_000; // 15s max for model load

// ─── State ───────────────────────────────────────────────────────────────────

let _pipeline = null;
let _initPromise = null;
let _available = false;
let _stats = { backend: null, loadTimeMs: 0, embedCount: 0, totalEmbedMs: 0 };

// ─── Init (singleflight + timeout) ──────────────────────────────────────────

/**
 * Initialize the embedding pipeline. Safe to call multiple times (singleflight).
 * Returns true if successful, false otherwise.
 */
export async function initEmbeddings() {
  if (EMBED_ENABLED === "false") return false;
  if (_available && _pipeline) return true;
  if (_initPromise) return _initPromise;

  _initPromise = _doInit();
  const result = await _initPromise;
  if (!result) _initPromise = null; // Allow retry on failure
  return result;
}

async function _doInit() {
  const t0 = performance.now();
  try {
    const { pipeline, env } = await import("@huggingface/transformers");

    // Disable remote model loading attempts in restricted networks
    if (process.env.BRAIN_EMBED_MODEL_PATH) {
      env.localModelPath = process.env.BRAIN_EMBED_MODEL_PATH;
    }

    // Create feature-extraction pipeline with timeout
    const initResult = await Promise.race([
      pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Init timeout")), INIT_TIMEOUT))
    ]);

    _pipeline = initResult;
    _available = true;

    const loadTime = performance.now() - t0;
    _stats.loadTimeMs = +loadTime.toFixed(0);
    _stats.backend = env.backends?.onnx?.name || "unknown";

    console.error(`   Embeddings: loaded ${EMBED_MODEL} (${_stats.backend}) in ${_stats.loadTimeMs}ms`);

    // Self-test: embed a short string to verify
    const testResult = await _pipeline("test", { pooling: "mean", normalize: true });
    if (!testResult?.data || testResult.data.length !== EMBED_DIM) {
      console.error(`Embeddings: self-test failed (expected ${EMBED_DIM}d, got ${testResult?.data?.length})`);
      _available = false;
      _pipeline = null;
      return false;
    }

    return true;
  } catch (e) {
    console.error(`Embeddings: init failed: ${(e.message || "").slice(0, 150)}`);
    _available = false;
    _pipeline = null;
    return false;
  }
}

// ─── Core functions ──────────────────────────────────────────────────────────

export function isEmbeddingsAvailable() {
  if (EMBED_ENABLED === "false") return false;
  return _available && _pipeline !== null;
}

/**
 * Embed a single text string.
 * @returns {Float32Array|null} Vector of EMBED_DIM dimensions, or null.
 */
export async function embedText(text) {
  if (!_available || !_pipeline) return null;
  const t0 = performance.now();
  try {
    const result = await _pipeline(text, { pooling: "mean", normalize: true });
    const embedding = new Float32Array(result.data);
    _stats.embedCount++;
    _stats.totalEmbedMs += performance.now() - t0;
    return embedding;
  } catch (e) {
    console.error(`Embeddings: embedText failed: ${(e.message || "").slice(0, 100)}`);
    return null;
  }
}

/**
 * Embed multiple texts in batch.
 * @returns {Float32Array[]|null} Array of vectors, or null.
 */
export async function embedBatch(texts) {
  if (!_available || !_pipeline || !texts || texts.length === 0) return null;
  const t0 = performance.now();
  try {
    const results = [];
    // Process in chunks to yield to event loop
    const CHUNK = 32;
    for (let i = 0; i < texts.length; i += CHUNK) {
      const chunk = texts.slice(i, i + CHUNK);
      for (const text of chunk) {
        const result = await _pipeline(text, { pooling: "mean", normalize: true });
        results.push(new Float32Array(result.data));
      }
      // Yield to event loop between chunks
      if (i + CHUNK < texts.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
    _stats.embedCount += texts.length;
    _stats.totalEmbedMs += performance.now() - t0;
    return results;
  } catch (e) {
    console.error(`Embeddings: embedBatch failed: ${(e.message || "").slice(0, 100)}`);
    return null;
  }
}

// ─── Similarity functions ────────────────────────────────────────────────────

/**
 * Cosine similarity between two normalized vectors.
 * If vectors are L2-normalized (which they are from the pipeline), this is just dot product.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Find top-K most similar embeddings to the query embedding.
 * @param {Float32Array} queryEmbedding
 * @param {Map<string, Float32Array>} embeddingMap - slug -> embedding
 * @param {number} k - max results
 * @returns {Array<{slug: string, similarity: number}>}
 */
export function findTopK(queryEmbedding, embeddingMap, k = 50) {
  if (!queryEmbedding || !embeddingMap || embeddingMap.size === 0) return [];

  const scores = [];
  for (const [slug, embedding] of embeddingMap) {
    const sim = cosineSimilarity(queryEmbedding, embedding);
    if (sim > 0) scores.push({ slug, similarity: sim });
  }

  scores.sort((a, b) => b.similarity - a.similarity);
  return scores.slice(0, k);
}

// ─── Content hashing ─────────────────────────────────────────────────────────

/**
 * Compute content hash for embedding staleness detection.
 * Hash includes the text that gets embedded + model ID.
 */
export function computeEmbeddingHash(text) {
  const canonical = `${EMBED_MODEL}:${text.trim().toLowerCase()}`;
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Build the text to embed for a learning.
 * Uses title + headline + first 400 chars of body.
 */
export function buildEmbeddingText(learning) {
  const parts = [];
  if (learning.title) parts.push(learning.title);
  if (learning.headline) parts.push(learning.headline);
  if (learning.body) parts.push(learning.body.slice(0, 400));
  return parts.join(" ").trim();
}

// ─── Binary conversion for SQLite BLOB storage ──────────────────────────────

export function embeddingToBlob(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function blobToEmbedding(blob) {
  // Copy to own ArrayBuffer to avoid Buffer pool offset/alignment issues
  const copy = new Uint8Array(blob).slice();
  return new Float32Array(copy.buffer);
}

// ─── Telemetry ───────────────────────────────────────────────────────────────

export function getEmbeddingStats() {
  return {
    available: _available,
    model: EMBED_MODEL,
    dimension: EMBED_DIM,
    enabled: EMBED_ENABLED,
    backend: _stats.backend,
    loadTimeMs: _stats.loadTimeMs,
    embedCount: _stats.embedCount,
    avgEmbedMs: _stats.embedCount > 0 ? +(_stats.totalEmbedMs / _stats.embedCount).toFixed(1) : 0
  };
}

// ─── Test hooks ──────────────────────────────────────────────────────────────

export function _testReset() {
  _pipeline = null;
  _initPromise = null;
  _available = false;
  _stats = { backend: null, loadTimeMs: 0, embedCount: 0, totalEmbedMs: 0 };
}

export function _setMockPipeline(fn) {
  _pipeline = fn;
  _available = fn !== null;
}
