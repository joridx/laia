// src/skills/improvement.js — Skill auto-improvement for LAIA V5
// Every N user messages, a cheap LLM side-query analyzes if the user
// has expressed preferences that should be incorporated into the active skill.
// NEVER auto-writes — always requires user confirmation.

import { stderr } from 'process';
import { writeFileSync, existsSync } from 'fs';
import { getFlag } from '../config/flags.js';
import { homedir } from 'os';

const DIM = '\x1b[2m';
const B = '\x1b[1m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[0m';

const CHECK_INTERVAL = 5;  // Check every N user messages
const MAX_RECENT_MESSAGES = 10;  // Look at last N messages
const IMPROVEMENT_TIMEOUT_MS = 15_000;

// ─── State ──────────────────────────────────────────────────────────────────

let _messageCount = 0;
let _recentMessages = [];  // Ring buffer of last N user messages
let _pendingImprovement = null;

/**
 * Record a user message. Call on every user input.
 * @param {string} message - The user's input text
 */
export function recordMessage(message) {
  if (!message || typeof message !== 'string') return;
  _messageCount++;
  _recentMessages.push(message);
  if (_recentMessages.length > MAX_RECENT_MESSAGES) {
    _recentMessages.shift();
  }
}

/**
 * Check if it's time to analyze for skill improvements.
 * @returns {boolean}
 */
export function shouldCheckImprovement() {
  if (!getFlag('skill_auto_improvement', false)) return false;
  return _messageCount > 0 && _messageCount % CHECK_INTERVAL === 0;
}

/**
 * Analyze recent messages for potential skill improvements.
 *
 * @param {object} opts
 * @param {object|null} opts.activeSkill - Currently active skill (name, path, content)
 * @param {Function} opts.llmCall - LLM call: (prompt, opts?) => Promise<string>
 * @returns {Promise<{suggested: boolean, patch?: string, reason?: string}>}
 */
export async function analyzeForImprovement({ activeSkill, llmCall }) {
  if (!activeSkill || !activeSkill.path || !activeSkill.content) {
    return { suggested: false };
  }

  if (_recentMessages.length < 2) {
    return { suggested: false };
  }

  stderr.write(`${DIM}[skill-improve] Analyzing recent messages for skill improvements...${R}\n`);

  const prompt = buildAnalysisPrompt(activeSkill, _recentMessages);

  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), IMPROVEMENT_TIMEOUT_MS);

  try {
    const response = await llmCall(prompt, { signal: abort.signal });
    clearTimeout(timeoutId);

    const result = parseAnalysisResponse(response);
    if (result.suggested) {
      _pendingImprovement = {
        skillPath: activeSkill.path,
        skillName: activeSkill.name,
        patch: result.patch,
        reason: result.reason,
      };
      stderr.write(`${Y}[skill-improve] Suggestion found for ${activeSkill.name}: ${result.reason}${R}\n`);
    } else {
      stderr.write(`${DIM}[skill-improve] No improvements detected${R}\n`);
    }
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    stderr.write(`${DIM}[skill-improve] Analysis failed: ${err.message}${R}\n`);
    return { suggested: false };
  }
}

/**
 * Get the pending improvement (if any) for display to the user.
 * @returns {object|null}
 */
export function getPendingImprovement() {
  return _pendingImprovement;
}

/**
 * Apply the pending improvement (after user confirmation).
 * @returns {{ applied: boolean, error?: string }}
 */
export function applyPendingImprovement() {
  if (!_pendingImprovement) return { applied: false, error: 'No pending improvement' };

  const { skillPath, patch } = _pendingImprovement;

  try {
    if (!existsSync(skillPath)) {
      return { applied: false, error: `Skill file not found: ${skillPath}` };
    }
    // Security: ensure skillPath is within expected directories
    const home = homedir();
    const isValidPath = skillPath.startsWith(home) || skillPath.startsWith(process.cwd());
    if (!isValidPath) {
      return { applied: false, error: 'Skill path outside allowed directories' };
    }

    writeFileSync(skillPath, patch);
    const name = _pendingImprovement.skillName;
    _pendingImprovement = null;
    stderr.write(`${G}✅ Skill ${name} updated${R}\n`);
    return { applied: true };
  } catch (err) {
    return { applied: false, error: err.message };
  }
}

/**
 * Dismiss the pending improvement.
 */
export function dismissPendingImprovement() {
  _pendingImprovement = null;
}

// ─── Prompts ────────────────────────────────────────────────────────────────

function buildAnalysisPrompt(activeSkill, messages) {
  const recentMsgs = messages.map((m, i) => `[${i + 1}] ${m}`).join('\n');

  return `You are analyzing a conversation to detect implicit user preferences that should be incorporated into a skill file.

CURRENT SKILL (${activeSkill.name}):
\`\`\`markdown
${activeSkill.content.slice(0, 3000)}
\`\`\`

RECENT USER MESSAGES:
${recentMsgs}

TASK: Analyze if the user has expressed any preferences, corrections, or patterns that should be added to the skill. Look for:
- Style preferences ("use X instead of Y", "always do Z")
- Workflow corrections ("don't do A, do B instead")
- Missing steps the user had to manually specify
- Convention preferences (naming, structure, etc.)

If you find improvements, respond with:
SUGGESTED: yes
REASON: <one-line explanation>
PATCH:
\`\`\`
<full updated SKILL.md content>
\`\`\`

If no improvements needed, respond with:
SUGGESTED: no`;
}

function parseAnalysisResponse(response) {
  if (!response) return { suggested: false };

  const suggestedMatch = response.match(/SUGGESTED:\s*(yes|no)/i);
  if (!suggestedMatch || suggestedMatch[1].toLowerCase() === 'no') {
    return { suggested: false };
  }

  const reasonMatch = response.match(/REASON:\s*(.+)/i);
  const patchMatch = response.match(/```(?:markdown)?\n([\s\S]*?)```/);

  if (!patchMatch) {
    return { suggested: false };  // Malformed response
  }

  return {
    suggested: true,
    reason: reasonMatch?.[1]?.trim() || 'Improvement detected',
    patch: patchMatch[1].trim(),
  };
}

// ─── Reset (for tests) ─────────────────────────────────────────────────────

export function _reset() {
  _messageCount = 0;
  _recentMessages = [];
  _pendingImprovement = null;
}
