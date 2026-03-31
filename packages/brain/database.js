/**
 * SQLite + FTS5 index layer for LAIA Brain.
 * P4.1: initial cache layer. P14.1: migration to authoritative store.
 * Schema v1: derived cache from .md/.json files.
 * Schema v2: adds meta columns + metrics/export_state/change_log tables (P14.1 Phase 0).
 * Graceful degradation: if better-sqlite3 is not available, all functions
 * return null/empty and callers fall back to filesystem-based logic.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { BRAIN_PATH as _defaultBrainPath, LEARNINGS_DIR, NOTES_DIR } from "./config.js";
import { normPath, parseLearningFrontmatter, tokenize, sanitizeTag, noteSlugFromPath } from "./utils.js";
import { stem } from "./semantic.js";

// Runtime brain path (respects env changes for tests, falls back to config.js constant)
function brainPath() {
  return process.env.LAIA_BRAIN_PATH || _defaultBrainPath;
}

// ─── Conditional import ─────────────────────────────────────────────────────

let Database;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DB_FILENAME = ".brain.db";
const CURRENT_SCHEMA = 4;

// FTS5 bm25 column weights: title×3, headline×2, body×1, tags×1.5
const FTS_WEIGHTS_LEARNINGS = "-3.0, -2.0, -1.0, -1.5";
const FTS_WEIGHTS_FILES = "-1.0";

// ─── Singleton ──────────────────────────────────────────────────────────────

let _db = null;
let _dbDirty = false;
let _dbPath = null;

export function isDbAvailable() {
  return Database !== null;
}

export function getDb() {
  if (!Database) return null;

  const dbPath = path.join(brainPath(), DB_FILENAME);

  // Re-open if path changed (test support)
  if (_db && _dbPath !== dbPath) {
    try { _db.close(); } catch { /* */ }
    _db = null;
  }
  if (_db) {
    // Validate cached handle is still usable (file may have been deleted/corrupted)
    try {
      _db.prepare("SELECT 1").get();
      return _db;
    } catch {
      console.error("SQLite: cached handle invalid, reopening...");
      try { _db.close(); } catch { /* */ }
      _db = null;
    }
  }
  _dbPath = dbPath;
  try {
    _db = new Database(dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
    _db.pragma("foreign_keys = ON");

    const needsRebuild = ensureSchema(_db);
    if (needsRebuild) {
      _dbDirty = true;
    }
    ensureActivationsTable(_db);
    ensureEmbeddingsTable(_db);
    return _db;
  } catch (e) {
    // Close partially-opened handle before any recovery attempt
    if (_db) { try { _db.close(); } catch { /* */ } }
    _db = null;
    // Self-heal: if file exists but is corrupted, delete and retry once
    if (e.message && (e.message.includes("malformed") || e.message.includes("not a database"))) {
      console.error(`SQLite: corrupted DB detected (${e.message}) — deleting and recreating`);
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* */ }
      }
      _dbPath = null;
      try {
        _db = new Database(dbPath);
        _db.pragma("journal_mode = WAL");
        _db.pragma("synchronous = NORMAL");
        _db.pragma("foreign_keys = ON");
        ensureSchema(_db);
        ensureActivationsTable(_db);
        _dbDirty = true;
        _dbPath = dbPath;
        return _db;
      } catch (e2) {
        console.error(`SQLite: retry after corruption failed: ${e2.message}`);
        _db = null;
        return null;
      }
    }
    // Only log unexpected errors (not "directory does not exist" which is normal graceful degradation)
    if (!e.message.includes("directory does not exist")) {
      console.error(`SQLite init error: ${e.message}`);
    }
    return null;
  }
}

/**
 * Destroy corrupted DB: close handle, delete file + WAL/SHM, reset state.
 * Next getDb() call will create a fresh database.
 */
export function destroyDb() {
  const dbPath = path.join(brainPath(), DB_FILENAME);
  if (_db) {
    try { _db.close(); } catch { /* */ }
    _db = null;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = dbPath + suffix;
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* */ }
  }
  _dbPath = null;
  _dbDirty = false;
  console.error("SQLite: destroyed corrupted DB — will recreate on next access");
}

export function closeDb() {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
    _dbPath = null;
  }
}

export function markDbDirty() {
  _dbDirty = true;
}

export function isDbDirty() {
  return _dbDirty;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

function ensureSchema(db) {
  // Check if schema_version table exists
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();

  if (hasTable) {
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
    if (row && row.version === CURRENT_SCHEMA) return false;
    // Schema v1 → v2 migration (P14.1 Phase 0)
    if (row && row.version === 1) {
      migrateV1toV2(db);
      migrateV2toV3(db);
      migrateV3toV4(db);
      return false;
    }
    // Schema v2 → v3 migration (P15.2: feedback columns)
    if (row && row.version === 2) {
      migrateV2toV3(db);
      migrateV3toV4(db);
      return false;
    }
    // Schema v3 → v4 migration (Sprint 1: procedure + protected)
    if (row && row.version === 3) {
      migrateV3toV4(db);
      return false;
    }
  }

  // Drop and recreate everything (safe: DB is just a cache)
  createSchema(db);
  return true;
}

/**
 * Additive migration v1 → v2 (P14.1 Phase 0).
 * ALTERs existing tables + creates new ones. No data loss.
 */
function migrateV1toV2(db) {
  console.error("SQLite: migrating schema v1 → v2 (P14.1 Phase 0)...");
  const t0 = Date.now();

  db.transaction(() => {
    // 1. Add meta columns to learnings (from learnings-meta.json)
    const existingCols = new Set(
      db.prepare("PRAGMA table_info(learnings)").all().map(c => c.name)
    );
    const newCols = [
      ["search_appearances", "INTEGER DEFAULT 0"],
      ["search_followup_hits", "INTEGER DEFAULT 0"],
      ["confirmation_count", "INTEGER DEFAULT 0"],
      ["last_confirmed", "TEXT"],
      ["source", "TEXT DEFAULT 'agent'"],
      ["subsumes_json", "TEXT"],      // JSON array of subsumed slugs
      ["superseded_by", "TEXT"],       // slug of superseding learning
      ["merge_count", "INTEGER DEFAULT 0"],
      ["vitality_updated", "TEXT"],
      ["archived_at", "TEXT"],
      ["archived_by", "TEXT"],
      // P15.2: Feedback fields
      ["feedback_hits", "INTEGER DEFAULT 0"],
      ["feedback_misses", "INTEGER DEFAULT 0"],
      ["feedback_appearances", "INTEGER DEFAULT 0"],
      ["feedback_last_hit", "INTEGER"],
    ];
    for (const [name, type] of newCols) {
      if (!existingCols.has(name)) {
        db.exec(`ALTER TABLE learnings ADD COLUMN ${name} ${type}`);
      }
    }

    // 2. Create metrics table (replaces metrics.json)
    db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // 3. Create export_state table (P14.1: track .md export status)
    db.exec(`
      CREATE TABLE IF NOT EXISTS export_state (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        last_exported_hash TEXT,
        last_exported_at TEXT,
        export_path TEXT,
        PRIMARY KEY (entity_type, entity_id)
      )
    `);

    // 4. Create change_log table (P14.1: append-only audit trail)
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op TEXT NOT NULL,
        payload_json TEXT,
        machine_id TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log(entity_type, entity_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_change_log_ts ON change_log(timestamp)`);

    // 5. Update schema version (to 2; migrateV2toV3 will bump to 3 if needed)
    db.exec(`UPDATE schema_version SET version = 2`);
  })();

  console.error(`SQLite: migration v1→v2 complete (${Date.now() - t0}ms)`);
}

/**
 * Additive migration v2 → v3 (P15.2: IRF feedback columns).
 * ALTERs existing learnings table. No data loss.
 */
function migrateV2toV3(db) {
  console.error("SQLite: migrating schema v2 → v3 (P15.2: feedback columns)...");
  const t0 = Date.now();

  db.transaction(() => {
    const existingCols = new Set(
      db.prepare("PRAGMA table_info(learnings)").all().map(c => c.name)
    );
    const newCols = [
      ["feedback_hits", "INTEGER DEFAULT 0"],
      ["feedback_misses", "INTEGER DEFAULT 0"],
      ["feedback_appearances", "INTEGER DEFAULT 0"],
      ["feedback_last_hit", "INTEGER"],
    ];
    for (const [name, type] of newCols) {
      if (!existingCols.has(name)) {
        db.exec(`ALTER TABLE learnings ADD COLUMN ${name} ${type}`);
      }
    }
    db.exec(`UPDATE schema_version SET version = 3`);
  })();

  console.error(`SQLite: migration v2→v3 complete (${Date.now() - t0}ms)`);
}

/**
 * Additive migration v3 → v4 (Sprint 1: Procedural Memory + Golden Suite Lite).
 * Adds procedure-specific columns and protected flag.
 */
function migrateV3toV4(db) {
  console.error("SQLite: migrating schema v3 → v4 (Sprint 1: procedure + protected)...");
  const t0 = Date.now();

  db.transaction(() => {
    const existingCols = new Set(
      db.prepare("PRAGMA table_info(learnings)").all().map(c => c.name)
    );
    const newCols = [
      // Golden Suite Lite
      ["protected", "INTEGER DEFAULT 0"],
      // Procedural Memory
      ["trigger_intents_json", "TEXT"],
      ["preconditions_json", "TEXT"],
      ["step_count", "INTEGER DEFAULT 0"],
      ["used_count", "INTEGER DEFAULT 0"],
      ["success_count", "INTEGER DEFAULT 0"],
      ["last_outcome", "TEXT"],
      ["last_used", "TEXT"],
    ];
    for (const [name, type] of newCols) {
      if (!existingCols.has(name)) {
        db.exec(`ALTER TABLE learnings ADD COLUMN ${name} ${type}`);
      }
    }
    db.exec(`UPDATE schema_version SET version = 4`);
  })();

  console.error(`SQLite: migration v3→v4 complete (${Date.now() - t0}ms)`);
}

function createSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS change_log;
    DROP TABLE IF EXISTS export_state;
    DROP TABLE IF EXISTS metrics;
    DROP TABLE IF EXISTS learning_tags;
    DROP TABLE IF EXISTS concept_edges;
    DROP TABLE IF EXISTS concepts;
    DROP TABLE IF EXISTS learnings_fts;
    DROP TABLE IF EXISTS files_fts;
    DROP TABLE IF EXISTS learnings;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS schema_version;
    DROP TABLE IF EXISTS db_meta;

    -- Learnings
    CREATE TABLE learnings (
      slug TEXT PRIMARY KEY,
      title TEXT,
      headline TEXT,
      type TEXT,
      body TEXT,
      tags_json TEXT,
      project TEXT,
      domain TEXT,
      created TEXT,
      file TEXT,
      content_hash TEXT,
      hit_count INTEGER DEFAULT 0,
      created_date TEXT,
      last_accessed TEXT,
      stale INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      vitality REAL DEFAULT 0.5,
      vitality_zone TEXT DEFAULT 'active',
      -- P14.1 v2 columns (from learnings-meta.json)
      search_appearances INTEGER DEFAULT 0,
      search_followup_hits INTEGER DEFAULT 0,
      confirmation_count INTEGER DEFAULT 0,
      last_confirmed TEXT,
      source TEXT DEFAULT 'agent',
      subsumes_json TEXT,
      superseded_by TEXT,
      merge_count INTEGER DEFAULT 0,
      vitality_updated TEXT,
      archived_at TEXT,
      archived_by TEXT,
      -- P15.2: Feedback fields
      feedback_hits INTEGER DEFAULT 0,
      feedback_misses INTEGER DEFAULT 0,
      feedback_appearances INTEGER DEFAULT 0,
      feedback_last_hit INTEGER,
      -- V4: Sprint 1 fields
      protected INTEGER DEFAULT 0,
      trigger_intents_json TEXT,
      preconditions_json TEXT,
      step_count INTEGER DEFAULT 0,
      used_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      last_outcome TEXT,
      last_used TEXT
    );

    -- FTS5 for learnings (content-sync mode)
    CREATE VIRTUAL TABLE learnings_fts USING fts5(
      title,
      headline,
      body,
      tags_text,
      content='learnings',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS5 in sync with learnings table
    CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
      INSERT INTO learnings_fts(rowid, title, headline, body, tags_text)
      VALUES (new.rowid, new.title, new.headline, new.body, new.tags_json);
    END;

    CREATE TRIGGER learnings_ad AFTER DELETE ON learnings BEGIN
      INSERT INTO learnings_fts(learnings_fts, rowid, title, headline, body, tags_text)
      VALUES ('delete', old.rowid, old.title, old.headline, old.body, old.tags_json);
    END;

    CREATE TRIGGER learnings_au AFTER UPDATE ON learnings BEGIN
      INSERT INTO learnings_fts(learnings_fts, rowid, title, headline, body, tags_text)
      VALUES ('delete', old.rowid, old.title, old.headline, old.body, old.tags_json);
      INSERT INTO learnings_fts(rowid, title, headline, body, tags_text)
      VALUES (new.rowid, new.title, new.headline, new.body, new.tags_json);
    END;

    -- Tag join table for fast tag lookups
    CREATE TABLE learning_tags (
      slug TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (slug, tag)
    );
    CREATE INDEX idx_learning_tags_tag ON learning_tags(tag);

    -- Files (sessions + knowledge)
    CREATE TABLE files (
      rel_path TEXT PRIMARY KEY,
      content TEXT,
      content_hash TEXT
    );

    CREATE VIRTUAL TABLE files_fts USING fts5(
      content,
      content='files',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER files_au AFTER UPDATE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
      INSERT INTO files_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END;

    -- Knowledge graph
    CREATE TABLE concepts (
      name TEXT PRIMARY KEY,
      parent TEXT
    );

    CREATE TABLE concept_edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      type TEXT DEFAULT 'related_to',
      PRIMARY KEY (source, target, type)
    );

    -- Meta
    CREATE TABLE db_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY
    );
    INSERT INTO schema_version VALUES (${CURRENT_SCHEMA});

    -- P14.1 v2 tables
    CREATE TABLE metrics (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE export_state (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      last_exported_hash TEXT,
      last_exported_at TEXT,
      export_path TEXT,
      PRIMARY KEY (entity_type, entity_id)
    );

    CREATE TABLE change_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      op TEXT NOT NULL,
      payload_json TEXT,
      machine_id TEXT
    );
    CREATE INDEX idx_change_log_entity ON change_log(entity_type, entity_id);
    CREATE INDEX idx_change_log_ts ON change_log(timestamp);
  `);
}

// ─── Content hashing ────────────────────────────────────────────────────────

export function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ─── Text preparation for FTS5 (adds stemmed Catalan variants) ──────────────

function prepareForFts(text) {
  if (!text) return "";
  const tokens = tokenize(text);
  const stemmed = [];
  for (const t of tokens) {
    const s = stem(t);
    if (s !== t && s.length >= 3) stemmed.push(s);
  }
  return stemmed.length > 0 ? text + " " + stemmed.join(" ") : text;
}

// ─── FTS5 query sanitization ────────────────────────────────────────────────

export function sanitizeFtsQuery(tokens) {
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .filter(t => t.length >= 2)
    .map(t => t.replace(/"/g, '""'))
    .map(t => `"${t}"`)
    .join(" ");
}

// ─── Sync: learnings ────────────────────────────────────────────────────────

const _upsertLearning = `
  INSERT OR REPLACE INTO learnings
    (slug, title, headline, type, body, tags_json, project, domain, created, file, content_hash,
     hit_count, created_date, last_accessed, stale, archived, vitality, vitality_zone,
     search_appearances, search_followup_hits, confirmation_count, last_confirmed,
     source, subsumes_json, superseded_by, merge_count, vitality_updated, archived_at, archived_by,
     protected, trigger_intents_json, preconditions_json, step_count, used_count, success_count, last_outcome, last_used)
  VALUES
    (@slug, @title, @headline, @type, @body, @tags_json, @project, @domain, @created, @file, @content_hash,
     @hit_count, @created_date, @last_accessed, @stale, @archived, @vitality, @vitality_zone,
     @search_appearances, @search_followup_hits, @confirmation_count, @last_confirmed,
     @source, @subsumes_json, @superseded_by, @merge_count, @vitality_updated, @archived_at, @archived_by,
     @protected, @trigger_intents_json, @preconditions_json, @step_count, @used_count, @success_count, @last_outcome, @last_used)
`;

const _deleteLearningTags = "DELETE FROM learning_tags WHERE slug = @slug";
const _insertLearningTag = "INSERT OR IGNORE INTO learning_tags (slug, tag) VALUES (@slug, @tag)";

export function syncLearning(db, slug, content, meta) {
  const hash = contentHash(content);

  // Skip if unchanged
  const existing = db.prepare("SELECT content_hash FROM learnings WHERE slug = ?").get(slug);
  if (existing && existing.content_hash === hash) {
    // Still sync meta if provided (hit_count, vitality may have changed)
    if (meta) {
      syncLearningMeta(db, slug, meta);
    }
    return false;
  }

  const parsed = parseLearningFrontmatter(content);
  if (!parsed) return false;

  const fm = parsed.frontmatter;
  const tags = (fm.tags || []).map(sanitizeTag);
  const metaEntry = meta || {};

  const params = {
    slug,
    title: prepareForFts(fm.title || ""),
    headline: prepareForFts(fm.headline || ""),
    type: fm.type || "learning",
    body: prepareForFts(parsed.body || ""),
    tags_json: tags.join(" "),
    project: fm.project || null,
    domain: fm.domain || null,
    created: fm.created || null,
    file: metaEntry.file || `${LEARNINGS_DIR}/${slug}.md`,
    content_hash: hash,
    hit_count: metaEntry.hit_count || 0,
    created_date: metaEntry.created_date || fm.created || null,
    last_accessed: metaEntry.last_accessed || null,
    stale: metaEntry.stale ? 1 : 0,
    archived: metaEntry.archived ? 1 : 0,
    vitality: metaEntry.vitality ?? 0.5,
    vitality_zone: metaEntry.vitality_zone || "active",
    // P14.1 v2 columns
    search_appearances: metaEntry.search_appearances || 0,
    search_followup_hits: metaEntry.search_followup_hits || 0,
    confirmation_count: metaEntry.confirmation_count || 0,
    last_confirmed: metaEntry.last_confirmed || null,
    source: metaEntry.source || "agent",
    subsumes_json: metaEntry.subsumes ? JSON.stringify(metaEntry.subsumes) : null,
    superseded_by: metaEntry.superseded_by || null,
    merge_count: metaEntry.merge_count || 0,
    vitality_updated: metaEntry.vitality_updated || null,
    archived_at: metaEntry.archived_at || null,
    archived_by: metaEntry.archived_by || null,
    // V4: Sprint 1 fields
    protected: (fm.protected || metaEntry.protected) ? 1 : 0,
    trigger_intents_json: fm.trigger_intents ? JSON.stringify(fm.trigger_intents) : (metaEntry.trigger_intents_json || null),
    preconditions_json: fm.preconditions ? JSON.stringify(fm.preconditions) : (metaEntry.preconditions_json || null),
    step_count: typeof fm.steps === 'number' ? fm.steps : (parseInt(fm.steps, 10) || metaEntry.step_count || 0),
    used_count: metaEntry.used_count ?? fm.used_count ?? 0,
    success_count: metaEntry.success_count ?? fm.success_count ?? 0,
    last_outcome: fm.last_outcome ?? metaEntry.last_outcome ?? null,
    last_used: fm.last_used ?? metaEntry.last_used ?? null,
  };

  db.prepare(_upsertLearning).run(params);

  // Sync tags
  db.prepare(_deleteLearningTags).run({ slug });
  const insertTag = db.prepare(_insertLearningTag);
  for (const tag of tags) {
    insertTag.run({ slug, tag });
  }

  return true;
}

export function syncLearningMeta(db, slug, meta) {
  db.prepare(`
    UPDATE learnings SET
      hit_count = @hit_count,
      last_accessed = @last_accessed,
      stale = @stale,
      archived = @archived,
      vitality = @vitality,
      vitality_zone = @vitality_zone,
      search_appearances = @search_appearances,
      search_followup_hits = @search_followup_hits,
      confirmation_count = @confirmation_count,
      last_confirmed = @last_confirmed,
      source = @source,
      subsumes_json = @subsumes_json,
      superseded_by = @superseded_by,
      merge_count = @merge_count,
      vitality_updated = @vitality_updated,
      archived_at = @archived_at,
      archived_by = @archived_by,
      feedback_hits = @feedback_hits,
      feedback_misses = @feedback_misses,
      feedback_appearances = @feedback_appearances,
      feedback_last_hit = @feedback_last_hit,
      protected = @protected,
      trigger_intents_json = @trigger_intents_json,
      preconditions_json = @preconditions_json,
      step_count = @step_count,
      used_count = @used_count,
      success_count = @success_count,
      last_outcome = @last_outcome,
      last_used = @last_used
    WHERE slug = @slug
  `).run({
    slug,
    hit_count: meta.hit_count || 0,
    last_accessed: meta.last_accessed || null,
    stale: meta.stale ? 1 : 0,
    archived: meta.archived ? 1 : 0,
    vitality: meta.vitality ?? 0.5,
    vitality_zone: meta.vitality_zone || "active",
    search_appearances: meta.search_appearances || 0,
    search_followup_hits: meta.search_followup_hits || 0,
    confirmation_count: meta.confirmation_count || 0,
    last_confirmed: meta.last_confirmed || null,
    source: meta.source || "agent",
    subsumes_json: meta.subsumes ? JSON.stringify(meta.subsumes) : null,
    superseded_by: meta.superseded_by || null,
    merge_count: meta.merge_count || 0,
    vitality_updated: meta.vitality_updated || null,
    archived_at: meta.archived_at || null,
    archived_by: meta.archived_by || null,
    // P15.2: Feedback fields
    feedback_hits: meta.feedback_hits || 0,
    feedback_misses: meta.feedback_misses || 0,
    feedback_appearances: meta.feedback_appearances || 0,
    feedback_last_hit: meta.feedback_last_hit || null,
    // V4: Sprint 1 fields
    protected: meta.protected ? 1 : 0,
    trigger_intents_json: meta.trigger_intents ? JSON.stringify(meta.trigger_intents) : (meta.trigger_intents_json || null),
    preconditions_json: meta.preconditions ? JSON.stringify(meta.preconditions) : (meta.preconditions_json || null),
    step_count: meta.step_count ?? 0,
    used_count: meta.used_count ?? 0,
    success_count: meta.success_count ?? 0,
    last_outcome: meta.last_outcome ?? null,
    last_used: meta.last_used ?? null,
  });
}

const VALID_OUTCOMES = new Set(["success", "failure", "partial"]);

/**
 * Update procedure outcome counters in SQLite.
 * @param {string} slug
 * @param {string} outcome - "success" | "failure" | "partial"
 */
export function updateProcedureOutcome(db, slug, outcome) {
  if (!VALID_OUTCOMES.has(outcome)) {
    throw new Error(`Invalid procedure outcome: '${outcome}'. Valid: success, failure, partial`);
  }
  const now = new Date().toISOString();
  const successInc = outcome === "success" ? 1 : 0;
  db.prepare(`
    UPDATE learnings SET
      used_count = used_count + 1,
      success_count = success_count + @successInc,
      last_outcome = @outcome,
      last_used = @now
    WHERE slug = @slug
  `).run({ slug, outcome, now, successInc });
}

export function syncLearningsBatch(db, items) {
  const tx = db.transaction(() => {
    for (const { slug, content, meta } of items) {
      syncLearning(db, slug, content, meta);
    }
  });
  tx();
}

// ─── Sync: files ────────────────────────────────────────────────────────────

export function syncFile(db, relPath, content) {
  const hash = contentHash(content);

  const existing = db.prepare("SELECT content_hash FROM files WHERE rel_path = ?").get(relPath);
  if (existing && existing.content_hash === hash) return false;

  db.prepare(
    "INSERT OR REPLACE INTO files (rel_path, content, content_hash) VALUES (@rel_path, @content, @content_hash)"
  ).run({
    rel_path: relPath,
    content: prepareForFts(content),
    content_hash: hash
  });

  return true;
}

export function syncFilesBatch(db, items) {
  const tx = db.transaction(() => {
    for (const { relPath, content } of items) {
      syncFile(db, relPath, content);
    }
  });
  tx();
}

// ─── Sync: knowledge graph ──────────────────────────────────────────────────

export function syncGraphFromJson(db, relations) {
  if (!relations?.concepts) return;

  const tx = db.transaction(() => {
    db.exec("DELETE FROM concept_edges");
    db.exec("DELETE FROM concepts");

    const insertConcept = db.prepare("INSERT OR IGNORE INTO concepts (name, parent) VALUES (?, ?)");
    const insertEdge = db.prepare("INSERT OR IGNORE INTO concept_edges (source, target, type) VALUES (?, ?, ?)");

    for (const [name, data] of Object.entries(relations.concepts)) {
      insertConcept.run(name, data.parent || null);
      for (const rel of (data.related_to || [])) {
        insertEdge.run(name, rel, "related_to");
      }
      for (const child of (data.children || [])) {
        insertEdge.run(name, child, "child");
      }
    }
  });
  tx();
}

// ─── Sync: vitality map to learnings table ──────────────────────────────────

export function syncVitalityMap(db, vitalityMap) {
  if (!vitalityMap || vitalityMap.size === 0) return;

  const stmt = db.prepare(
    "UPDATE learnings SET vitality = @vitality, vitality_zone = @zone WHERE slug = @slug"
  );

  const tx = db.transaction(() => {
    for (const [slug, data] of vitalityMap) {
      stmt.run({ slug, vitality: data.vitality, zone: data.zone });
    }
  });
  tx();
}

// ─── Full rebuild from filesystem ───────────────────────────────────────────

export function rebuildFullIndex() {
  try {
    return _rebuildFullIndexInner();
  } catch (e) {
    if (e.message && (e.message.includes("malformed") || e.message.includes("not a database"))) {
      console.error("SQLite: corruption detected during rebuild — destroying and recreating DB");
      destroyDb();
      return _rebuildFullIndexInner();
    }
    throw e;
  }
}

function _rebuildFullIndexInner() {
  const db = getDb();
  if (!db) return null;

  const t0 = performance.now();

  // 1. Rebuild learnings
  const learningsDir = path.join(brainPath(), LEARNINGS_DIR);
  let learningsCount = 0;
  let learningsSkipped = 0;

  let meta = {};
  try {
    const metaRaw = fs.readFileSync(path.join(brainPath(), "learnings-meta.json"), "utf-8");
    meta = JSON.parse(metaRaw)?.learnings || {};
  } catch (e) {
    console.error(`SQLite rebuild: learnings-meta.json missing or corrupt (${e.message}), proceeding without meta`);
  }

  const items = [];

  // 1a. Scan memory/learnings/ (flat)
  if (fs.existsSync(learningsDir)) {
    const files = fs.readdirSync(learningsDir)
      .filter(f => f.endsWith(".md") && !f.startsWith("_"));
    for (const f of files) {
      const slug = f.replace(".md", "");
      const content = fs.readFileSync(path.join(learningsDir, f), "utf-8");
      items.push({ slug, content, meta: meta[slug] || {} });
    }
  }

  // 1b. Scan memory/notes/ (recursive — human-created notes)
  const notesDir = path.join(brainPath(), NOTES_DIR);
  if (fs.existsSync(notesDir)) {
    const notesDirNorm = normPath(notesDir);
    (function walk(d, depth) {
      if (depth > 5) return;
      for (const entry of fs.readdirSync(d)) {
        if (entry.startsWith("_") || entry.startsWith(".")) continue;
        const fp = path.join(d, entry);
        let stat;
        try { stat = fs.lstatSync(fp); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) { walk(fp, depth + 1); continue; }
        if (!entry.endsWith(".md")) continue;
        const slug = noteSlugFromPath(normPath(fp), notesDirNorm);
        const relPath = normPath(fp).replace(normPath(brainPath()) + "/", "");
        const content = fs.readFileSync(fp, "utf-8");
        const noteMeta = meta[slug] || {};
        if (!noteMeta.file) noteMeta.file = relPath; // correct path for notes not yet in meta
        items.push({ slug, content, meta: noteMeta });
      }
    })(notesDir, 0);
  }

  // Use transaction for batch insert
  const tx = db.transaction(() => {
    for (const item of items) {
      const changed = syncLearning(db, item.slug, item.content, item.meta);
      if (changed) learningsCount++;
      else learningsSkipped++;
    }
  });
  tx();

  // 1c. Purge stale learnings (in SQLite but no longer on filesystem)
  let learningsPurged = 0;
  {
    const allDbSlugs = db.prepare("SELECT slug FROM learnings").all().map(r => r.slug);
    const fsSlugs = new Set(items.map(i => i.slug));
    const stale = allDbSlugs.filter(s => !fsSlugs.has(s));
    if (stale.length > 0) {
      const txPurge = db.transaction(() => {
        for (const slug of stale) {
          db.prepare("DELETE FROM learnings WHERE slug = ?").run(slug);
          db.prepare("DELETE FROM learning_tags WHERE slug = ?").run(slug);
        }
      });
      txPurge();
      learningsPurged = stale.length;
    }
  }

  // 2. Rebuild files (sessions + knowledge)
  let filesCount = 0;
  let filesSkipped = 0;

  const fileDirs = ["memory/sessions", "knowledge"];
  const fileItems = [];

  for (const dir of fileDirs) {
    const fullDir = path.join(brainPath(), dir);
    if (!fs.existsSync(fullDir)) continue;

    (function walk(d, depth) {
      if (depth > 10) return;
      for (const f of fs.readdirSync(d)) {
        const fp = path.join(d, f);
        let stat;
        try { stat = fs.lstatSync(fp); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) { walk(fp, depth + 1); continue; }
        if (f.endsWith(".md") && !f.startsWith("_")) {
          const content = fs.readFileSync(fp, "utf-8");
          const relPath = normPath(fp).replace(normPath(brainPath()) + "/", "");
          fileItems.push({ relPath, content });
        }
      }
    })(fullDir, 0);
  }

  const txFiles = db.transaction(() => {
    for (const item of fileItems) {
      const changed = syncFile(db, item.relPath, item.content);
      if (changed) filesCount++;
      else filesSkipped++;
    }
  });
  txFiles();

  // 3. Rebuild graph
  try {
    const relationsRaw = fs.readFileSync(path.join(brainPath(), "relations.json"), "utf-8");
    const relations = JSON.parse(relationsRaw);
    syncGraphFromJson(db, relations);
  } catch { /* no relations.json, skip */ }

  // 3b. Import metrics.json into metrics table (P14.1 Phase 0)
  try {
    const metricsRaw = fs.readFileSync(path.join(brainPath(), "metrics.json"), "utf-8");
    const metricsData = JSON.parse(metricsRaw);
    const upsertMetric = db.prepare(
      "INSERT OR REPLACE INTO metrics (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    );
    const txMetrics = db.transaction(() => {
      for (const [k, v] of Object.entries(metricsData)) {
        upsertMetric.run(k, typeof v === "string" ? v : JSON.stringify(v));
      }
    });
    txMetrics();
  } catch { /* no metrics.json, skip */ }

  // 4. Update meta
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('last_rebuild', ?)").run(now);
  db.prepare("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('rebuild_stats', ?)").run(
    JSON.stringify({ learningsCount, learningsSkipped, learningsPurged, filesCount, filesSkipped })
  );

  _dbDirty = false;
  const elapsed = performance.now() - t0;

  if (learningsPurged > 0) {
    console.error(`SQLite: purged ${learningsPurged} stale learnings (file deleted)`);
  }

  return {
    learnings: { indexed: learningsCount, skipped: learningsSkipped, purged: learningsPurged },
    files: { indexed: filesCount, skipped: filesSkipped },
    elapsed: +elapsed.toFixed(1)
  };
}

// ─── Search: FTS5 ───────────────────────────────────────────────────────────

export function searchLearningsFts(queryTokens, { limit = 50, offset = 0, includeArchived = false } = {}) {
  const db = getDb();
  if (!db) return null;

  const ftsQuery = sanitizeFtsQuery(queryTokens);
  if (!ftsQuery) return [];

  // Also add stemmed variants to query for Catalan coverage
  const stemmedTokens = [];
  for (const t of queryTokens) {
    const s = stem(t);
    if (s !== t && s.length >= 3) stemmedTokens.push(s);
  }
  const allTokens = [...queryTokens, ...stemmedTokens];
  const fullQuery = sanitizeFtsQuery(allTokens);

  const archivedFilter = includeArchived ? "" : "AND l.archived = 0";

  try {
    const rows = db.prepare(`
      SELECT l.slug, l.title, l.headline, l.type, l.body, l.tags_json,
             l.project, l.domain, l.created, l.file, l.hit_count,
             l.created_date, l.last_accessed, l.stale, l.archived,
             l.vitality, l.vitality_zone,
             bm25(learnings_fts, ${FTS_WEIGHTS_LEARNINGS}) AS bm25_score
      FROM learnings_fts
      JOIN learnings l ON l.rowid = learnings_fts.rowid
      WHERE learnings_fts MATCH ?
        ${archivedFilter}
      ORDER BY bm25_score
      LIMIT ? OFFSET ?
    `).all(fullQuery, limit, offset);

    return rows.map(r => ({
      slug: r.slug,
      title: stripFtsPrep(r.title),
      headline: stripFtsPrep(r.headline),
      type: r.type,
      body: stripFtsPrep(r.body),
      tags: r.tags_json ? r.tags_json.split(" ").filter(Boolean) : [],
      project: r.project,
      domain: r.domain,
      created: r.created,
      file: r.file,
      hit_count: r.hit_count,
      created_date: r.created_date,
      last_accessed: r.last_accessed,
      stale: !!r.stale,
      archived: !!r.archived,
      vitality: r.vitality,
      vitality_zone: r.vitality_zone,
      bm25Score: -r.bm25_score // FTS5 bm25() returns negative (lower = better)
    }));
  } catch (e) {
    // FTS5 query syntax error — return empty
    console.error(`FTS5 learnings search error: ${e.message}`);
    return [];
  }
}

export function searchFilesFts(queryTokens, { limit = 20, offset = 0, scope = "all" } = {}) {
  const db = getDb();
  if (!db) return null;

  const ftsQuery = sanitizeFtsQuery(queryTokens);
  if (!ftsQuery) return [];

  const stemmedTokens = [];
  for (const t of queryTokens) {
    const s = stem(t);
    if (s !== t && s.length >= 3) stemmedTokens.push(s);
  }
  const fullQuery = sanitizeFtsQuery([...queryTokens, ...stemmedTokens]);

  let pathFilter = "";
  if (scope === "sessions") pathFilter = "AND f.rel_path LIKE 'memory/sessions/%'";
  else if (scope === "knowledge") pathFilter = "AND f.rel_path LIKE 'knowledge/%'";
  else if (scope === "notes") pathFilter = "AND f.rel_path LIKE 'memory/notes/%'";

  try {
    const rows = db.prepare(`
      SELECT f.rel_path, f.content,
             bm25(files_fts, ${FTS_WEIGHTS_FILES}) AS bm25_score
      FROM files_fts
      JOIN files f ON f.rowid = files_fts.rowid
      WHERE files_fts MATCH ?
        ${pathFilter}
      ORDER BY bm25_score
      LIMIT ? OFFSET ?
    `).all(fullQuery, limit, offset);

    return rows.map(r => ({
      relPath: r.rel_path,
      content: r.content,
      bm25Score: -r.bm25_score
    }));
  } catch (e) {
    console.error(`FTS5 files search error: ${e.message}`);
    return [];
  }
}

// ─── Read: learnings from DB ────────────────────────────────────────────────

export function getAllLearningsFromDb({ includeArchived = false } = {}) {
  const db = getDb();
  if (!db) return null;

  const filter = includeArchived ? "" : "WHERE archived = 0 AND stale = 0";

  const rows = db.prepare(`
    SELECT slug, title, headline, type, body, tags_json,
           project, domain, created, file,
           hit_count, created_date, last_accessed, stale, archived,
           vitality, vitality_zone
    FROM learnings ${filter}
  `).all();

  return rows.map(r => ({
    slug: r.slug,
    title: stripFtsPrep(r.title),
    headline: stripFtsPrep(r.headline),
    type: r.type,
    body: stripFtsPrep(r.body),
    tags: r.tags_json ? r.tags_json.split(" ").filter(Boolean) : [],
    project: r.project,
    domain: r.domain,
    created: r.created,
    file: r.file
  }));
}

export function getLearningsByTagsFromDb(tags, type = null) {
  const db = getDb();
  if (!db) return null;

  const normalizedTags = tags.map(sanitizeTag);
  const placeholders = normalizedTags.map(() => "?").join(", ");
  const typeFilter = type ? "AND l.type = ?" : "";

  const params = [...normalizedTags];
  if (type) params.push(type);

  const rows = db.prepare(`
    SELECT DISTINCT l.slug, l.title, l.headline, l.type, l.body, l.tags_json,
           l.project, l.domain, l.created, l.file,
           l.vitality, l.vitality_zone
    FROM learnings l
    JOIN learning_tags lt ON l.slug = lt.slug
    WHERE lt.tag IN (${placeholders})
      AND l.archived = 0
      ${typeFilter}
  `).all(...params);

  return rows.map(r => ({
    slug: r.slug,
    title: stripFtsPrep(r.title),
    headline: stripFtsPrep(r.headline),
    type: r.type,
    body: stripFtsPrep(r.body),
    tags: r.tags_json ? r.tags_json.split(" ").filter(Boolean) : [],
    project: r.project,
    domain: r.domain,
    created: r.created,
    file: r.file
  }));
}

export function getVitalityMapFromDb() {
  const db = getDb();
  if (!db) return null;

  const rows = db.prepare(
    "SELECT slug, vitality, vitality_zone, hit_count FROM learnings"
  ).all();

  const map = new Map();
  for (const r of rows) {
    map.set(r.slug, {
      vitality: r.vitality,
      zone: r.vitality_zone,
      accessCount: r.hit_count
    });
  }
  return map;
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export function getDbStats() {
  const db = getDb();
  if (!db) return null;

  const dbPath = path.join(brainPath(), DB_FILENAME);
  let sizeBytes = 0;
  // WAL mode: total size = main + wal + shm
  for (const suffix of ["", "-wal", "-shm"]) {
    try { sizeBytes += fs.statSync(dbPath + suffix).size; } catch { /* */ }
  }

  const learningsTotal = db.prepare("SELECT COUNT(*) as c FROM learnings").get().c;
  const learningsActive = db.prepare("SELECT COUNT(*) as c FROM learnings WHERE archived = 0 AND stale = 0").get().c;
  const filesTotal = db.prepare("SELECT COUNT(*) as c FROM files").get().c;
  const conceptsTotal = db.prepare("SELECT COUNT(*) as c FROM concepts").get().c;
  const edgesTotal = db.prepare("SELECT COUNT(*) as c FROM concept_edges").get().c;

  const lastRebuild = db.prepare("SELECT value FROM db_meta WHERE key = 'last_rebuild'").get();
  const rebuildStats = db.prepare("SELECT value FROM db_meta WHERE key = 'rebuild_stats'").get();

  return {
    sizeBytes,
    sizeMB: +(sizeBytes / 1024 / 1024).toFixed(2),
    schemaVersion: CURRENT_SCHEMA,
    learnings: { total: learningsTotal, active: learningsActive },
    files: filesTotal,
    graph: { concepts: conceptsTotal, edges: edgesTotal },
    lastRebuild: lastRebuild?.value || null,
    rebuildStats: rebuildStats ? JSON.parse(rebuildStats.value) : null
  };
}

export function checkFtsIntegrity() {
  const db = getDb();
  if (!db) return null;

  try {
    db.prepare("INSERT INTO learnings_fts(learnings_fts) VALUES('integrity-check')").run();
    db.prepare("INSERT INTO files_fts(files_fts) VALUES('integrity-check')").run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Spreading Activation (P4.6) ──────────────────────────────────────────

/**
 * Additive migration: create concept_activations table if it doesn't exist.
 * This table is NOT part of the schema version (not dropped during rebuild)
 * because activations are accumulated state, not derived from filesystem.
 */
function ensureActivationsTable(db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='concept_activations'"
  ).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE concept_activations (
        concept TEXT PRIMARY KEY,
        activation REAL DEFAULT 0,
        last_updated TEXT
      )
    `);
  }
}

export function getAllActivationsFromDb() {
  const db = getDb();
  if (!db) return null;

  const rows = db.prepare(
    "SELECT concept, activation, last_updated FROM concept_activations WHERE activation > 0.01"
  ).all();

  const map = new Map();
  for (const row of rows) {
    map.set(row.concept, { activation: row.activation, lastUpdated: row.last_updated });
  }
  return map;
}

export function saveActivationsToDb(activations) {
  const db = getDb();
  if (!db) return;

  const now = new Date().toISOString();
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO concept_activations (concept, activation, last_updated) VALUES (?, ?, ?)"
  );
  const del = db.prepare("DELETE FROM concept_activations WHERE concept = ?");

  const tx = db.transaction(() => {
    for (const [concept, score] of activations) {
      if (score > 0.01) {
        upsert.run(concept, score, now);
      } else {
        del.run(concept);
      }
    }
  });
  tx();
}

export function getActivationStatsFromDb() {
  const db = getDb();
  if (!db) return null;

  const total = db.prepare("SELECT COUNT(*) as c FROM concept_activations WHERE activation > 0.01").get()?.c || 0;
  const top = db.prepare(
    "SELECT concept, activation FROM concept_activations WHERE activation > 0.01 ORDER BY activation DESC LIMIT 10"
  ).all();

  return { total, top: top.map(r => ({ concept: r.concept, activation: +r.activation.toFixed(3) })) };
}

// ─── Embeddings table (P9.2) ────────────────────────────────────────────────

/**
 * Additive migration: create learning_embeddings table if it doesn't exist.
 * Stores precomputed embedding vectors as BLOBs.
 * Not part of schema version — survives rebuilds (embeddings are expensive to recompute).
 */
function ensureEmbeddingsTable(db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='learning_embeddings'"
  ).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE learning_embeddings (
        slug TEXT PRIMARY KEY,
        embedding BLOB,
        content_hash TEXT,
        model_id TEXT DEFAULT 'paraphrase-multilingual-MiniLM-L12-v2'
      )
    `);
  }
}

/** Save a single learning embedding. */
export function syncLearningEmbedding(slug, embeddingBlob, contentHash, modelId) {
  const db = getDb();
  if (!db) return;
  db.prepare(
    "INSERT OR REPLACE INTO learning_embeddings (slug, embedding, content_hash, model_id) VALUES (?, ?, ?, ?)"
  ).run(slug, embeddingBlob, contentHash, modelId);
}

/** Save multiple learning embeddings in a single transaction. */
export function syncLearningEmbeddingsBatch(entries) {
  const db = getDb();
  if (!db) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO learning_embeddings (slug, embedding, content_hash, model_id) VALUES (?, ?, ?, ?)"
  );
  const tx = db.transaction(() => {
    for (const { slug, embeddingBlob, contentHash, modelId } of entries) {
      stmt.run(slug, embeddingBlob, contentHash, modelId);
    }
  });
  tx();
}

/** Load all embeddings from DB. Returns Map<slug, {embedding: Buffer, contentHash, modelId}> or null. */
export function loadAllEmbeddings() {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = db.prepare("SELECT slug, embedding, content_hash, model_id FROM learning_embeddings").all();
    const map = new Map();
    for (const row of rows) {
      map.set(row.slug, { embedding: row.embedding, contentHash: row.content_hash, modelId: row.model_id });
    }
    return map;
  } catch { return null; }
}

/** Delete embedding for a slug. */
export function deleteLearningEmbedding(slug) {
  const db = getDb();
  if (!db) return;
  db.prepare("DELETE FROM learning_embeddings WHERE slug = ?").run(slug);
}

/** Get embedding stats for brain_health. */
export function getEmbeddingDbStats() {
  const db = getDb();
  if (!db) return null;
  try {
    const total = db.prepare("SELECT COUNT(*) as c FROM learning_embeddings").get()?.c || 0;
    const models = db.prepare("SELECT model_id, COUNT(*) as c FROM learning_embeddings GROUP BY model_id").all();
    return { total, models: models.map(r => ({ model: r.model_id, count: r.c })) };
  } catch { return null; }
}

// ─── Helper: strip FTS preparation artifacts ────────────────────────────────
// prepareForFts appends stemmed tokens to text. When reading back from DB,
// we don't strip them (they're harmless for display and would be expensive
// to detect). The original text is always at the start.

function stripFtsPrep(text) {
  return text || "";
}

// ─── P14.1 DAL: Meta Repository ──────────────────────────────────────────────
// Centralized data access for learnings-meta fields.
// Phase 0: reads from SQLite (synced from JSON), writes dual-write (JSON + SQLite).
// Phase 1: reads SQLite-only. Phase 2: writes SQLite-only.

function _rowToMeta(row) {
  if (!row) return null;
  return {
    hit_count: row.hit_count || 0,
    last_accessed: row.last_accessed,
    search_appearances: row.search_appearances || 0,
    search_followup_hits: row.search_followup_hits || 0,
    confirmation_count: row.confirmation_count || 0,
    last_confirmed: row.last_confirmed,
    vitality: row.vitality ?? 0.5,
    vitality_zone: row.vitality_zone || "active",
    vitality_updated: row.vitality_updated,
    stale: !!row.stale,
    archived: !!row.archived,
    archived_at: row.archived_at,
    archived_by: row.archived_by,
    source: row.source || "agent",
    subsumes: row.subsumes_json ? JSON.parse(row.subsumes_json) : undefined,
    superseded_by: row.superseded_by,
    merge_count: row.merge_count || 0,
    // P15.2: Feedback fields
    feedback_hits: row.feedback_hits || 0,
    feedback_misses: row.feedback_misses || 0,
    feedback_appearances: row.feedback_appearances || 0,
    feedback_last_hit: row.feedback_last_hit || null,
    created_date: row.created_date,
    file: row.file,
    title: row.title,
    type: row.type,
    tags: row.tags_json ? row.tags_json.split(" ").filter(Boolean) : [],
  };
}

const META_SELECT = `SELECT slug, hit_count, last_accessed, search_appearances, search_followup_hits,
  confirmation_count, last_confirmed, vitality, vitality_zone,
  vitality_updated, stale, archived, archived_at, archived_by,
  source, subsumes_json, superseded_by, merge_count,
  feedback_hits, feedback_misses, feedback_appearances, feedback_last_hit,
  created_date, file, title, type, tags_json
  FROM learnings`;

export const metaRepo = {
  /** Get meta for a single slug. Returns null if not found or DB unavailable. */
  get(slug) {
    const db = getDb();
    if (!db) return null;
    return _rowToMeta(db.prepare(`${META_SELECT} WHERE slug = ?`).get(slug));
  },

  /** Get meta for multiple slugs. Returns Map<slug, meta>. */
  batchGet(slugs) {
    const db = getDb();
    if (!db) return null;
    const map = new Map();
    const stmt = db.prepare(`${META_SELECT} WHERE slug = ?`);
    for (const slug of slugs) {
      const row = stmt.get(slug);
      if (row) map.set(slug, _rowToMeta(row));
    }
    return map;
  },

  /** Get all meta entries. Returns object { slug: meta } or null. */
  getAll() {
    const db = getDb();
    if (!db) return null;
    const rows = db.prepare(META_SELECT).all();
    const result = {};
    for (const row of rows) result[row.slug] = _rowToMeta(row);
    return result;
  },

  /** Update specific meta fields for a slug. Writes to SQLite only. */
  update(slug, fields) {
    const db = getDb();
    if (!db) return false;
    const allowed = [
      "hit_count", "last_accessed", "search_appearances", "search_followup_hits",
      "confirmation_count", "last_confirmed", "vitality", "vitality_zone",
      "vitality_updated", "stale", "archived", "archived_at", "archived_by",
      "source", "subsumes_json", "superseded_by", "merge_count",
      "feedback_hits", "feedback_misses", "feedback_appearances", "feedback_last_hit"
    ];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (sets.length === 0) return false;
    vals.push(slug);
    db.prepare(`UPDATE learnings SET ${sets.join(", ")} WHERE slug = ?`).run(...vals);
    return true;
  },

  /** Upsert meta-only fields (for dual-write from _flushMeta). 
   *  If the slug exists in DB, updates meta fields.
   *  If it doesn't exist, inserts a minimal row so SQLite reads stay consistent.
   */
  upsertMeta(slug, meta) {
    const db = getDb();
    if (!db) return false;
    const existing = db.prepare("SELECT slug FROM learnings WHERE slug = ?").get(slug);
    if (existing) {
      // Update existing row
      syncLearningMeta(db, slug, meta);
    } else {
      // Insert minimal row — content/FTS will be filled by next rebuildFullIndex or syncLearning
      db.prepare(`
        INSERT OR IGNORE INTO learnings (
          slug, title, headline, type, body, tags_json, file, content_hash,
          hit_count, created_date, last_accessed, stale, archived,
          vitality, vitality_zone, search_appearances, search_followup_hits,
          confirmation_count, last_confirmed, source, subsumes_json,
          superseded_by, merge_count, vitality_updated, archived_at, archived_by
        ) VALUES (
          @slug, @title, '', @type, '', @tags_json, @file, '',
          @hit_count, @created_date, @last_accessed, @stale, @archived,
          @vitality, @vitality_zone, @search_appearances, @search_followup_hits,
          @confirmation_count, @last_confirmed, @source, @subsumes_json,
          @superseded_by, @merge_count, @vitality_updated, @archived_at, @archived_by
        )
      `).run({
        slug,
        title: meta.title || "",
        type: meta.type || "learning",
        tags_json: (meta.tags || []).join(" "),
        file: meta.file || `memory/learnings/${slug}.md`,
        hit_count: meta.hit_count || 0,
        created_date: meta.created_date || null,
        last_accessed: meta.last_accessed || null,
        stale: meta.stale ? 1 : 0,
        archived: meta.archived ? 1 : 0,
        vitality: meta.vitality ?? 0.5,
        vitality_zone: meta.vitality_zone || "active",
        search_appearances: meta.search_appearances || 0,
        search_followup_hits: meta.search_followup_hits || 0,
        confirmation_count: meta.confirmation_count || 0,
        last_confirmed: meta.last_confirmed || null,
        source: meta.source || "agent",
        subsumes_json: meta.subsumes ? JSON.stringify(meta.subsumes) : null,
        superseded_by: meta.superseded_by || null,
        merge_count: meta.merge_count || 0,
        vitality_updated: meta.vitality_updated || null,
        archived_at: meta.archived_at || null,
        archived_by: meta.archived_by || null,
      });
    }
    return true;
  },

  /** Increment a numeric meta field atomically. */
  increment(slug, field, amount = 1) {
    const db = getDb();
    if (!db) return false;
    const allowed = ["hit_count", "search_appearances", "search_followup_hits", "confirmation_count", "merge_count"];
    if (!allowed.includes(field)) return false;
    db.prepare(`UPDATE learnings SET ${field} = COALESCE(${field}, 0) + ? WHERE slug = ?`).run(amount, slug);
    return true;
  },
};

// ─── P14.1 DAL: Metrics Repository ──────────────────────────────────────────

export const metricsRepo = {
  /** Get a single metric value. Returns parsed JSON or raw string. */
  get(key) {
    const db = getDb();
    if (!db) return null;
    const row = db.prepare("SELECT value FROM metrics WHERE key = ?").get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  },

  /** Set a metric value (auto-serializes objects). */
  set(key, value) {
    const db = getDb();
    if (!db) return false;
    const v = typeof value === "string" ? value : JSON.stringify(value);
    db.prepare(
      "INSERT OR REPLACE INTO metrics (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(key, v);
    return true;
  },

  /** Get all metrics as { key: value }. */
  getAll() {
    const db = getDb();
    if (!db) return null;
    const rows = db.prepare("SELECT key, value FROM metrics").all();
    const result = {};
    for (const r of rows) {
      try { result[r.key] = JSON.parse(r.value); } catch { result[r.key] = r.value; }
    }
    return result;
  },
};

// ─── P14.1 DAL: Graph Repository ────────────────────────────────────────────

export const graphRepo = {
  /** Get neighbors of a single concept. Returns string[] or null. */
  getNeighbors(concept) {
    const db = getDb();
    if (!db) return null;
    const norm = concept.toLowerCase().replace("#", "");
    // Get parent from concepts table
    const conceptRow = db.prepare("SELECT parent FROM concepts WHERE name = ?").get(norm);
    // Get all edges (both directions: source=concept OR target=concept)
    const edges = db.prepare(
      "SELECT source, target FROM concept_edges WHERE source = ? OR target = ?"
    ).all(norm, norm);
    const neighbors = new Set();
    for (const e of edges) {
      if (e.source === norm) neighbors.add(e.target);
      else neighbors.add(e.source);
    }
    if (conceptRow?.parent) neighbors.add(conceptRow.parent);
    // Get children
    const children = db.prepare("SELECT name FROM concepts WHERE parent = ?").all(norm);
    for (const c of children) neighbors.add(c.name);
    return [...neighbors];
  },

  /** Get neighbors for multiple concepts (batch). Returns Map<concept, string[]>. */
  batchGetNeighbors(concepts) {
    const db = getDb();
    if (!db) return null;
    const map = new Map();
    const edgeStmt = db.prepare(
      "SELECT source, target FROM concept_edges WHERE source = ? OR target = ?"
    );
    const parentStmt = db.prepare("SELECT parent FROM concepts WHERE name = ?");
    const childStmt = db.prepare("SELECT name FROM concepts WHERE parent = ?");
    for (const concept of concepts) {
      const norm = concept.toLowerCase().replace("#", "");
      const neighbors = new Set();
      for (const e of edgeStmt.all(norm, norm)) {
        if (e.source === norm) neighbors.add(e.target);
        else neighbors.add(e.source);
      }
      const conceptRow = parentStmt.get(norm);
      if (conceptRow?.parent) neighbors.add(conceptRow.parent);
      for (const c of childStmt.all(norm)) neighbors.add(c.name);
      map.set(norm, [...neighbors]);
    }
    return map;
  },

  /** Rebuild full relations object from SQLite. Returns { concepts: { name: { related_to, parent, children } } }. */
  getFullGraph() {
    const db = getDb();
    if (!db) return null;
    const concepts = {};
    // Load all concepts
    for (const row of db.prepare("SELECT name, parent FROM concepts").all()) {
      concepts[row.name] = { related_to: [], parent: row.parent || undefined, children: [] };
    }
    // Load all edges
    for (const e of db.prepare("SELECT source, target FROM concept_edges WHERE type = 'related_to'").all()) {
      if (concepts[e.source]) concepts[e.source].related_to.push(e.target);
    }
    // Compute children from parent refs
    for (const [name, data] of Object.entries(concepts)) {
      if (data.parent && concepts[data.parent]) {
        concepts[data.parent].children.push(name);
      }
    }
    // Clean up empty arrays for compat
    for (const data of Object.values(concepts)) {
      if (data.children.length === 0) delete data.children;
      if (!data.parent) delete data.parent;
    }
    return { concepts };
  },

  /** Get concept count. */
  count() {
    const db = getDb();
    if (!db) return 0;
    return db.prepare("SELECT COUNT(*) as c FROM concepts").get()?.c || 0;
  },

  /** Get edge count. */
  edgeCount() {
    const db = getDb();
    if (!db) return 0;
    return db.prepare("SELECT COUNT(*) as c FROM concept_edges").get()?.c || 0;
  },
};

// ─── P14.1 DAL: Change Log ──────────────────────────────────────────────────

export const changeLog = {
  /** Append a change entry. */
  append(entityType, entityId, op, payloadJson = null) {
    const db = getDb();
    if (!db) return;
    const machineId = process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown";
    db.prepare(
      "INSERT INTO change_log (entity_type, entity_id, op, payload_json, machine_id) VALUES (?, ?, ?, ?, ?)"
    ).run(entityType, entityId, op, payloadJson, machineId);
  },

  /** Get recent changes. */
  recent(limit = 50) {
    const db = getDb();
    if (!db) return [];
    return db.prepare("SELECT * FROM change_log ORDER BY seq DESC LIMIT ?").all(limit);
  },

  /** Count changes by type. */
  stats() {
    const db = getDb();
    if (!db) return null;
    return db.prepare(
      "SELECT entity_type, op, COUNT(*) as count FROM change_log GROUP BY entity_type, op"
    ).all();
  },
};

// ─── P14.1 DAL: Export State ────────────────────────────────────────────────

export const exportState = {
  /** Check if entity needs re-export. */
  needsExport(entityType, entityId, currentHash) {
    const db = getDb();
    if (!db) return true;
    const row = db.prepare(
      "SELECT last_exported_hash FROM export_state WHERE entity_type = ? AND entity_id = ?"
    ).get(entityType, entityId);
    return !row || row.last_exported_hash !== currentHash;
  },

  /** Mark entity as exported. */
  markExported(entityType, entityId, hash, exportPath) {
    const db = getDb();
    if (!db) return;
    db.prepare(
      `INSERT OR REPLACE INTO export_state (entity_type, entity_id, last_exported_hash, last_exported_at, export_path)
       VALUES (?, ?, ?, datetime('now'), ?)`
    ).run(entityType, entityId, hash, exportPath);
  },
};
