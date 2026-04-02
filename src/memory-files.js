// LAIA.md memory hierarchy for LAIA
// Priority (lowest → highest): user → project → managed
// All files are optional. Contents are concatenated into the system prompt.

import { readFileSync, existsSync, realpathSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { homedir } from 'os';

const HOME = homedir();
const MAX_MEMORY_FILE_SIZE = 50_000; // 50KB per file
const MAX_TOTAL_MEMORY_SIZE = 100_000; // 100KB total
const INCLUDE_RE = /^@include\s+(.+)$/gm;
const MAX_INCLUDE_DEPTH = 3;

export function loadMemoryFiles({ workspaceRoot } = {}) {
  // V5: Allowed roots for @include security (only allow includes from these directories)
  const allowedRoots = [
    join(HOME, '.laia'),
    ...(workspaceRoot ? [workspaceRoot] : []),
  ];

  const candidates = [
    // User-level (lowest priority)
    { path: join(HOME, '.laia', 'LAIA.md'), level: 'user' },
    // Project-level
    ...(workspaceRoot ? [
      { path: join(workspaceRoot, 'LAIA.md'), level: 'project' },
      { path: join(workspaceRoot, '.laia', 'LAIA.md'), level: 'project' },
    ] : []),
    // Managed policy (highest priority — corporate, immutable by agent)
    { path: join(HOME, '.laia', 'LAIA-managed.md'), level: 'managed' },
  ];

  const loaded = [];
  const seen = new Set(); // dedupe by resolved path
  let totalSize = 0;
  for (const f of candidates) {
    if (existsSync(f.path)) {
      const resolved = join(f.path); // normalize
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      try {
        let content = readFileSync(f.path, 'utf8').trim();
        if (!content) continue;

        // V5: Resolve @include directives
        content = resolveIncludes(content, dirname(f.path), 0, new Set(), allowedRoots);

        if (content.length > MAX_MEMORY_FILE_SIZE) {
          loaded.push({ ...f, content: content.substring(0, MAX_MEMORY_FILE_SIZE) + '\n...[truncated]' });
          totalSize += MAX_MEMORY_FILE_SIZE;
        } else {
          loaded.push({ ...f, content });
          totalSize += content.length;
        }
        if (totalSize >= MAX_TOTAL_MEMORY_SIZE) break;
      } catch { /* skip unreadable files */ }
    }
  }
  return loaded;
}

/**
 * Resolve @include directives recursively.
 * Syntax: @include path/to/file.md (one per line, at line start)
 * Paths relative to the including file's directory.
 * Max depth: 3. Cycle detection via seen set.
 * @param {string} text - File content
 * @param {string} baseDir - Directory of the file containing the @include
 * @param {number} [depth=0]
 * @param {Set<string>} [seen] - Already included paths (cycle guard)
 * @returns {string}
 */
function resolveIncludes(text, baseDir, depth = 0, seen = new Set(), allowedRoots = null) {
  if (depth >= MAX_INCLUDE_DEPTH) return text;
  if (!text.includes('@include')) return text;

  return text.replace(INCLUDE_RE, (match, relPath) => {
    const trimmed = relPath.trim();
    if (!trimmed) return match;

    // Only allow .md files
    if (!trimmed.endsWith('.md')) {
      return `<!-- @include blocked: ${trimmed} (only .md files allowed) -->`;
    }

    // Block absolute paths
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
      return `<!-- @include blocked: ${trimmed} (absolute paths not allowed) -->`;
    }

    // Resolve path relative to the including file
    const absPath = resolve(baseDir, trimmed);

    // Security: validate against allowed roots via realpath (follows symlinks)
    if (allowedRoots && allowedRoots.length > 0) {
      try {
        const realPath = realpathSync(absPath);
        const inAllowed = allowedRoots.some(root => {
          const realRoot = realpathSync(root);
          return realPath === realRoot || realPath.startsWith(realRoot + sep);
        });
        if (!inAllowed) {
          return `<!-- @include blocked: ${trimmed} (outside allowed roots) -->`;
        }
      } catch {
        return `<!-- @include not found: ${trimmed} -->`;
      }
    }

    // Cycle guard
    if (seen.has(absPath)) {
      return `<!-- @include skipped: ${trimmed} (cycle detected) -->`;
    }
    seen.add(absPath);

    try {
      if (!existsSync(absPath)) {
        return `<!-- @include not found: ${trimmed} -->`;
      }
      const content = readFileSync(absPath, 'utf8').trim();
      // Size guard: don't include files larger than 50KB
      if (content.length > MAX_MEMORY_FILE_SIZE) {
        return `<!-- @include truncated: ${trimmed} (${content.length} bytes > ${MAX_MEMORY_FILE_SIZE}) -->`;
      }
      // Recursively resolve includes in the loaded file
      return resolveIncludes(content, dirname(absPath), depth + 1, seen, allowedRoots);
    } catch {
      return `<!-- @include error: ${trimmed} -->`;
    }
  });
}

export function buildMemoryContext(files) {
  if (!files || !files.length) return '';
  const sections = files.map(f =>
    `[LAIA.md — ${f.level}] (${f.path})\n${f.content}`
  );
  return sections.join('\n\n---\n\n') + '\n\n';
}
