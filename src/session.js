// Session persistence — save/load conversation context between REPL sessions
// No external dependencies. Stores sessions as versioned JSON in ~/.claudia/sessions/

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'fs';
import { join, sep } from 'path';
import { homedir, tmpdir } from 'os';
import { randomBytes } from 'crypto';

const SESSIONS_DIR = join(homedir(), '.claudia', 'sessions');
const AUTOSAVE_FILE = '_autosave.json';
const VERSION = 1;
const MAX_SESSION_NAME_LEN = 64;
const APP_VERSION = '0.1.0';

function ensureDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Sanitize user-provided session name
function sanitizeName(name) {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, MAX_SESSION_NAME_LEN);
}

// Atomic write: write to temp file then rename (avoids corruption on crash)
function atomicWrite(filepath, data) {
  const tmp = join(tmpdir(), `claudia_session_${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filepath);
}

function buildEnvelope(serialized, metadata = {}) {
  return {
    version: VERSION,
    appVersion: APP_VERSION,
    createdAt: metadata.createdAt || new Date().toISOString(),
    savedAt: new Date().toISOString(),
    sessionId: metadata.sessionId || randomBytes(8).toString('hex'),
    model: metadata.model,
    workspaceRoot: metadata.workspaceRoot,
    ...serialized,
  };
}

// --- Public API ---

export function saveSession(serialized, metadata = {}) {
  ensureDir();
  const name = metadata.name ? sanitizeName(metadata.name) : '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = name ? `${ts}_${name}.json` : `${ts}.json`;
  const filepath = join(SESSIONS_DIR, filename);
  const data = buildEnvelope(serialized, metadata);
  atomicWrite(filepath, data);
  return filepath;
}

export function autoSave(serialized, metadata = {}) {
  ensureDir();
  const filepath = join(SESSIONS_DIR, AUTOSAVE_FILE);
  const data = buildEnvelope(serialized, metadata);
  atomicWrite(filepath, data);
  return filepath;
}

export function deleteAutoSave() {
  const filepath = join(SESSIONS_DIR, AUTOSAVE_FILE);
  try { unlinkSync(filepath); } catch {}
}

export function loadSession(nameOrIndex) {
  // Numeric index (from /sessions list, 1-based)
  if (typeof nameOrIndex === 'number' || /^\d+$/.test(nameOrIndex)) {
    const idx = Number(nameOrIndex) - 1;
    const files = listSessionFiles();
    if (idx < 0 || idx >= files.length) return null;
    return parseSessionFile(join(SESSIONS_DIR, files[idx]));
  }

  // Direct path (contains path separator)
  if (typeof nameOrIndex === 'string' && (nameOrIndex.includes(sep) || nameOrIndex.includes('/'))) {
    if (existsSync(nameOrIndex)) return parseSessionFile(nameOrIndex);
    return null;
  }

  // Search by partial name in sessions dir
  const files = listSessionFiles();
  const query = nameOrIndex.toLowerCase();

  // Priority: exact match > prefix > substring
  const exact = files.find(f => f.replace('.json', '').toLowerCase() === query);
  if (exact) return parseSessionFile(join(SESSIONS_DIR, exact));

  const prefixMatches = files.filter(f => f.toLowerCase().startsWith(query));
  if (prefixMatches.length === 1) return parseSessionFile(join(SESSIONS_DIR, prefixMatches[0]));

  const subMatches = files.filter(f => f.toLowerCase().includes(query));
  if (subMatches.length === 1) return parseSessionFile(join(SESSIONS_DIR, subMatches[0]));

  if (subMatches.length > 1) {
    return { error: 'ambiguous', candidates: subMatches.slice(0, 5) };
  }

  return null;
}

export function loadAutoSave() {
  const filepath = join(SESSIONS_DIR, AUTOSAVE_FILE);
  if (!existsSync(filepath)) return null;
  const data = parseSessionFile(filepath);
  if (data?.error === 'corrupt') {
    // Rename corrupt autosave
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    try { renameSync(filepath, join(SESSIONS_DIR, `_autosave.corrupt.${ts}.json`)); } catch {}
    return null;
  }
  return data;
}

export function listSessionFiles() {
  ensureDir();
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .reverse(); // newest first
}

export function listSessions(limit = 10) {
  const files = listSessionFiles().slice(0, limit);
  return files.map((f, i) => {
    try {
      const raw = readFileSync(join(SESSIONS_DIR, f), 'utf8');
      // Parse only needed fields without loading full turns content
      const data = JSON.parse(raw);
      return {
        index: i + 1,
        file: f,
        createdAt: data.createdAt ?? '?',
        turns: data.turns?.length ?? 0,
        model: data.model ?? '?',
      };
    } catch {
      return { index: i + 1, file: f, createdAt: '?', turns: 0, model: '?' };
    }
  });
}

// --- Internal ---

function parseSessionFile(filepath) {
  try {
    const raw = readFileSync(filepath, 'utf8');
    const data = JSON.parse(raw);
    // Version check
    if (data.version && data.version !== VERSION) {
      return { error: 'version', version: data.version, expected: VERSION };
    }
    // Validate required fields
    if (!Array.isArray(data.turns) || !Array.isArray(data.messages)) {
      return { error: 'invalid', message: 'Missing turns or messages arrays' };
    }
    return data;
  } catch (err) {
    return { error: 'corrupt', message: err.message };
  }
}

export { SESSIONS_DIR, AUTOSAVE_FILE, sanitizeName };
