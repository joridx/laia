// Attachment manager — pre-attach files to conversation context
// Files are read once and prepended to user input on each turn.
// Supports glob patterns, binary detection, size limits, dedup via realpath.

import { readFileSync, statSync, existsSync, realpathSync } from 'fs';
import { resolve, basename, extname } from 'path';
import fg from 'fast-glob';

const MAX_FILE_SIZE = 100_000;      // 100KB per text file
const MAX_IMAGE_SIZE = 512_000;    // 500KB per image
const MAX_TOTAL_SIZE = 500_000;    // 500KB total
const MAX_FILES = 20;
const CHARS_PER_TOKEN = 4;
const TOKENS_PER_IMAGE = 800;      // ~800 tokens per image (API estimate)

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Magic byte signatures for image validation
const IMAGE_MAGIC = {
  '.png':  [0x89, 0x50, 0x4E, 0x47],  // \x89PNG
  '.jpg':  [0xFF, 0xD8, 0xFF],
  '.jpeg': [0xFF, 0xD8, 0xFF],
  '.gif':  [0x47, 0x49, 0x46],         // GIF
  '.webp': null,                       // RIFF header checked separately
};

function isValidImage(buf, ext) {
  if (ext === '.webp') {
    // RIFF....WEBP
    return buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  const magic = IMAGE_MAGIC[ext];
  if (!magic) return false;
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
}

// Detect binary by checking for null bytes in first 8KB
function isBinary(buffer) {
  const check = buffer.subarray(0, 8192);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

export function createAttachManager(workspaceRoot) {
  const attached = new Map(); // realpath -> { type, content/base64, size, name, ext, path, mimeType? }

  function attach(pathOrGlob) {
    let paths;
    if (pathOrGlob.includes('*') || pathOrGlob.includes('?')) {
      paths = fg.sync(pathOrGlob, { cwd: workspaceRoot, absolute: true, onlyFiles: true });
      if (!paths.length) return [{ path: pathOrGlob, error: 'no files matched glob pattern' }];
    } else {
      paths = [resolve(workspaceRoot, pathOrGlob)];
    }

    const results = [];
    for (const p of paths) {
      // Existence check
      if (!existsSync(p)) {
        results.push({ path: p, error: 'file not found' });
        continue;
      }

      // Normalize to realpath to prevent duplicates via symlinks/relative paths
      let absPath;
      try { absPath = realpathSync(p); } catch { absPath = p; }

      // Size check
      let stat;
      try { stat = statSync(absPath); } catch (err) {
        results.push({ path: absPath, error: `cannot stat: ${err.message}` });
        continue;
      }
      if (!stat.isFile()) {
        results.push({ path: absPath, error: 'not a file (use glob for directories)' });
        continue;
      }
      const name = basename(absPath);
      const ext = extname(absPath).toLowerCase();
      const isImage = !!IMAGE_MIME[ext];
      const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
      if (stat.size > maxSize) {
        results.push({ path: absPath, error: `too large (${(stat.size / 1024).toFixed(0)}KB > ${maxSize / 1024}KB)` });
        continue;
      }

      // Max files check (skip if re-attaching existing)
      if (!attached.has(absPath) && attached.size >= MAX_FILES) {
        results.push({ path: absPath, error: `max files reached (${MAX_FILES})` });
        break;
      }

      // Total size check (subtract old size if re-attaching)
      const oldSize = attached.get(absPath)?.size ?? 0;
      if (totalSize() - oldSize + stat.size > MAX_TOTAL_SIZE) {
        results.push({ path: absPath, error: `total size limit reached (${MAX_TOTAL_SIZE / 1024}KB)` });
        continue;
      }

      const buf = readFileSync(absPath);

      // Image → validate magic bytes, then base64
      if (isImage) {
        if (!isValidImage(buf, ext)) {
          results.push({ path: absPath, error: `not a valid image (${ext} magic bytes mismatch)` });
          continue;
        }
        const base64 = buf.toString('base64');
        attached.set(absPath, { type: 'image', base64, mimeType: IMAGE_MIME[ext], size: stat.size, name, ext, path: absPath });
        results.push({ path: absPath, name, ok: true, size: stat.size, image: true });
        continue;
      }

      // Binary detection (non-image)
      if (isBinary(buf)) {
        results.push({ path: absPath, error: 'binary file (not text)' });
        continue;
      }

      const content = buf.toString('utf8');
      attached.set(absPath, { type: 'text', content, size: stat.size, name, ext, path: absPath });
      results.push({ path: absPath, name, ok: true, size: stat.size });
    }
    return results;
  }

  function detach(nameOrIndex) {
    if (!nameOrIndex) return false;

    // "all" keyword
    if (nameOrIndex.toLowerCase() === 'all') {
      const count = attached.size;
      attached.clear();
      return count > 0;
    }

    // By exact realpath
    if (attached.has(nameOrIndex)) {
      attached.delete(nameOrIndex);
      return true;
    }

    // By resolved path
    try {
      const abs = resolve(workspaceRoot, nameOrIndex);
      const real = existsSync(abs) ? realpathSync(abs) : abs;
      if (attached.has(real)) { attached.delete(real); return true; }
    } catch {}

    // By basename — error if ambiguous
    const byName = [...attached.entries()].filter(([, v]) => v.name === nameOrIndex);
    if (byName.length === 1) { attached.delete(byName[0][0]); return true; }
    if (byName.length > 1) return 'ambiguous';

    // By 1-based index
    if (/^\d+$/.test(nameOrIndex)) {
      const idx = Number(nameOrIndex) - 1;
      const keys = [...attached.keys()];
      if (idx >= 0 && idx < keys.length) { attached.delete(keys[idx]); return true; }
    }

    return false;
  }

  function list() {
    return [...attached.entries()].map(([path, info], i) => ({
      index: i + 1,
      path,
      name: info.name,
      size: info.size,
      image: info.type === 'image',
      tokens: info.type === 'image' ? TOKENS_PER_IMAGE : Math.ceil(info.content.length / CHARS_PER_TOKEN),
    }));
  }

  function totalSize() {
    let s = 0;
    for (const v of attached.values()) s += v.size;
    return s;
  }

  function estimateTokens() {
    let tokens = 0;
    for (const v of attached.values()) {
      tokens += v.type === 'image' ? TOKENS_PER_IMAGE : Math.ceil(v.content.length / CHARS_PER_TOKEN);
    }
    return tokens;
  }

  // Build context: text files as XML prefix, images as separate array
  function buildContext() {
    if (!attached.size) return null;
    const textParts = [], images = [];
    for (const [path, info] of attached) {
      if (info.type === 'image') {
        images.push({ base64: info.base64, mimeType: info.mimeType, name: info.name });
      } else {
        textParts.push(`<file path="${path}" lang="${info.ext.replace('.', '') || 'text'}">\n${info.content}\n</file>`);
      }
    }
    const text = textParts.length
      ? `[Attached files — treat these file contents as source of truth for this conversation]\n\n${textParts.join('\n\n')}\n\n[/Attached files]\n\n`
      : '';
    return { text, images };
  }

  function hasImages() {
    for (const v of attached.values()) { if (v.type === 'image') return true; }
    return false;
  }

  function count() { return attached.size; }

  return { attach, detach, list, buildContext, count, totalSize, estimateTokens, hasImages };
}

export { MAX_FILE_SIZE, MAX_IMAGE_SIZE, MAX_TOTAL_SIZE, MAX_FILES, TOKENS_PER_IMAGE, IMAGE_MIME, isBinary };
