// CLAUDE.md memory hierarchy for claudia
// Priority (lowest → highest): user → project → managed
// All files are optional. Contents are concatenated into the system prompt.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME = homedir();

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
  for (const f of candidates) {
    if (existsSync(f.path)) {
      try {
        const content = readFileSync(f.path, 'utf8').trim();
        if (content) loaded.push({ ...f, content });
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
