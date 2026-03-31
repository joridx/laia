#!/usr/bin/env node

/**
 * LAIA Brain MCP Server — thin orchestration layer.
 * Business logic lives in separate modules; tools are in tools/.
 * This file: server setup, DB write hooks, embedding warmup, startup.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as path from "path";

// ─── Module imports (runtime dependencies only) ──────────────────────────────

import { registerAllTools } from "./tools/index.js";
import { BRAIN_PATH } from "./config.js";
import { cleanupOrphanedTmpFiles, onFileWrite } from "./file-io.js";
import { normPath } from "./utils.js";
import {
  isDbAvailable, getDb, markDbDirty,
  syncLearning, syncFile, syncGraphFromJson, syncVitalityMap,
  syncLearningEmbedding, syncLearningEmbeddingsBatch, loadAllEmbeddings, getEmbeddingDbStats,
  metaRepo, metricsRepo
} from "./database.js";
import { getAllLearnings, flushMetaSync } from "./learnings.js";
import { migrateLearningsToStructured } from "./maintenance.js";
import {
  initEmbeddings, isEmbeddingsAvailable, embedBatch,
  buildEmbeddingText, computeEmbeddingHash, embeddingToBlob,
  getEmbeddingStats
} from "./embeddings.js";
import { invalidateEmbeddingCache } from "./search.js";
import { validatePersistedData } from "./schema-validation.js";

// ─── DB write hooks (module-scope so tests also get dual-write) ─────────────

let _hooksRegistered = false;

export function registerDbWriteHooks() {
  if (_hooksRegistered) return;
  _hooksRegistered = true;
  if (!isDbAvailable()) return;

  onFileWrite((filePath, content) => {
    const db = getDb();
    if (!db) return;
    const norm = normPath(filePath);

    // .md writes → sync to SQLite (FTS5)
    if (norm.includes("memory/learnings/") && norm.endsWith(".md") && !norm.includes("_")) {
      const slug = norm.split("/").pop().replace(".md", "");
      syncLearning(db, slug, content, {});
    } else if (norm.endsWith(".md") && (norm.startsWith("memory/sessions/") || norm.startsWith("knowledge/"))) {
      syncFile(db, norm, content);
    }

    // P14.1 Phase 0b: JSON writes → dual-write to SQLite
    if (norm === "learnings-meta.json" || norm.endsWith("/learnings-meta.json")) {
      try {
        const meta = JSON.parse(content);
        if (meta?.learnings) {
          db.transaction(() => {
            for (const [slug, entry] of Object.entries(meta.learnings)) {
              metaRepo.update(slug, {
                hit_count: entry.hit_count || 0,
                last_accessed: entry.last_accessed || null,
                search_appearances: entry.search_appearances || 0,
                search_followup_hits: entry.search_followup_hits || 0,
                confirmation_count: entry.confirmation_count || 0,
                last_confirmed: entry.last_confirmed || null,
                vitality: entry.vitality ?? 0.5,
                vitality_zone: entry.vitality_zone || "active",
                vitality_updated: entry.vitality_updated || null,
                stale: entry.stale ? 1 : 0,
                archived: entry.archived ? 1 : 0,
                archived_at: entry.archived_at || null,
                archived_by: entry.archived_by || null,
                source: entry.source || "agent",
                subsumes_json: entry.subsumes ? JSON.stringify(entry.subsumes) : null,
                superseded_by: entry.superseded_by || null,
                merge_count: entry.merge_count || 0,
                // P15.2: Feedback fields
                feedback_hits: entry.feedback_hits || 0,
                feedback_misses: entry.feedback_misses || 0,
                feedback_appearances: entry.feedback_appearances || 0,
                feedback_last_hit: entry.feedback_last_hit || null,
              });
            }
          })();
        }
      } catch (e) { console.error(`P14.1 dual-write: learnings-meta sync failed: ${e.message}`); }
    } else if (norm === "metrics.json" || norm.endsWith("/metrics.json")) {
      try {
        const metrics = JSON.parse(content);
        for (const [k, v] of Object.entries(metrics)) {
          metricsRepo.set(k, v);
        }
      } catch (e) { console.error(`P14.1 dual-write: metrics sync failed: ${e.message}`); }
    } else if (norm === "relations.json" || norm.endsWith("/relations.json")) {
      try {
        const relations = JSON.parse(content);
        syncGraphFromJson(db, relations);
      } catch (e) { console.error(`P14.1 dual-write: relations sync failed: ${e.message}`); }
    } else if (norm === "index.json" || norm.endsWith("/index.json")) {
      markDbDirty();
    }
  });
}

// Auto-register on import (covers both MCP server and test imports)
registerDbWriteHooks();

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "laia-brain",
  version: "2.51.0"
});

function safeTool(name, description, schema, handler) {
  server.tool(name, description, schema, async (params) => {
    try {
      return await handler(params);
    } catch (e) {
      console.error(`Tool ${name} error:`, e.stack || e.message);
      return { content: [{ type: "text", text: `Error in ${name}: ${e.message}` }] };
    }
  });
}

// ─── Register all tools ──────────────────────────────────────────────────────
registerAllTools(safeTool);

// ─── Start server ────────────────────────────────────────────────────────────

const QUIET = process.env.BRAIN_QUIET === '1';

async function main() {
  // ── Banner (suppressed when spawned as child with BRAIN_QUIET=1) ──
  if (!QUIET) {
    const VERSION = server.server?.version || "2.51.0";
    const title = `🧠 LAIA Brain MCP Server v${VERSION}`;
    const w = 42;
    const visLen = (s) => {
      const emojis = [...s.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu)];
      return s.length + emojis.length;
    };
    const pad = (s) => s + ' '.repeat(Math.max(0, w - visLen(s)));
    console.error(`┌${'─'.repeat(w)}┐`);
    console.error(`│${pad(` ${title}`)}│`);
    console.error(`│${pad(` Path: ${BRAIN_PATH}`)}│`);
    console.error(`└${'─'.repeat(w)}┘`);
  }

  const log = QUIET ? () => {} : (...a) => console.error(...a);

  try {
    if (!fs.existsSync(BRAIN_PATH)) {
      fs.mkdirSync(BRAIN_PATH, { recursive: true });
      log(`   Path: created (new)`);
    }
    const testFile = path.join(BRAIN_PATH, ".write_test");
    fs.writeFileSync(testFile, "ok", "utf-8");
    fs.unlinkSync(testFile);
  } catch (e) {
    console.error(`FATAL: BRAIN_PATH not writable: ${BRAIN_PATH} — ${e.message}`);
    process.exit(1);
  }

  // 7.6: Self-heal orphaned .tmp files from interrupted writes
  const tmpCleaned = cleanupOrphanedTmpFiles();
  if (tmpCleaned > 0) log(`   Self-heal: cleaned ${tmpCleaned} orphaned .tmp files`);

  const migrated = migrateLearningsToStructured();
  if (migrated > 0) {
    log(`   Migrated ${migrated} learnings to structured format`);
  }

  // Schema validation (startup-only, non-blocking)
  const { valid, issues } = validatePersistedData();
  if (!valid) {
    for (const issue of issues) {
      console.error(`   ⚠️  Schema: ${issue}`);
    }
  }

  // P4.1 + P14.1: Ensure DB write hooks are registered (idempotent)
  registerDbWriteHooks();
  if (isDbAvailable()) {
    log(`   SQLite: write hooks registered (FTS5 + P14.1 dual-write)`);
  }

  // P9.2: Background embedding warmup + batch migration (non-blocking)
  initEmbeddings().then(async ok => {
    if (!ok) { log("   Embeddings: not available"); return; }
    log("   Embeddings: ready");

    if (!isDbAvailable()) return;
    const currentModel = getEmbeddingStats().model;
    const existingEmb = loadAllEmbeddings();
    const existingSlugs = existingEmb ? new Set() : new Set();
    let modelMismatchCount = 0;
    if (existingEmb) {
      for (const [slug, data] of existingEmb) {
        if (data.modelId && data.modelId !== currentModel) {
          modelMismatchCount++;
        } else {
          existingSlugs.add(slug);
        }
      }
    }
    if (modelMismatchCount > 0) {
      log(`   Embeddings: model changed (${modelMismatchCount} vectors from old model will be re-embedded)`);
    }
    const allLearnings = getAllLearnings();
    const missing = allLearnings.filter(l => !existingSlugs.has(l.slug));
    if (missing.length === 0) return;

    log(`   Embeddings: migrating ${missing.length} learnings...`);
    const texts = missing.map(l => buildEmbeddingText(l));
    const vectors = await embedBatch(texts);
    if (!vectors || vectors.length !== missing.length) return;

    const entries = [];
    for (let i = 0; i < missing.length; i++) {
      if (!vectors[i]) continue;
      entries.push({
        slug: missing[i].slug,
        embeddingBlob: embeddingToBlob(vectors[i]),
        contentHash: computeEmbeddingHash(texts[i]),
        modelId: getEmbeddingStats().model
      });
    }
    if (entries.length > 0) {
      syncLearningEmbeddingsBatch(entries);
      invalidateEmbeddingCache();
      log(`   Embeddings: migrated ${entries.length} learnings`);
    }
  }).catch(e => log(`   Embeddings error: ${e.message}`));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`   Ready ✓`);

  // Graceful shutdown: flush debounced meta writes
  const _shutdown = () => { try { flushMetaSync(); } catch {} };
  process.on('exit', _shutdown);
  process.on('SIGINT', () => { _shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { _shutdown(); process.exit(0); });
}

import { fileURLToPath } from "url";
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch(console.error);

// ─── Re-exports for testing ──────────────────────────────────────────────────
// NOTE: These use direct "export { } from" syntax — no matching import needed.
// Do not remove without updating tests that depend on these exports.

export {
  normPath, tokenize, slugify, sanitizeTag, stripHtml,
  parseLearningFrontmatter, isLearningFile, buildLearningMarkdown,
  extractTags, detectProjectFromPath
} from "./utils.js";
export {
  classifyIntent, classifyVitalityZone,
  computeACTR, computeStructuralBoost, computeAccessSaturation,
  computeSpreadingBoosts, decayActivation,
  fuseRRF, scoreLearning, scoreFile,
  VITALITY_ZONES, DEFAULT_SIGNAL_WEIGHTS, INTENT_WEIGHTS, RRF_K
} from "./scoring.js";
export {
  readFile, writeFile, readJSON, invalidateJsonCache,
  invalidateAllContentCaches, cleanupOrphanedTmpFiles, batchWriteFiles
} from "./file-io.js";
export { mergeJsonFile, validateMergedJson } from "./git-sync.js";
export { getAllLearnings, getLearningsByTags, ensureLearningMeta, computeAllVitalities, recordSearchAppearances, checkSearchAttribution, computeRelevanceMetrics, flushMetaSync } from "./learnings.js";
export { recordHit, addRelation, addTagCooccurrenceRelations, addBridgeGraphEdges, getPageRankMap, invalidatePageRankCache, getActivationMap, invalidateActivationCache, spreadActivation, buildHierarchy } from "./graph.js";
export { performPrune, performConsolidate, performArchiveLearnings, detectClusters, cleanBrokenSubsumes, syncOrphanLearnings } from "./maintenance.js";
export { scoredSearch } from "./search.js";
export { readTodos, writeTodos } from "./todos.js";
export { BM25Index, stem, trigrams, trigramSimilarity, buildSemanticIndex } from "./semantic.js";
export {
  isDbAvailable, getDb, closeDb, markDbDirty, isDbDirty, contentHash, sanitizeFtsQuery,
  syncLearning, syncLearningMeta, syncLearningsBatch, syncFile, syncFilesBatch,
  syncGraphFromJson, syncVitalityMap, rebuildFullIndex, searchLearningsFts, searchFilesFts,
  getAllLearningsFromDb, getLearningsByTagsFromDb, getVitalityMapFromDb, getDbStats, checkFtsIntegrity,
  getAllActivationsFromDb, saveActivationsToDb, getActivationStatsFromDb
} from "./database.js";
export { BRAIN_PATH } from "./config.js";
