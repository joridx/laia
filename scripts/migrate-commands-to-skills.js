#!/usr/bin/env node
// Migration script: ~/.claude/commands/*.md → ~/.claudia/skills/*/SKILL.md
// One-time, owner-operated. Run: node scripts/migrate-commands-to-skills.js

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const COMMANDS_DIR = join(homedir(), '.claude', 'commands');
const SKILLS_DIR = join(homedir(), '.claude', 'skills');
const SKIP = ['README.md', 'confluence.md.bak'];  // skip non-skill files

// Parse existing frontmatter
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('---', 3);
  if (end === -1) return { frontmatter: {}, body: raw };
  const yamlBlock = raw.substring(3, end).trim();
  const body = raw.substring(end + 3).replace(/^\r?\n/, '').trim();
  const fm = {};
  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    const match = trimmed.match(/^([\w][\w-]*):\s*(.+)$/);
    if (match) {
      const [, key, val] = match;
      fm[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body };
}

// Build V3 SKILL.md content
function buildSkillMd(name, fm, body) {
  const desc = fm.description || `Legacy command: ${name}`;
  const hint = fm['argument-hint'] || '';
  const tools = fm['allowed-tools'] || '';
  
  let yaml = `---\nschema: 1\nname: ${name}\ndescription: ${JSON.stringify(desc)}`;
  yaml += `\ninvocation: user`;
  yaml += `\ncontext: main`;
  if (tools) yaml += `\nallowed-tools: ${tools}`;
  yaml += `\narguments: true`;
  if (hint) yaml += `\nargument-hint: ${hint}`;
  yaml += `\n---\n\n`;
  
  return yaml + body;
}

// --- Main ---

console.log(`Source: ${COMMANDS_DIR}`);
console.log(`Target: ${SKILLS_DIR}\n`);

const files = readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md') && !SKIP.includes(f));
console.log(`Found ${files.length} commands to migrate.\n`);

let migrated = 0, skipped = 0, errors = 0;

for (const file of files) {
  const name = basename(file, '.md');
  const targetDir = join(SKILLS_DIR, name);
  const targetFile = join(targetDir, 'SKILL.md');
  
  // Skip if already exists
  if (existsSync(targetFile)) {
    console.log(`  ⏭  ${name} — already exists, skipping`);
    skipped++;
    continue;
  }
  
  try {
    const raw = readFileSync(join(COMMANDS_DIR, file), 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const skillMd = buildSkillMd(name, frontmatter, body);
    
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, skillMd);
    console.log(`  ✅ ${name} → ${targetDir}/`);
    migrated++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    errors++;
  }
}

console.log(`\n--- Summary ---`);
console.log(`Migrated: ${migrated}`);
console.log(`Skipped:  ${skipped}`);
console.log(`Errors:   ${errors}`);
console.log(`\nDone. Verify with: claudia → /skills`);
