// Agent profiles — load and validate YAML profiles from ~/.claudia/agents/
// V2a: user-level only. Project-level profiles deferred to V3.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

const PROFILES_DIR = join(homedir(), '.claudia', 'agents');

const VALID_FIELDS = new Set([
  'name', 'description', 'model',
  'allowedTools', 'deniedTools',
  'maxSteps', 'timeout', 'systemPrompt',
]);

const MAX_STEPS_CAP = 100;
const MAX_TIMEOUT_MS = 300_000;     // 5 minutes
const MAX_PROMPT_CHARS = 4_000;

/**
 * Load a named profile. Returns null if not found.
 * Throws on invalid YAML or validation errors.
 * @param {string} name — simple identifier (a-zA-Z0-9_-)
 */
export function loadProfile(name) {
  // Sanitize: only simple identifiers (no path traversal)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;

  for (const ext of ['.yml', '.yaml']) {
    const filePath = join(PROFILES_DIR, name + ext);
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8');
      try {
        const profile = parseYaml(raw);
        return validate(profile, filePath, name);
      } catch (e) {
        if (e instanceof ProfileValidationError) throw e;
        throw new ProfileValidationError(`Invalid YAML in profile '${name}' (${filePath}): ${e.message}`);
      }
    }
  }
  return null;
}

/**
 * List all available profiles (summary only).
 * @returns {Array<{name, description, model}>}
 */
export function listProfiles() {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => {
      const name = f.replace(/\.ya?ml$/, '');
      try {
        const profile = loadProfile(name);
        if (!profile) return null;
        return { name: profile.name, description: profile.description || '', model: profile.model || '' };
      } catch {
        return { name, description: '(invalid)', model: '' };
      }
    })
    .filter(Boolean);
}

/**
 * Resolve effective tool set from profile + inline overrides.
 * 
 * Rules:
 * 1. Start with baseTools (all registered tool names)
 * 2. If allowedTools is non-empty → intersect with base
 * 3. If deniedTools is non-empty → subtract from current set
 * 4. Deny ALWAYS wins
 * 5. undefined/omitted/[] = inherit (no change)
 * 
 * @param {string[]} baseToolNames - all registered tool names
 * @param {object} profile - loaded profile (or null)
 * @param {object} inlineArgs - { allowedTools?, deniedTools? }
 * @returns {string[]} final tool name list
 */
export function resolveToolSet(baseToolNames, profile, inlineArgs = {}) {
  let toolSet = new Set(baseToolNames);

  // Apply allowedTools (inline overrides profile)
  const allowed = inlineArgs.allowedTools?.length
    ? inlineArgs.allowedTools
    : profile?.allowedTools?.length
      ? profile.allowedTools
      : null;

  if (allowed) {
    const allowSet = new Set(allowed);
    toolSet = new Set([...toolSet].filter(t => allowSet.has(t)));
  }

  // Apply deniedTools — merge profile + inline, deny always wins
  const denied = [
    ...(profile?.deniedTools?.length ? profile.deniedTools : []),
    ...(inlineArgs.deniedTools?.length ? inlineArgs.deniedTools : []),
  ];
  if (denied.length) {
    const denySet = new Set(denied);
    toolSet = new Set([...toolSet].filter(t => !denySet.has(t)));
  }

  return [...toolSet];
}

// --- Validation ---

export class ProfileValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

function validate(profile, filePath, expectedName) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new ProfileValidationError(`Profile must be a YAML object (${filePath})`);
  }

  // Unknown keys
  for (const key of Object.keys(profile)) {
    if (!VALID_FIELDS.has(key)) {
      throw new ProfileValidationError(`Unknown field '${key}' in ${filePath}`);
    }
  }

  // Required: name
  if (!profile.name || typeof profile.name !== 'string') {
    throw new ProfileValidationError(`'name' is required (string) in ${filePath}`);
  }

  // Name consistency: warn if mismatch but don't error (filename wins for loading)
  if (expectedName && profile.name !== expectedName) {
    process.stderr.write(`\x1b[33m⚠ Profile name '${profile.name}' doesn't match filename '${expectedName}'\x1b[0m\n`);
  }

  // Type checks
  if (profile.description !== undefined && typeof profile.description !== 'string') {
    throw new ProfileValidationError(`'description' must be string in ${filePath}`);
  }
  if (profile.model !== undefined && typeof profile.model !== 'string') {
    throw new ProfileValidationError(`'model' must be string in ${filePath}`);
  }
  if (profile.systemPrompt !== undefined) {
    if (typeof profile.systemPrompt !== 'string') {
      throw new ProfileValidationError(`'systemPrompt' must be string in ${filePath}`);
    }
    if (profile.systemPrompt.length > MAX_PROMPT_CHARS) {
      throw new ProfileValidationError(`'systemPrompt' exceeds max length (${MAX_PROMPT_CHARS} chars) in ${filePath}`);
    }
  }

  // Numeric fields
  if (profile.timeout !== undefined) {
    if (!Number.isFinite(profile.timeout) || !Number.isInteger(profile.timeout) || profile.timeout <= 0) {
      throw new ProfileValidationError(`'timeout' must be a positive integer in ${filePath}`);
    }
    if (profile.timeout > MAX_TIMEOUT_MS) {
      throw new ProfileValidationError(`'timeout' exceeds max (${MAX_TIMEOUT_MS}ms) in ${filePath}`);
    }
  }
  if (profile.maxSteps !== undefined) {
    if (!Number.isFinite(profile.maxSteps) || !Number.isInteger(profile.maxSteps) || profile.maxSteps <= 0) {
      throw new ProfileValidationError(`'maxSteps' must be a positive integer in ${filePath}`);
    }
    profile.maxSteps = Math.min(profile.maxSteps, MAX_STEPS_CAP);
  }

  // Array fields
  for (const field of ['allowedTools', 'deniedTools']) {
    if (profile[field] !== undefined) {
      if (!Array.isArray(profile[field])) {
        throw new ProfileValidationError(`'${field}' must be array in ${filePath}`);
      }
      // Trim, validate strings, dedupe
      profile[field] = [...new Set(
        profile[field].map(t => {
          if (typeof t !== 'string') throw new ProfileValidationError(`'${field}' items must be strings in ${filePath}`);
          const trimmed = t.trim();
          if (!trimmed) throw new ProfileValidationError(`'${field}' contains empty string in ${filePath}`);
          return trimmed;
        })
      )];
    }
  }

  // Mutual exclusion
  if (profile.allowedTools?.length && profile.deniedTools?.length) {
    throw new ProfileValidationError(`Cannot specify both allowedTools and deniedTools in ${filePath}`);
  }

  return profile;
}
