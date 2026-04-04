// src/memory/prompt-governance.js — Deterministic prompt precedence + budget enforcement
// V4 Track 3: Prompt/Context Governance
//
// Replaces the flat array in buildSystemPrompt() with a governed stack:
//   P1 — SAFETY + CORE RULES       [FIXED, never truncated]
//   P2 — IDENTITY + TOOLS           [FIXED]
//   P3 — EVOLVED STABLE             [PINNED, manually confirmed]
//   P4 — TASK CONTEXT               [CONTEXTUAL: corporate, plan, coordinator]
//   P5 — TYPED MEMORY               [ADAPTIVE, Track 1 unified view]
//   P6 — EVOLVED ADAPTIVE           [ROTATING, 30-day expiry, first to truncate]
//   P7 — OUTPUT STYLE               [OPTIONAL]
//
// Truncation: bottom-up (P7 first). Per-entry removal, not substring truncation.
// Budget: configurable, default 20KB (~5K tokens), hard cap 32KB.

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_CHARS = 20_000;  // ~5K tokens
const HARD_CAP_CHARS = 32_000;        // Absolute max
const HEADER_OVERHEAD = 50;            // Chars overhead per chunk for joining

// Priority levels (lower = higher priority = truncated LAST)
export const PRIORITY = Object.freeze({
  SAFETY: 1,
  IDENTITY: 2,
  EVOLVED_STABLE: 3,
  TASK_CONTEXT: 4,
  TYPED_MEMORY: 5,
  EVOLVED_ADAPTIVE: 6,
  OUTPUT_STYLE: 7,
});

// ─── PromptChunk ─────────────────────────────────────────────────────────────

/**
 * Create a prompt chunk with metadata.
 * @param {object} opts
 * @param {string} opts.id - Unique identifier
 * @param {string} opts.text - Prompt section text
 * @param {number} opts.priority - Priority level (1=highest)
 * @param {boolean} [opts.pinned=false] - If true, never truncated
 * @param {number} [opts.maxChars] - Max chars for this chunk
 * @returns {object} PromptChunk
 */
export function chunk({ id, text, priority, pinned = false, maxChars }) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Apply per-chunk maxChars if set
  const finalText = maxChars && trimmed.length > maxChars
    ? trimmed.slice(0, maxChars) + '\n\n<!-- [truncated] -->'
    : trimmed;

  return {
    id,
    text: finalText,
    chars: finalText.length,
    priority,
    pinned: pinned || priority <= PRIORITY.IDENTITY, // P1+P2 always pinned
  };
}

// ─── Budget Enforcement ──────────────────────────────────────────────────────

/**
 * Enforce total budget by removing chunks bottom-up (highest priority number first).
 * Pinned chunks are NEVER removed.
 * Within same priority, removes the largest chunk first.
 *
 * @param {Array<object>} chunks - Array of PromptChunks
 * @param {number} [budget] - Max total chars (default: DEFAULT_BUDGET_CHARS)
 * @returns {{ kept: Array<object>, dropped: Array<object>, totalChars: number }}
 */
export function enforceBudget(chunks, budget = DEFAULT_BUDGET_CHARS) {
  const effectiveBudget = Math.min(budget, HARD_CAP_CHARS);
  const valid = chunks.filter(Boolean);

  // Sort by priority (ascending = most important first)
  const sorted = [...valid].sort((a, b) => a.priority - b.priority);

  let totalChars = sorted.reduce((sum, c) => sum + c.chars + HEADER_OVERHEAD, 0);
  const kept = [...sorted];
  const dropped = [];

  // Remove from the END (lowest priority = highest number) until within budget
  // Within same priority, remove largest first for maximum budget recovery
  while (totalChars > effectiveBudget && kept.length > 0) {
    // Find the lowest-priority non-pinned chunk; among same priority, pick largest
    let dropIdx = -1;
    let dropPrio = -1;
    let dropSize = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].pinned) continue;
      if (kept[i].priority > dropPrio || (kept[i].priority === dropPrio && kept[i].chars > dropSize)) {
        dropIdx = i;
        dropPrio = kept[i].priority;
        dropSize = kept[i].chars;
      }
    }
    if (dropIdx === -1) break; // All remaining are pinned — can't shrink further

    const removed = kept.splice(dropIdx, 1)[0];
    totalChars -= (removed.chars + HEADER_OVERHEAD);
    dropped.push(removed);
  }

  return { kept, dropped, totalChars };
}

// ─── Governed Prompt Builder ─────────────────────────────────────────────────

/**
 * Build the system prompt with deterministic precedence and budget enforcement.
 *
 * @param {object} opts
 * @param {object} opts.sections - Raw section texts keyed by name
 * @param {number} [opts.budget] - Total budget in chars
 * @returns {{ prompt: string, stats: object }}
 */
export function buildGovernedPrompt({ sections, budget = DEFAULT_BUDGET_CHARS }) {
  const {
    safety, rules, identity, tools, skillsPolicy, multiModel,
    evolvedStable, taskContext, corporateHint, planMode, autoRecall,
    typedMemory, evolvedAdaptive, outputStyle, coordinator,
  } = sections;

  // ── Build chunks with priorities ──

  // P1: Safety + Rules (always first, always pinned)
  const safetyChunks = [
    chunk({ id: 'safety', text: safety, priority: PRIORITY.SAFETY, pinned: true }),
    chunk({ id: 'rules', text: rules, priority: PRIORITY.SAFETY, pinned: true }),
  ];

  // P2: Identity + Tools (pinned but size-capped)
  const identityChunks = [
    chunk({ id: 'identity', text: identity, priority: PRIORITY.IDENTITY, pinned: true, maxChars: 4000 }),
    coordinator
      ? chunk({ id: 'coordinator', text: coordinator, priority: PRIORITY.IDENTITY, pinned: true, maxChars: 3000 })
      : chunk({ id: 'tools', text: tools, priority: PRIORITY.IDENTITY, pinned: true, maxChars: 3000 }),
  ];
  // Skills + multi-model only if not coordinator
  if (!coordinator) {
    identityChunks.push(
      chunk({ id: 'skills-policy', text: skillsPolicy, priority: PRIORITY.IDENTITY }),
      chunk({ id: 'multi-model', text: multiModel, priority: PRIORITY.IDENTITY }),
    );
  }

  // P3: Evolved stable (pinned by default, manually confirmed learnings)
  const stableChunks = [
    chunk({ id: 'evolved-stable', text: evolvedStable, priority: PRIORITY.EVOLVED_STABLE, pinned: true, maxChars: 3000 }),
  ];

  // P4: Task context (varies per turn)
  const taskChunks = [
    chunk({ id: 'corporate-hint', text: corporateHint, priority: PRIORITY.TASK_CONTEXT }),
    chunk({ id: 'plan-mode', text: planMode, priority: PRIORITY.TASK_CONTEXT, pinned: true }), // Plan mode is safety-critical
    chunk({ id: 'auto-recall', text: autoRecall, priority: PRIORITY.TASK_CONTEXT, maxChars: 2000 }),
  ];
  // Extra task context sections can be added here

  // P5: Typed memory (adaptive, from Track 1 unified view)
  const memoryChunks = [
    chunk({ id: 'typed-memory', text: typedMemory, priority: PRIORITY.TYPED_MEMORY, maxChars: 4000 }),
  ];

  // P6: Evolved adaptive (rotating, first to truncate)
  const adaptiveChunks = [
    chunk({ id: 'evolved-adaptive', text: evolvedAdaptive, priority: PRIORITY.EVOLVED_ADAPTIVE, maxChars: 2000 }),
  ];

  // P7: Output style (optional, first to drop)
  const styleChunks = [
    chunk({ id: 'output-style', text: outputStyle, priority: PRIORITY.OUTPUT_STYLE }),
  ];

  // ── Merge all chunks ──
  const allChunks = [
    ...safetyChunks,
    ...identityChunks,
    ...stableChunks,
    ...taskChunks,
    ...memoryChunks,
    ...adaptiveChunks,
    ...styleChunks,
  ];

  // ── Enforce budget ──
  const effectiveBudget = Math.min(budget, 32_000);
  const { kept, dropped, totalChars } = enforceBudget(allChunks, effectiveBudget);

  // ── Assemble in priority order ──
  const prompt = kept
    .sort((a, b) => a.priority - b.priority)
    .map(c => c.text)
    .join('\n\n');

  // Overflow alert (pinned exceeded budget)
  const overBudget = totalChars > effectiveBudget;

  // ── Stats for /evolve budget ──
  const stats = {
    totalChars,
    budget: effectiveBudget,
    usage: Math.round((totalChars / effectiveBudget) * 100),
    overBudget,
    sections: kept.map(c => ({
      id: c.id,
      chars: c.chars,
      priority: c.priority,
      pinned: c.pinned,
    })),
    dropped: dropped.map(c => ({
      id: c.id,
      chars: c.chars,
      priority: c.priority,
    })),
  };

  return { prompt, stats };
}

// ─── Conflict Detection ──────────────────────────────────────────────────────

// Rule-based negation patterns
const NEGATION_PATTERNS = [
  { pattern: /always\s+(\w+)/gi, negation: /never\s+$1/gi },
  { pattern: /never\s+(\w+)/gi, negation: /always\s+$1/gi },
  { pattern: /do\s+not\s+(\w+)/gi, negation: /must\s+$1/gi },
  { pattern: /must\s+(\w+)/gi, negation: /do\s+not\s+$1/gi },
  { pattern: /avoid\s+(\w+)/gi, negation: /prefer\s+$1/gi },
  { pattern: /prefer\s+(\w+)/gi, negation: /avoid\s+$1/gi },
];

/**
 * Detect potential conflicts between stable and adaptive evolved content.
 * Returns array of potential conflicts (rule-based, may have false positives).
 *
 * @param {string} stableText - Stable evolved content
 * @param {string} adaptiveText - Adaptive evolved content
 * @returns {Array<{ type: string, stable: string, adaptive: string, confidence: string }>}
 */
export function detectConflicts(stableText, adaptiveText) {
  if (!stableText || !adaptiveText) return [];

  const conflicts = [];
  const stableLines = stableText.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const adaptiveLines = adaptiveText.split('\n').filter(l => l.trim() && !l.startsWith('#'));

  for (const sLine of stableLines) {
    const sLower = sLine.toLowerCase();
    for (const aLine of adaptiveLines) {
      const aLower = aLine.toLowerCase();

      // Check negation patterns
      for (const { pattern, negation } of NEGATION_PATTERNS) {
        const sMatch = sLower.match(new RegExp(pattern.source, 'gi'));
        if (sMatch) {
          for (const m of sMatch) {
            const verb = m.split(/\s+/).pop();
            if (verb && aLower.includes(verb)) {
              // Check if the adaptive line contains the negation context
              const negRe = new RegExp(negation.source.replace('$1', verb), 'gi');
              if (negRe.test(aLower)) {
                conflicts.push({
                  type: 'negation',
                  stable: sLine.trim().slice(0, 100),
                  adaptive: aLine.trim().slice(0, 100),
                  confidence: 'medium',
                });
              }
            }
          }
        }
      }
    }
  }

  // Dedupe
  const seen = new Set();
  return conflicts.filter(c => {
    const key = `${c.stable}|${c.adaptive}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Budget Display Helper ───────────────────────────────────────────────────

/**
 * Format budget stats for /evolve budget display.
 * @param {object} stats - Stats from buildGovernedPrompt
 * @returns {string}
 */
export function formatBudgetStats(stats) {
  const lines = [];
  const bar = (pct) => {
    const filled = Math.round(pct / 5);
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
  };

  lines.push(`📊 Prompt Budget: ${stats.totalChars.toLocaleString()} / ${stats.budget.toLocaleString()} chars (${stats.usage}%)`);
  lines.push(`   ${bar(stats.usage)}`);
  lines.push('');
  lines.push('   Section                  Chars   Priority  Pinned');
  lines.push('   ─────────────────────────────────────────────────');

  for (const s of stats.sections) {
    const name = s.id.padEnd(24);
    const chars = String(s.chars).padStart(5);
    const prio = `P${s.priority}`.padStart(4);
    const pin = s.pinned ? '📌' : '  ';
    lines.push(`   ${name} ${chars}   ${prio}      ${pin}`);
  }

  if (stats.dropped.length > 0) {
    lines.push('');
    lines.push('   ⚠ Dropped (over budget):');
    for (const d of stats.dropped) {
      lines.push(`     ✂ ${d.id} (${d.chars} chars, P${d.priority})`);
    }
  }

  return lines.join('\n');
}
