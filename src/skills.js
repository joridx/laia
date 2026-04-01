// Skills discovery and loading — V3
// Sources (priority order):
//   1. ~/.laia/skills/*/SKILL.md  (V3 skills with directory)
//   2. ~/.laia/commands/*.md        (legacy flat files, auto-wrapped)
//
// Replaces commands/loader.js as the canonical skill source.

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, basename, resolve, relative, sep } from 'path';
import { homedir } from 'os';
import { loadUserProfile } from './user-profile.js';
import { BUNDLED_SKILLS } from './skills/bundled.js';

const SKILLS_DIR = join(homedir(), '.laia', 'skills');
const LEGACY_DIRS = [
  join(homedir(), '.laia', 'commands'),
];
// V3 Phase 3: Project-level skills (checked in workspace root)
const PROJECT_SKILLS_DIR = 'laia-skills';

// --- Frontmatter v1 schema ---

const SCHEMA_DEFAULTS = {
  schema: 1,
  invocation: 'user',       // 'user' | 'both'
  context: 'main',          // 'main' | 'fork'
  arguments: true,
  'allowed-tools': [],
  'argument-hint': '',
  'intent-keywords': [],    // V3P3: keywords for auto-invoke
};

const REQUIRED_FIELDS = ['name', 'description'];

// --- Cache ---

let _cache = null;  // { map, fingerprint, workspaceRoot, ts }
const CACHE_TTL_MS = 5000;

function computeFingerprint(workspaceRoot) {
  let maxMtime = 0;
  let fileCount = 0;

  // V3 skills
  if (existsSync(SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(SKILLS_DIR)) {
        const skillMd = join(SKILLS_DIR, entry, 'SKILL.md');
        try {
          const st = statSync(skillMd);
          maxMtime = Math.max(maxMtime, st.mtimeMs);
          fileCount++;
        } catch {}
      }
    } catch {}
  }

  // Legacy dirs
  for (const dir of LEGACY_DIRS) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const st = statSync(join(dir, f));
          maxMtime = Math.max(maxMtime, st.mtimeMs);
          fileCount++;
        } catch {}
      }
    } catch {}
  }

  // Project-level skills
  if (workspaceRoot) {
    const projDir = join(workspaceRoot, PROJECT_SKILLS_DIR);
    if (existsSync(projDir)) {
      try {
        for (const entry of readdirSync(projDir)) {
          const skillMd = join(projDir, entry, 'SKILL.md');
          try {
            const st = statSync(skillMd);
            maxMtime = Math.max(maxMtime, st.mtimeMs);
            fileCount++;
          } catch {}
        }
      } catch {}
    }
  }

  return `${fileCount}:${maxMtime}`;
}

// --- Frontmatter parser ---

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('---', 3);
  if (end === -1) return { frontmatter: {}, body: raw };

  const yamlBlock = raw.substring(3, end).trim();
  const body = raw.substring(end + 3).replace(/^\r?\n/, '').trim();
  const frontmatter = {};

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    const match = trimmed.match(/^([\w][\w-]*):\s*(.+)$/);
    if (match) {
      const [, key, val] = match;
      if (val.startsWith('[') && val.endsWith(']')) {
        frontmatter[key] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      } else if (val === 'true') frontmatter[key] = true;
      else if (val === 'false') frontmatter[key] = false;
      else if (/^\d+$/.test(val)) frontmatter[key] = Number(val);
      else frontmatter[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter, body };
}

// --- Normalize to canonical SkillDef ---

function normalizeSkill(name, frontmatter, body, source, skillDir = null) {
  // Apply defaults
  const fm = { ...SCHEMA_DEFAULTS, name, ...frontmatter };

  // Validate required
  const warnings = [];
  for (const field of REQUIRED_FIELDS) {
    if (!fm[field]) warnings.push(`Missing required field: ${field}`);
  }

  // Warn on unknown fields (forward compat)
  const known = new Set([...Object.keys(SCHEMA_DEFAULTS), ...REQUIRED_FIELDS, 'tags', 'argument-hint', 'version', 'intent-keywords']);
  for (const key of Object.keys(fm)) {
    if (!known.has(key)) warnings.push(`Unknown field: ${key}`);
  }

  return {
    name: fm.name,
    description: fm.description || `Legacy command: ${name}`,
    schema: fm.schema,
    invocation: fm.invocation,
    context: fm.context,
    allowedTools: fm['allowed-tools'] || [],
    arguments: fm.arguments,
    argumentHint: fm['argument-hint'] || '',
    intentKeywords: fm['intent-keywords'] || [],
    tags: fm.tags || [],
    body,
    source,         // 'v3' | 'legacy'
    skillDir,       // base directory for V3 skills (@reference resolution)
    sourceFile: null, // filled by caller
    warnings,
  };
}

// --- Discovery ---

export function discoverSkills({ force = false, workspaceRoot = null } = {}) {
  // Check cache
  if (!force && _cache) {
    const age = Date.now() - _cache.ts;
    if (age < CACHE_TTL_MS && _cache.workspaceRoot === workspaceRoot) {
      const fp = computeFingerprint(workspaceRoot);
      if (fp === _cache.fingerprint) return _cache.map;
    }
  }

  const map = new Map();
  const shadowed = [];

  // 1. V3 skills: ~/.laia/skills/*/SKILL.md
  if (existsSync(SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(SKILLS_DIR)) {
        const skillDir = join(SKILLS_DIR, entry);
        const skillMd = join(skillDir, 'SKILL.md');
        try {
          const raw = readFileSync(skillMd, 'utf8');
          const { frontmatter, body } = parseFrontmatter(raw);
          const skill = normalizeSkill(entry, frontmatter, body, 'v3', skillDir);
          skill.sourceFile = skillMd;
          map.set(entry, skill);
        } catch {}
      }
    } catch {}
  }

  // 2. Legacy: ~/.laia/commands/*.md
  for (const dir of LEGACY_DIRS) {
    try {
      for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
        const name = basename(file, '.md');
        if (map.has(name)) {
          shadowed.push({ name, shadowedBy: 'v3', source: dir });
          continue; // V3 wins
        }
        try {
          const raw = readFileSync(join(dir, file), 'utf8');
          const { frontmatter, body } = parseFrontmatter(raw);
          const skill = normalizeSkill(name, frontmatter, body, 'legacy');
          skill.sourceFile = join(dir, file);
          map.set(name, skill);
        } catch {}
      }
    } catch {}
  }

  // 3. Project-level skills: ./laia-skills/*/SKILL.md (highest priority — shadows all)
  if (workspaceRoot) {
    const projDir = join(workspaceRoot, PROJECT_SKILLS_DIR);
    if (existsSync(projDir)) {
      try {
        for (const entry of readdirSync(projDir)) {
          const skillDir = join(projDir, entry);
          const skillMd = join(skillDir, 'SKILL.md');
          try {
            const raw = readFileSync(skillMd, 'utf8');
            const { frontmatter, body } = parseFrontmatter(raw);
            const skill = normalizeSkill(entry, frontmatter, body, 'project', skillDir);
            skill.sourceFile = skillMd;
            if (map.has(entry)) {
              shadowed.push({ name: entry, shadowedBy: 'project', source: map.get(entry).sourceFile });
            }
            map.set(entry, skill); // Project wins over everything
          } catch {}
        }
      } catch {}
    }
  }

  // Log shadowing
  if (shadowed.length > 0) {
    for (const s of shadowed) {
      process.stderr.write(`\x1b[2m[skills] '${s.name}' shadowed by ${s.shadowedBy} skill\x1b[0m\n`);
    }
  }

  // 4. Bundled skills (lowest priority — user skills shadow these)
  for (const bs of BUNDLED_SKILLS) {
    if (!map.has(bs.name)) {
      map.set(bs.name, {
        name: bs.name,
        description: bs.description,
        source: 'bundled',
        body: bs.prompt,
        invocation: 'user',
        context: 'main',
        arguments: true,
        'argument-hint': bs.argHint || '',
        'allowed-tools': null, // null = unrestricted ([] would mean no tools)
        requiresArgs: bs.requiresArgs || false,
        _bundled: true,
      });
    }
  }

  _cache = { map, fingerprint: computeFingerprint(workspaceRoot), workspaceRoot, ts: Date.now() };
  return map;
}

// --- Load single skill ---

export function loadSkill(name, { force = false } = {}) {
  const skills = discoverSkills({ force });
  return skills.get(name) || null;
}

// --- List for /skills display ---

export function listSkills({ force = false } = {}) {
  const skills = discoverSkills({ force });
  return [...skills.values()].map(s => ({
    name: s.name,
    description: s.description,
    source: s.source,
    hasDir: !!s.skillDir,
    argumentHint: s.argumentHint,
    warnings: s.warnings,
  }));
}

// --- @reference resolution ---

const REF_PATTERN = /@([\w/.-]+\.md)/g;
const MAX_REF_DEPTH = 5;

export function resolveReference(skillDir, refPath) {
  if (!skillDir) return null;

  // Path safety: no traversal, must stay within skillDir
  const resolved = resolve(skillDir, refPath);
  const rel = relative(skillDir, resolved);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return null;

  try {
    return { path: resolved, content: readFileSync(resolved, 'utf8') };
  } catch {
    return null;
  }
}

function resolveRefsInText(text, skillDir, depth = 0, seen = new Set()) {
  if (!skillDir || depth >= MAX_REF_DEPTH) return text;

  return text.replace(REF_PATTERN, (match, refPath) => {
    if (seen.has(refPath)) return match; // cycle guard
    seen.add(refPath);
    const ref = resolveReference(skillDir, refPath);
    if (!ref) return match; // leave unchanged if not found
    // Recursively resolve refs in the loaded file
    return resolveRefsInText(ref.content, skillDir, depth + 1, seen);
  });
}

// --- Expand skill (replace args + resolve refs + user profile) ---

export function expandSkill(skill, args = '') {
  let body = skill.body
    .replace(/\{\{args\}\}/g, args)
    .replace(/\$ARGUMENTS/g, args);

  // Resolve @references for V3 skills
  if (skill.skillDir) {
    body = resolveRefsInText(body, skill.skillDir);
  }

  // Replace {{user.*}} placeholders with values from ~/.laia/user.json
  body = replaceUserPlaceholders(body);
  // Replace {{env.*}} placeholders with env vars / ~/.laia/env.json
  body = replaceEnvPlaceholders(body);

  return body;
}

// --- Backward compat: loadFileCommands() shim ---

export function loadFileCommands(commandDirs) {
  // Delegate to discoverSkills, return legacy-shaped Map
  const skills = discoverSkills({ force: true });
  const commands = new Map();
  for (const [name, skill] of skills) {
    commands.set(name, {
      name,
      description: skill.description,
      tags: skill.tags,
      body: skill.body,
      source: skill.sourceFile,
    });
  }
  return commands;
}

export function expandCommand(command, args) {
  let body = command.body
    .replace(/\{\{args\}\}/g, args)
    .replace(/\$ARGUMENTS/g, args);

  // Replace {{user.*}} placeholders with values from ~/.laia/user.json
  body = replaceUserPlaceholders(body);
  // Replace {{env.*}} placeholders with env vars / ~/.laia/env.json
  body = replaceEnvPlaceholders(body);

  return body;
}

// --- User profile placeholder replacement ---

const USER_PLACEHOLDER_RE = /\{\{user\.([a-z_]+)\}\}/g;

function replaceUserPlaceholders(text) {
  if (!text.includes('{{user.')) return text;
  const profile = loadUserProfile();
  if (!profile) {
    // Warn once if user.json is missing and placeholders are present
    if (!replaceUserPlaceholders._warned) {
      console.error('⚠ user.json not found at ~/.laia/user.json — {{user.*}} placeholders will not be replaced.');
      replaceUserPlaceholders._warned = true;
    }
    return text;
  }
  // Derived fields (computed from base fields)
  const derived = {
    email_encoded: profile.email ? encodeURIComponent(profile.email) : undefined,
    home_dir: profile.home_dir || process.env.HOME || process.env.USERPROFILE,
  };
  const merged = { ...derived, ...profile }; // explicit profile values override derived
  return text.replace(USER_PLACEHOLDER_RE, (match, key) => {
    return merged[key] !== undefined ? String(merged[key]) : match;
  });
}

// --- Environment placeholder replacement ({{env.*}}) ---
// Resolves from: process.env > ~/.laia/env.json > leave unresolved

const ENV_PLACEHOLDER_RE = /\{\{env\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

let _envConfig = undefined;

function loadEnvConfig() {
  if (_envConfig !== undefined) return _envConfig;
  try {
    const envPath = join(homedir(), '.laia', 'env.json');
    _envConfig = JSON.parse(readFileSync(envPath, 'utf8'));
  } catch {
    _envConfig = null;
  }
  return _envConfig;
}

function replaceEnvPlaceholders(text) {
  if (!text.includes('{{env.')) return text;
  const envJson = loadEnvConfig();
  return text.replace(ENV_PLACEHOLDER_RE, (match, key) => {
    if (process.env[key] !== undefined) return process.env[key];
    if (envJson && envJson[key] !== undefined) return String(envJson[key]);
    return match;
  });
}

// --- Ensure skills directory exists ---

export function ensureSkillsDir() {
  mkdirSync(SKILLS_DIR, { recursive: true });
  return SKILLS_DIR;
}
