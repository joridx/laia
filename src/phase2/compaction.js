// src/phase2/compaction.js — LLM-powered context compaction
// Inspired by Claude Code's src/services/compact/ (compact.ts, prompt.ts, autoCompact.ts)
// Replaces the naive "drop old turns" with a 9-section LLM summary.

import { stderr } from 'process';

// ─── Compaction Prompt (adapted from Claude Code) ──────────────────────────

const COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests.

Respond with ONLY the <analysis> block followed by the <summary> block. Do NOT call any tools.`;

// ─── Parse summary from LLM response ────────────────────────────────────────

/**
 * Extract <summary> block from LLM response, stripping the <analysis> scratchpad.
 * Falls back to full text if no <summary> tags found.
 */
export function formatCompactSummary(raw) {
  if (!raw) return '[Compaction produced no output]';

  // Extract <summary>...</summary>
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match) return match[1].trim();

  // Fallback: strip <analysis>...</analysis> and return the rest
  const stripped = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  return stripped || raw.trim();
}

// ─── Build compaction conversation ───────────────────────────────────────────

/**
 * Build the messages array for the compaction LLM call.
 * We send the full conversation + the compaction prompt as the last user message.
 * @param {object} context - The context object from context.js
 * @returns {{ messages: object[], stats: { turnsBefore: number, tokensBefore: number } }}
 */
export function buildCompactionRequest(context) {
  const history = context.getHistory();
  const stats = {
    turnsBefore: context.turnCount(),
    tokensBefore: context.estimateTokens(),
  };

  // Add all history + compaction instruction as final user message
  const messages = [
    ...history,
    { role: 'user', content: COMPACT_PROMPT },
  ];

  return { messages, stats };
}

// ─── Apply compaction result ─────────────────────────────────────────────────

/**
 * Apply the LLM-generated summary to the context.
 * Replaces old messages with the summary + keeps last N turns.
 * @param {object} context - The context object
 * @param {string} summary - The formatted summary text
 * @param {number} [keepLast=4] - Number of recent turns to preserve
 */
export function applyCompaction(context, summary, keepLast = 4) {
  // Access internal state via serialize/deserialize
  const data = context.serialize();
  const { turns, messages } = data;

  // Keep the last N turns with full detail
  const keptTurns = turns.slice(-keepLast);

  // Build new messages: summary + recent user/assistant pairs
  const keptMessages = messages.slice(-(keepLast * 2)); // ~2 messages per turn
  const newMessages = [
    { role: 'system', content: `[Conversation compacted — summary follows]\n\n${summary}`, ts: Date.now() },
    ...keptMessages,
  ];

  // Apply
  context.deserialize({
    turns: keptTurns,
    messages: newMessages,
  });
}

// ─── Auto-compaction check ───────────────────────────────────────────────────

/**
 * Auto-compaction state tracker.
 * Tracks consecutive failures for circuit-breaking.
 */
export function createAutoCompactTracker() {
  let consecutiveFailures = 0;
  const MAX_FAILURES = 3;

  return {
    shouldAutoCompact(context) {
      if (consecutiveFailures >= MAX_FAILURES) return false;
      return context.needsCompaction();
    },
    onSuccess() { consecutiveFailures = 0; },
    onFailure() { consecutiveFailures++; },
    getFailures() { return consecutiveFailures; },
    reset() { consecutiveFailures = 0; },
  };
}

// ─── Main compaction flow (used by /compact and auto-compact) ────────────────

/**
 * Run LLM-powered compaction.
 * @param {object} opts
 * @param {object} opts.context - The context object
 * @param {object} opts.config - LAIA config (model, etc.)
 * @param {Function} opts.runCompactionTurn - Function to call LLM: (messages, config) => string
 * @param {boolean} [opts.silent=false] - Suppress stderr output
 * @returns {{ success: boolean, summary?: string, stats?: object, error?: string }}
 */
export async function runCompaction({ context, config, runCompactionTurn, silent = false }) {
  const log = silent ? () => {} : (msg) => stderr.write(msg);

  const { messages, stats } = buildCompactionRequest(context);

  log(`\x1b[2m[compact] ${stats.turnsBefore} turns, ~${stats.tokensBefore} tokens → compacting...\x1b[0m\n`);

  try {
    const raw = await runCompactionTurn(messages, config);
    const summary = formatCompactSummary(raw);

    if (!summary || summary.length < 50) {
      return { success: false, error: 'Compaction produced insufficient summary' };
    }

    applyCompaction(context, summary);

    const tokensAfter = context.estimateTokens();
    const reduction = Math.round((1 - tokensAfter / stats.tokensBefore) * 100);

    log(`\x1b[32m[compact] Done: ${stats.tokensBefore} → ${tokensAfter} tokens (${reduction}% reduction)\x1b[0m\n`);

    return {
      success: true,
      summary,
      stats: {
        ...stats,
        turnsAfter: context.turnCount(),
        tokensAfter,
        reductionPercent: reduction,
      },
    };
  } catch (err) {
    log(`\x1b[31m[compact] Failed: ${err.message}\x1b[0m\n`);
    return { success: false, error: err.message };
  }
}
