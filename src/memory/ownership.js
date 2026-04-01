// src/memory/ownership.js — Single source of truth per memory class
// Part of V4 Track 1: Memory Unification
//
// Each data class has ONE owner system. Never two writers for the same class.
// Owner system is the canonical source; the other can read-project but never write.

/**
 * Ownership matrix — maps data class to its source-of-truth system.
 *
 * 'typed'  → stored in ~/laia-data/memory/typed/{type}/*.md (file-based, human-editable)
 * 'brain'  → stored in ~/laia-data/learnings/ (JSON, searchable, auto-expirable)
 */
export const OWNERSHIP_MATRIX = {
  // Brain owns structured knowledge
  procedure:  { owner: 'brain',  reason: 'Has trigger_intents, steps, outcome tracking' },
  learning:   { owner: 'brain',  reason: 'Has tags, full-text search, auto-expire, protected flag' },
  warning:    { owner: 'brain',  reason: 'Needs search + auto-expire for relevance' },
  pattern:    { owner: 'brain',  reason: 'Workflow patterns, needs tag-based recall' },
  principle:  { owner: 'brain',  reason: 'Core principles, needs protected flag' },

  // Typed memory owns user-facing, editable context
  user:       { owner: 'typed',  reason: 'User profile, human-editable, prompt-injected' },
  feedback:   { owner: 'typed',  reason: 'Session corrections, promotable to brain' },
  project:    { owner: 'typed',  reason: 'Per-project context, lives near code' },
  reference:  { owner: 'typed',  reason: 'Static URLs/pointers, rarely changes' },
};

/**
 * Classify a memory by its explicit type.
 * Deterministic — no heuristics, no LLM.
 *
 * @param {string} type - The memory type (e.g., 'user', 'learning', 'procedure')
 * @returns {{ owner: string, reason: string } | null}
 */
export function classifyByType(type) {
  if (!type || typeof type !== 'string') return null;
  return OWNERSHIP_MATRIX[type.toLowerCase()] || null;
}

/**
 * Get the owner system for a memory type.
 * @param {string} type
 * @returns {'brain' | 'typed' | null}
 */
export function getOwner(type) {
  const entry = classifyByType(type);
  return entry?.owner || null;
}

/**
 * Check if a type belongs to the typed memory system.
 */
export function isTypedOwned(type) {
  return getOwner(type) === 'typed';
}

/**
 * Check if a type belongs to the brain system.
 */
export function isBrainOwned(type) {
  return getOwner(type) === 'brain';
}

/**
 * Generate a canonical key for dedup across systems.
 * Deterministic: lowercased, stripped, normalized.
 *
 * @param {string} name - Memory name/title
 * @param {string} type - Memory type
 * @returns {string} Canonical key
 */
export function canonicalKey(name, type) {
  if (!name) return '';
  const normalized = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(/[^a-z0-9\s]/g, '')      // strip special chars
    .replace(/\s+/g, '-')             // spaces → dashes
    .replace(/^-|-$/g, '')            // trim dashes
    .slice(0, 80);
  return type ? `${type}:${normalized}` : normalized;
}
