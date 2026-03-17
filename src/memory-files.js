// CLAUDE.md memory hierarchy for claudia
// Priority (lowest → highest): user → project → managed
// All files are optional. Contents are concatenated into the system prompt.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME = homedir();
const MAX_MEMORY_FILE_SIZE = 50_000; // 50KB per file
const MAX_TOTAL_MEMORY_SIZE = 100_000; // 100KB total

export function loadMemoryFiles({ workspaceRoot } = {}) {
  const candidates = [
    // User-level (lowest priority)
    { path: join(HOME, '.claude', 'CLAUDE.md'), level: 'user' },
    { path: join(HOME, '.claudia', 'CLAUDE.md'), level: 'user' },
    // Project-level
    ...(workspaceRoot ? [
      { path: join(workspaceRoot, 'CLAUDE.md'), level: 'project' },
      { path: join(workspaceRoot, '.claude', 'CLAUDE.md'), level: 'project' },
    ] : []),
    // Managed policy (highest priority — corporate, immutable by agent)
    { path: join(HOME, '.claudia', 'CLAUDE-managed.md'), level: 'managed' },
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
        const content = readFileSync(f.path, 'utf8').trim();
        if (!content) continue;
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

export function buildMemoryContext(files) {
  if (!files || !files.length) return '';
  const sections = files.map(f =>
    `[CLAUDE.md — ${f.level}] (${f.path})\n${f.content}`
  );
  return sections.join('\n\n---\n\n') + '\n\n';
}
