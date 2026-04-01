// src/skills/intent-matcher.js — Keyword-based skill auto-invoke matcher (no LLM)
// V3 Phase 3: Skills Auto-invoke
//
// Matches user input against skill metadata (intentKeywords + name + tags).
// Returns best matching skill if confidence exceeds threshold.
//
// No LLM calls — purely deterministic keyword matching.

const THRESHOLD = 0.3;  // Minimum confidence to auto-invoke

/**
 * Score a skill against user input.
 * @param {string} input - User's message (lowercased)
 * @param {object} skill - Skill definition
 * @returns {number} Score 0.0-1.0
 */
function scoreSkill(input, skill) {
  if (skill.invocation !== 'both') return 0;

  const inputLower = input.toLowerCase();
  const inputTokens = new Set(inputLower.split(/\s+/).filter(t => t.length > 2));
  let score = 0;
  let maxScore = 0;

  // 1. Intent keywords (highest weight: 0.5)
  const intentKeywords = skill.intentKeywords || [];
  if (intentKeywords.length > 0) {
    maxScore += 0.5;
    const matched = intentKeywords.filter(kw => inputLower.includes(kw.toLowerCase()));
    score += 0.5 * (matched.length / intentKeywords.length);
  }

  // 2. Skill name match (weight: 0.3)
  maxScore += 0.3;
  if (inputLower.includes(skill.name.toLowerCase())) {
    score += 0.3;
  }

  // 3. Tags match (weight: 0.2)
  const tags = skill.tags || [];
  if (tags.length > 0) {
    maxScore += 0.2;
    const matchedTags = tags.filter(tag =>
      inputTokens.has(tag.toLowerCase()) || inputLower.includes(tag.toLowerCase())
    );
    score += 0.2 * (matchedTags.length / tags.length);
  }

  return maxScore > 0 ? score : 0;
}

/**
 * Find the best auto-invoke skill match for a user message.
 * @param {string} input - User's raw message
 * @param {Map<string, object>} skills - All discovered skills
 * @returns {{ skill: object, score: number } | null}
 */
export function matchIntent(input, skills) {
  if (!input || !skills || skills.size === 0) return null;

  // Skip if input looks like a slash command
  if (input.trim().startsWith('/')) return null;

  let best = null;
  let bestScore = 0;

  for (const [, skill] of skills) {
    if (skill.invocation !== 'both') continue;

    const score = scoreSkill(input, skill);
    if (score > bestScore && score >= THRESHOLD) {
      bestScore = score;
      best = skill;
    }
  }

  return best ? { skill: best, score: bestScore } : null;
}

/**
 * Check if input could trigger auto-invoke (quick pre-check).
 * @param {string} input
 * @returns {boolean}
 */
export function couldAutoInvoke(input) {
  return input && !input.trim().startsWith('/') && input.trim().length > 3;
}
