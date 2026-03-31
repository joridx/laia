// Load slash commands from ~/.laia/commands/*.md
// Each .md file becomes a command named after the filename (without extension).
// The file content is the prompt template. {{args}} / $ARGUMENTS is replaced with user arguments.
// Optional YAML frontmatter for description/tags.

import { readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';

export function loadFileCommands(commandDirs) {
  const commands = new Map();

  for (const dir of commandDirs) {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const name = basename(file, '.md');
        const raw = readFileSync(join(dir, file), 'utf8');
        const { frontmatter, body } = parseFrontmatter(raw);
        commands.set(name, {
          name,
          description: frontmatter.description || '',
          tags: frontmatter.tags || [],
          body,
          source: join(dir, file),
        });
      }
    } catch {}
  }

  return commands;
}

export function expandCommand(command, args) {
  return command.body
    .replace(/\{\{args\}\}/g, args)
    .replace(/\$ARGUMENTS/g, args);
}

// Simple YAML frontmatter parser (--- delimited)
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('---', 3);
  if (end === -1) return { frontmatter: {}, body: raw };

  const yamlBlock = raw.substring(3, end).trim();
  const body = raw.substring(end + 3).trim();
  const frontmatter = {};

  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (match) {
      const [, key, val] = match;
      // Handle simple arrays: [a, b, c]
      if (val.startsWith('[') && val.endsWith(']')) {
        frontmatter[key] = val.slice(1, -1).split(',').map(s => s.trim());
      } else {
        frontmatter[key] = val.trim();
      }
    }
  }

  return { frontmatter, body };
}
