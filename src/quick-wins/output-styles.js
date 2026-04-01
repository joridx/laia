// src/quick-wins/output-styles.js — Output style loader
// Inspired by Claude Code's src/outputStyles/loadOutputStylesDir.ts
// Loads .md files from ~/.laia/output-styles/ and .laia/output-styles/
// and injects them into the system prompt.

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const USER_STYLES_DIR = join(homedir(), '.laia', 'output-styles');

/**
 * Parse simple frontmatter from a markdown file.
 * Returns { frontmatter: {}, content: string }
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw.trim() };

  const fm = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // Strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }

  return { frontmatter: fm, content: match[2].trim() };
}

/**
 * Load output styles from a directory.
 * Each .md file becomes a style with name (from frontmatter or filename) and prompt (content).
 */
function loadStylesFromDir(dir) {
  if (!existsSync(dir)) return [];

  const styles = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const { frontmatter, content } = parseFrontmatter(raw);
        const styleName = basename(file, '.md');

        styles.push({
          name: frontmatter.name || styleName,
          description: frontmatter.description || `Custom ${styleName} output style`,
          prompt: content,
          source: dir,
        });
      } catch { /* skip broken files */ }
    }
  } catch { /* dir unreadable */ }

  return styles;
}

/**
 * Load all output styles. Project styles override user styles.
 * @param {string} [cwd] - Current working directory for project styles
 * @returns {{ name, description, prompt, source }[]}
 */
export function loadOutputStyles(cwd) {
  const userStyles = loadStylesFromDir(USER_STYLES_DIR);

  // Project styles: .laia/output-styles/ in cwd or git root
  let projectStyles = [];
  if (cwd) {
    const projectDir = join(cwd, '.laia', 'output-styles');
    projectStyles = loadStylesFromDir(projectDir);
  }

  // Project overrides user (by name)
  const merged = new Map();
  for (const s of userStyles) merged.set(s.name, s);
  for (const s of projectStyles) merged.set(s.name, s);

  return Array.from(merged.values());
}

/**
 * Get the active output style prompt for system prompt injection.
 * Reads LAIA_OUTPUT_STYLE env var or config.outputStyle.
 * @param {object} opts - { cwd, config }
 * @returns {string|null} - The style prompt to inject, or null
 */
export function getActiveStylePrompt({ cwd, config } = {}) {
  const styleName = process.env.LAIA_OUTPUT_STYLE || config?.outputStyle;
  if (!styleName) return null;

  const styles = loadOutputStyles(cwd);
  const style = styles.find(s => s.name === styleName);
  return style ? style.prompt : null;
}

/**
 * List available styles for /style command
 */
export function listOutputStyles(cwd) {
  return loadOutputStyles(cwd);
}

/**
 * Create example output style file
 */
export function initOutputStyles() {
  if (!existsSync(USER_STYLES_DIR)) mkdirSync(USER_STYLES_DIR, { recursive: true });

  const concisePath = join(USER_STYLES_DIR, 'concise.md');
  if (!existsSync(concisePath)) {
    writeFileSync(concisePath, `---
name: concise
description: Short, direct responses without fluff
---
Be extremely concise. Use bullet points. No introductions or conclusions.
Skip pleasantries. Answer in the minimum words possible.
If code is involved, show only the changed lines with minimal context.
`, 'utf-8');
  }

  const detailedPath = join(USER_STYLES_DIR, 'detailed.md');
  if (!existsSync(detailedPath)) {
    writeFileSync(detailedPath, `---
name: detailed
description: Thorough explanations with examples
---
Provide thorough, detailed explanations. Include:
- Step-by-step reasoning
- Examples where helpful
- Potential pitfalls and alternatives
- Links to relevant documentation when applicable
Structure responses with clear headers and sections.
`, 'utf-8');
  }
}
