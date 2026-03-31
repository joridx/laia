// src/repl/turn-runner.js
// Unified turn execution — extracted from repl.js to eliminate duplication
// and provide pre/post turn hooks for V4 evolution features.

import { runTurn, printStep } from '../agent.js';
import { renderMarkdown } from '../render.js';
import { resolve as resolvePath } from 'path';
import { stderr } from 'process';

// Spinner helper (self-contained)
function createSpinner() {
  const chars = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let timer = null;
  let frame = 0;
  const isTTY = stderr.isTTY;
  return {
    start() {
      if (timer || !isTTY) return;
      stderr.write('\n');
      timer = setInterval(() => {
        stderr.write(`\r\x1b[36m${chars[frame++ % chars.length]}\x1b[0m`);
      }, 80);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; stderr.write('\r\x1b[0K\x1b[1A\x1b[0K'); }
    },
  };
}

/**
 * Execute a single agent turn. Unifies main-loop and slash-command turn paths.
 *
 * @param {object} opts
 * @param {string|object} opts.input - User input (string or {text, images})
 * @param {object} opts.config - Effective config for this turn (may have routed model)
 * @param {object} opts.logger - Session logger
 * @param {object} opts.context - Conversation context (getHistory, addTurn, etc)
 * @param {object} opts.undoStack - Undo stack (startTurn, trackFile, commitTurn)
 * @param {object} opts.autoCommitter - Git auto-committer (trackFile, commitIfNeeded)
 * @param {AbortSignal} [opts.signal] - Abort signal for cancellation
 * @param {boolean} [opts.planMode] - Read-only mode
 * @param {string|null} [opts.effort] - Reasoning effort level
 * @param {string|null} [opts.corporateHint] - Router corporate hint
 * @param {object} [opts.hooks] - V4 lifecycle hooks
 * @param {function} [opts.hooks.preTurn] - Called before runTurn (async)
 * @param {function} [opts.hooks.postTurn] - Called after runTurn with result (async)
 * @param {function} [opts.hooks.onStep] - Additional step handler (called alongside default)
 *
 * @returns {Promise<{text: string, usage: object|null, turnMessages: array, suggestions: string[]}>}
 */
export async function executeTurn({
  input, config, logger, context, undoStack, autoCommitter,
  signal, planMode, effort, corporateHint, hooks = {},
}) {
  const spinner = createSpinner();
  let streamBuf = '';

  // --- Pre-turn hook (V4: scorecard start, procedural memory lookup) ---
  if (hooks.preTurn) {
    try { await hooks.preTurn({ input, config }); } catch {}
  }

  // Prepare context
  context.addUser(typeof input === 'string' ? input : input.text);
  if (context.needsCompaction()) context.compact();
  undoStack.startTurn();

  try {
    const result = await runTurn({
      input, config, logger,
      history: context.getHistory(),
      corporateHint, planMode, effort, signal,
      onStep: (step) => {
        if (step.type === 'token') {
          streamBuf += step.text;
          spinner.start();
        } else {
          if (step.type === 'tool_call') spinner.stop();
          // Track files for auto-commit + undo
          if (step.type === 'tool_result' && (step.name === 'write' || step.name === 'edit') && step.result?.path) {
            autoCommitter.trackFile(step.result.path);
          }
          if (step.type === 'tool_call' && (step.name === 'write' || step.name === 'edit') && step.args?.path) {
            undoStack.trackFile(resolvePath(config.workspaceRoot, step.args.path));
          }
          printStep(step);
          // Additional step handler
          if (hooks.onStep) hooks.onStep(step);
        }
      },
    });

    const text = result.text || '';
    spinner.stop();

    // Render output
    if (text) {
      console.log(`\n${renderMarkdown(text)}\n`);
    } else {
      stderr.write('\x1b[33m⚠ (empty response — model returned no text)\x1b[0m\n');
    }

    // Finalize undo + context
    undoStack.commitTurn();
    context.addTurn({
      assistantText: text,
      turnMessages: result.turnMessages,
    });

    // Auto-commit
    let commitInfo = null;
    const commitResult = autoCommitter.commitIfNeeded(text);
    if (commitResult?.hash) {
      stderr.write(`\x1b[2m[git] ${commitResult.hash} — ${commitResult.message}\x1b[0m\n`);
      commitInfo = commitResult;
    } else if (commitResult?.error) {
      stderr.write(`\x1b[33m[git] commit failed: ${commitResult.error}\x1b[0m\n`);
    }

    // --- Post-turn hook (V4: reflection, feedback, scorecard) ---
    if (hooks.postTurn) {
      try { await hooks.postTurn({ text, result, commitInfo }); } catch {}
    }

    return {
      text,
      usage: result.usage || null,
      turnMessages: result.turnMessages || [],
    };
  } catch (err) {
    spinner.stop();
    throw err; // Let caller handle abort vs real errors
  }
}
