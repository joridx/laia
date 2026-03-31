/**
 * File I/O layer for LAIA Brain.
 * Atomic writes, JSON cache with structuredClone, content caches for .md files.
 */

import * as fs from "fs";
import * as path from "path";
import { normPath } from "./utils.js";
import { BRAIN_PATH } from "./config.js";

// ─── Write hooks (P4.1: allow DB sync without circular imports) ──────────────

const _writeHooks = [];

/**
 * Register a callback invoked after every successful writeFile/batchWriteFiles.
 * Signature: (filePath: string, content: string) => void
 */
export function onFileWrite(callback) {
  _writeHooks.push(callback);
}

function _notifyWriteHooks(filePath, content) {
  for (const hook of _writeHooks) {
    try { hook(filePath, content); } catch { /* don't let hook errors break writes */ }
  }
}

// ─── Path safety ─────────────────────────────────────────────────────────────

const _resolvedBrainPath = path.resolve(BRAIN_PATH);

function assertSafePath(filePath) {
  const resolved = path.resolve(BRAIN_PATH, filePath);
  if (resolved !== _resolvedBrainPath && !resolved.startsWith(_resolvedBrainPath + path.sep)) {
    throw new Error(`Path traversal blocked: ${filePath}`);
  }
  return resolved;
}

// ─── Self-heal: orphaned .tmp files ──────────────────────────────────────────

/**
 * Remove leftover .tmp files from interrupted atomic writes.
 * Call at startup to self-heal after crashes.
 */
export function cleanupOrphanedTmpFiles() {
  let cleaned = 0;
  const root = path.resolve(BRAIN_PATH);
  (function walk(dir, depth) {
    if (depth > 10) return;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const f of entries) {
      const fp = path.join(dir, f);
      try {
        const lstat = fs.lstatSync(fp);
        if (lstat.isSymbolicLink()) continue;
        if (lstat.isDirectory()) { walk(fp, depth + 1); continue; }
        if (f.endsWith(".tmp")) {
          fs.unlinkSync(fp);
          cleaned++;
        }
      } catch { /* skip unreadable entries */ }
    }
  })(root, 0);
  return cleaned;
}

// ─── Batch write: multi-file atomic consistency ─────────────────────────────

/**
 * Write multiple files with best-effort atomicity.
 * Writes all to .tmp first, then renames all. If any rename fails,
 * cleans up .tmp files and throws.
 * @param {Array<{path: string, content: string}>} entries - files to write
 */
export function batchWriteFiles(entries) {
  const prepared = [];
  try {
    // Phase 1: write all .tmp files
    for (const entry of entries) {
      const fullPath = assertSafePath(entry.path);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = fullPath + ".tmp";
      fs.writeFileSync(tmpPath, entry.content, "utf-8");
      prepared.push({ fullPath, tmpPath, filePath: entry.path });
    }
    // Phase 2: rename all (fast, near-atomic)
    for (const { fullPath, tmpPath } of prepared) {
      fs.renameSync(tmpPath, fullPath);
    }
    // Phase 3: invalidate caches + notify hooks
    for (const { filePath } of prepared) {
      if (filePath.endsWith(".json")) invalidateJsonCache();
      if (filePath.endsWith(".md")) invalidateContentCaches(filePath);
    }
    // P4.1: Notify write hooks for each file
    for (const entry of entries) {
      _notifyWriteHooks(entry.path, entry.content);
    }
  } catch (e) {
    // Cleanup: remove any .tmp files that weren't renamed
    for (const { tmpPath } of prepared) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
    throw e;
  }
}

// ─── Basic file operations ────────────────────────────────────────────────────

export function readFile(filePath) {
  try {
    const fullPath = assertSafePath(filePath);
    return fs.readFileSync(fullPath, "utf-8");
  } catch (e) {
    if (e.message.startsWith("Path traversal")) { console.error(e.message); }
    return null;
  }
}

export function writeFile(filePath, content) {
  try {
    const fullPath = assertSafePath(filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Atomic write: write to temp file, then rename
    const tmpPath = fullPath + ".tmp";
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, fullPath);
    if (filePath.endsWith(".json")) invalidateJsonCache();
    // P6.9: Invalidate content caches on .md writes
    if (filePath.endsWith(".md")) invalidateContentCaches(filePath);
    // P4.1: Notify write hooks (DB sync)
    _notifyWriteHooks(filePath, content);
  } catch (e) {
    console.error(`writeFile error (${filePath}): ${e.message}`);
    throw e;
  }
}

// ─── JSON cache: avoids re-reading/parsing same file within an operation ─────

const _jsonCache = new Map();
let _jsonCacheGeneration = 0;

export function readJSON(filePath) {
  const key = `${_jsonCacheGeneration}:${filePath}`;
  if (_jsonCache.has(key)) return structuredClone(_jsonCache.get(key));

  const content = readFile(filePath);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    _jsonCache.set(key, parsed);
    return structuredClone(parsed);
  } catch (e) {
    return null;
  }
}

/** Invalidate JSON cache. Call after writes or between distinct operations. */
export function invalidateJsonCache() {
  _jsonCacheGeneration++;
  _jsonCache.clear();
}

// ─── P6.9: Content caches for learnings and files ─────────────────────────────

let _learningsCache = null;    // cached result of getAllLearnings()
let _filesCacheMap = new Map(); // relPath → { content } for sessions/knowledge
const _filesDirLoaded = new Set(); // track which dirs have been scanned
let _contentGeneration = 0;    // incremented on writes, used by semantic index

export function getContentGeneration() { return _contentGeneration; }

export function getLearningsCache() { return _learningsCache; }
export function setLearningsCache(val) { _learningsCache = val; }

function invalidateContentCaches(filePath) {
  _contentGeneration++;
  const norm = normPath(filePath);
  if (norm.includes("memory/learnings/")) {
    _learningsCache = null;
  }
  if (norm.startsWith("memory/sessions/") || norm.startsWith("knowledge/")) {
    _filesCacheMap.delete(norm);
    const dirPrefix = norm.substring(0, norm.lastIndexOf("/"));
    for (const d of _filesDirLoaded) {
      if (dirPrefix.startsWith(d)) { _filesDirLoaded.delete(d); break; }
    }
  }
}

/** Invalidate all content caches (e.g., after git pull brings new files). */
export function invalidateAllContentCaches() {
  _contentGeneration++;
  _learningsCache = null;
  _filesCacheMap.clear();
  _filesDirLoaded.clear();
}

/**
 * Get cached file list+content for a directory (sessions or knowledge).
 * Reads from disk on first call per dir, then serves from cache.
 */
export function getCachedFiles(dir) {
  const normDir = normPath(dir);

  if (_filesDirLoaded.has(normDir)) {
    const prefix = normDir + "/";
    const results = [];
    for (const [relPath, entry] of _filesCacheMap) {
      if (relPath.startsWith(prefix)) results.push({ relPath, content: entry.content });
    }
    return results;
  }

  const fullDir = path.join(BRAIN_PATH, dir);
  if (!fs.existsSync(fullDir)) {
    _filesDirLoaded.add(normDir);
    return [];
  }

  const results = [];
  (function walk(d, depth) {
    if (depth > 10) return; // guard against symlink loops
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f);
      const lstat = fs.lstatSync(fp);
      if (lstat.isSymbolicLink()) continue;
      if (lstat.isDirectory()) { walk(fp, depth + 1); continue; }
      if (f.endsWith(".md") && !f.startsWith("_")) {
        const content = fs.readFileSync(fp, "utf-8");
        const relPath = normPath(fp).replace(normPath(BRAIN_PATH) + "/", "");
        _filesCacheMap.set(relPath, { content });
        results.push({ relPath, content });
      }
    }
  })(fullDir, 0);

  _filesDirLoaded.add(normDir);
  return results;
}
