// src/repl.js — Thin REPL shell
// Core logic extracted to src/repl/ modules:
//   turn-runner.js   — unified turn execution with V4 hooks
//   slash-commands.js — all slash command handlers
//   ui.js            — banner, suggestions, prompt builder
//   feedback.js      — post-turn brain relevance feedback

import readline from 'readline/promises';
import { stdin, stdout, stderr } from 'process';
import { registerBuiltinTools, ensureOutlookTools } from './tools/index.js';
import { createContext } from './context.js';
import { loadFileCommands } from './skills.js';
import { startBrain, stopBrain } from './brain/client.js';
import { setReadlineInterface } from './permissions.js';
import { createRouter, routeLabel } from './router.js';
import { autoSave, loadAutoSave, deleteAutoSave, forkSession as forkSessionFn } from './session.js';
import { createAttachManager } from './attach.js';
import { createAutoCommitter } from './git-commit.js';
import { createUndoStack } from './undo.js';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { emitKeypressEvents } from 'readline';
import { createPasteStream, SENTINEL_RE } from './paste.js';
import { showCommandPicker } from './command-picker.js';

// Extracted modules
import { executeTurn } from './repl/turn-runner.js';
import { handleSlashCommand, COMMAND_META, BUILTIN_COMMANDS, formatTokenCount } from './repl/slash-commands.js';
import { animateCatBanner, suggestFollowUps } from './repl/ui.js';
import { sendFeedback } from './repl/feedback.js';
import { syncOnSessionEnd } from './memory/bridge.js';

// Simple Y/n prompt using raw mode (default Y)
async function askYesNo(rl) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stderr.write('Y (non-interactive)\n');
      return resolve(true);
    }
    const wasRaw = process.stdin.isRaw;
    if (rl) rl.pause();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      const ch = data.toString()[0]?.toLowerCase() ?? 'y';
      process.stderr.write(ch === 'n' ? 'n\n' : 'Y\n');
      process.stdin.setRawMode(wasRaw ?? false);
      if (rl) rl.resume();
      resolve(ch !== 'n');
    });
  });
}

export async function runRepl({ config, logger, planMode: initialPlanMode = false, forkSession: forkTarget = null }) {
  let planMode = initialPlanMode || config.planMode || false;
  let effort = config.effort || null;

  // Parallel startup: brain + tools register run while banner animates
  // Brain start (~700ms) and tools register (~270ms) overlap with banner animation (~810ms)
  const brainReady = startBrain({ brainPath: config.brainPath, verbose: config.verbose })
    .then(() => {
      try {
        const brainPkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'brain', 'package.json');
        const brainPkg = JSON.parse(readFileSync(brainPkgPath, 'utf8'));
        return { ok: true, version: brainPkg.version };
      } catch {
        return { ok: true, version: null };
      }
    })
    .catch(err => ({ ok: false, error: err.message }));
  const toolsReady = registerBuiltinTools({ ...config, freeze: false });
  const context = createContext();
  const fileCommands = loadFileCommands(config.commandDirs);
  const router = createRouter();
  const attachManager = createAttachManager(config.workspaceRoot);
  const autoCommitter = createAutoCommitter({ cwd: config.workspaceRoot });
  if (config.autoCommit) autoCommitter.enabled = true;
  const undoStack = createUndoStack({ workspaceRoot: config.workspaceRoot });

  const sessionTokens = { turns: 0, totalIn: 0, totalOut: 0 };

  // Session object — single bundle passed to slash commands and turn runner
  const session = {
    config, logger, context, fileCommands, attachManager,
    autoCommitter, undoStack, sessionTokens,
    planCtrl: {
      getPlanMode: () => planMode,
      setPlanMode: (v) => { planMode = v; updatePrompt(); },
    },
    effortCtrl: {
      getEffort: () => effort,
      setEffort: (v) => { effort = v; },
    },
  };

  // Build full command list for tab completion
  const allCommands = [
    ...BUILTIN_COMMANDS,
    ...[...fileCommands.keys()]
      .filter(k => !COMMAND_META[`/${k}`])
      .map(k => `/${k}`)
  ];

  function getCommandDesc(cmd) {
    if (COMMAND_META[cmd]) return COMMAND_META[cmd].desc;
    const skill = fileCommands.get(cmd.slice(1));
    if (skill?.description) return skill.description.slice(0, 40);
    return '';
  }

  let _hintDebounce = null;
  function _showCommandHints(cmds) {
    if (_hintDebounce) return;
    _hintDebounce = setTimeout(() => { _hintDebounce = null; }, 100);
    _hintDebounce.unref?.();
    const DIM = '\x1b[2m';
    const R = '\x1b[0m';
    const B = '\x1b[1m';
    const lines = cmds.slice(0, 20).map(c => {
      const d = getCommandDesc(c);
      return d ? `  ${B}${c}${R}${' '.repeat(Math.max(1, 18 - c.length))}${DIM}${d}${R}` : `  ${B}${c}${R}`;
    });
    if (cmds.length > 20) lines.push(`  ${DIM}... and ${cmds.length - 20} more${R}`);
    stderr.write('\n' + lines.join('\n') + '\n');
  }

  // Suggestion state
  let suggestions = [];
  let selectedSuggestion = -1;
  let pickerActive = false;

  function completer(line) {
    if (pickerActive) return [[], line];
    if (line.startsWith('/')) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx !== -1) {
        const cmd = line.slice(0, spaceIdx);
        const partial = line.slice(spaceIdx + 1).toLowerCase();
        const meta = COMMAND_META[cmd];
        if (meta?.subs?.length) {
          const subHits = meta.subs.filter(s => s.startsWith(partial)).map(s => `${cmd} ${s}`);
          return [subHits.length ? subHits : meta.subs.map(s => `${cmd} ${s}`), line];
        }
        return [[], line];
      }
      const exact = allCommands.filter(c => c.startsWith(line));
      if (exact.length) {
        if (exact.length > 1) _showCommandHints(exact);
        return [exact, line];
      }
      const fuzzy = allCommands.filter(c => c.includes(line.slice(1)));
      if (fuzzy.length) {
        _showCommandHints(fuzzy);
        return [fuzzy, line];
      }
      _showCommandHints(allCommands);
      return [allCommands, line];
    }
    if (!line && suggestions.length) {
      selectedSuggestion = (selectedSuggestion + 1) % suggestions.length;
      return [[suggestions[selectedSuggestion]], ''];
    }
    return [[], line];
  }

  const { stream: pasteStream, enable: enablePaste, disable: disablePaste } = createPasteStream(stdin, stdout);
  let lastModel = config.model;

  function buildPrompt() {
    const parts = [];
    if (planMode) parts.push('\x1b[33mPLAN\x1b[0m');
    const m = (lastModel || config.model || '').replace(/^claude-/, '');
    if (m) parts.push(`\x1b[2m${m}\x1b[0m`);
    const pct = context.usagePercent();
    if (pct > 0) {
      const ctxColor = pct > 80 ? '31;1' : pct > 60 ? '33;1' : '2';
      parts.push(`\x1b[${ctxColor}m${pct}%\x1b[0m`);
    }
    const badge = parts.length ? ` \x1b[2m[\x1b[0m${parts.join('\x1b[2m·\x1b[0m')}\x1b[2m]\x1b[0m` : '';
    return `\x1b[1mlaia\x1b[0m${badge}\x1b[1m>\x1b[0m `;
  }

  const rl = readline.createInterface({
    input: pasteStream,
    output: stdout,
    completer,
    prompt: buildPrompt(),
  });

  setReadlineInterface(rl);

  function updatePrompt() {
    rl.setPrompt(buildPrompt());
  }

  function showSuggestions() {
    if (!suggestions.length) return;
    const parts = suggestions.map((s, i) => {
      const marker = i === selectedSuggestion ? '\x1b[36m▸\x1b[0m' : ' ';
      return `${marker} \x1b[2m${s}\x1b[0m`;
    });
    stderr.write(`\x1b[2m  suggestions: ${parts.join('  |  ')}\x1b[0m\n`);
  }

  function clearSuggestions() {
    suggestions = [];
    selectedSuggestion = -1;
  }

  // Fork or autosave restore
  if (forkTarget) {
    const forked = forkSessionFn(forkTarget);
    if (forked && !forked.error) {
      const ok = context.deserialize(forked);
      if (ok) {
        stderr.write(`\x1b[32m🔀 Forked from ${forked.forkedFrom?.slice(0,8) ?? '?'} → ${forked.sessionId?.slice(0,8) ?? '?'} (${forked.turns?.length ?? 0} turns)\x1b[0m\n`);
      } else {
        stderr.write('\x1b[33m⚠ Failed to fork session\x1b[0m\n');
      }
    } else {
      stderr.write(`\x1b[33m⚠ Session not found: ${forkTarget}\x1b[0m\n`);
    }
  } else {
    const autosaveData = loadAutoSave();
    if (autosaveData && !autosaveData.error && autosaveData.turns?.length > 0) {
      stderr.write(`\x1b[2m[session] Found autosave (${autosaveData.turns.length} turns from ${autosaveData.savedAt ?? '?'})\x1b[0m\n`);
      stderr.write('\x1b[33mRestore previous session? [Y/n] \x1b[0m');
      const restore = await askYesNo(rl);
      if (restore) {
        const ok = context.deserialize(autosaveData);
        if (ok) {
          stderr.write(`\x1b[32m✓ Restored ${autosaveData.turns.length} turns\x1b[0m\n`);
        } else {
          stderr.write('\x1b[33m⚠ Failed to restore session\x1b[0m\n');
        }
      } else {
        deleteAutoSave();
      }
    }
  }

  const sessionMeta = {
    sessionId: logger.sessionId,
    model: config.model,
    workspaceRoot: config.workspaceRoot,
  };

  // --- Esc key interrupt ---
  let turnAbort = null;
  let stopSpinnerRef = null;
  function onEscKeypress(_ch, key) {
    if (key && key.name === 'escape' && turnAbort && !turnAbort.signal.aborted) {
      turnAbort.abort();
      if (stopSpinnerRef) stopSpinnerRef();
      stderr.write('\n\x1b[33m⏸  Interrupted (Esc). Waiting for your input.\x1b[0m\n');
    }
  }
  if (stdin.isTTY) {
    emitKeypressEvents(pasteStream, rl);
    pasteStream.on('keypress', onEscKeypress);

    pasteStream.on('keypress', async (_ch, key) => {
      if (pickerActive) return;
      if (key && key.name === 'tab' && rl.line && rl.line.startsWith('/')) {
        pickerActive = true;
        try {
          const currentFilter = rl.line.slice(1);
          const pickerItems = allCommands.map(cmd => {
            const meta = COMMAND_META[cmd];
            const skill = !meta ? fileCommands.get(cmd.slice(1)) : null;
            return {
              name: cmd,
              desc: meta?.desc || skill?.description?.slice(0, 50) || '',
              cat: meta?.cat || 'skills',
            };
          });
          const picked = await showCommandPicker({
            items: pickerItems, filter: currentFilter, rl, stdin, stderr,
          });
          if (picked) {
            rl.write(null, { ctrl: true, name: 'u' });
            rl.write(picked + ' ');
          }
        } finally {
          pickerActive = false;
        }
      }
    });
  }

  // Banner animates while brain + tools finish in background
  // Use allSettled to ensure brainReady is always awaited even if toolsReady rejects
  const [bannerS, toolsS, brainS] = await Promise.allSettled([
    animateCatBanner(config, planMode, fileCommands),
    toolsReady,
    brainReady,
  ]);

  // Banner failure is non-fatal (cosmetic only)
  if (bannerS.status === 'rejected' && config.verbose) {
    stderr.write(`\x1b[2m[banner] ${bannerS.reason?.message ?? 'unknown error'}\x1b[0m\n`);
  }

  // Tools failure is fatal — rethrow
  if (toolsS.status === 'rejected') throw toolsS.reason;

  // Report brain status (resolved during banner animation)
  const brainResult = brainS.status === 'fulfilled' ? brainS.value : { ok: false, error: brainS.reason?.message ?? 'unknown' };
  if (brainResult.ok) {
    const label = brainResult.version ? `v${brainResult.version}` : '';
    stderr.write(`\x1b[2m🧠 LAIA Brain MCP Server ${label}\x1b[0m\n`);
  } else {
    stderr.write(`\x1b[33m[brain] Failed to start: ${brainResult.error} (brain tools disabled)\x1b[0m\n`);
  }

  enablePaste();
  process.on('exit', disablePaste);
  process.on('SIGINT', disablePaste);
  process.on('SIGTERM', disablePaste);
  rl.prompt();

  rl.on('close', async () => {
    if (stdin.isTTY) pasteStream.off('keypress', onEscKeypress);
    disablePaste();
    if (context.turnCount() > 0) {
      try {
        autoSave(context.serialize(), sessionMeta);
        stderr.write('\x1b[2m[session] Auto-saved\x1b[0m\n');
      } catch {}
    }
    // Memory bridge: promote confirmed feedback → brain (only if brain is available)
    try {
      // TODO: wire brainRemember from brain client when available
      // For now, syncOnSessionEnd gracefully skips if brainRemember is null
      await syncOnSessionEnd({ stderr });
    } catch {}
    await stopBrain();
    process.exit(0);
  });

  // === Main loop ===
  for await (const line of rl) {
    let input = line.replace(SENTINEL_RE, '\n').trim();

    if (!input && selectedSuggestion >= 0 && suggestions[selectedSuggestion]) {
      input = suggestions[selectedSuggestion];
      stderr.write(`\x1b[2m  → ${input}\x1b[0m\n`);
    }
    clearSuggestions();
    if (!input) { rl.prompt(); continue; }

    // Bang commands — execute shell directly without LLM roundtrip
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (cmd) {
        try {
          const { execSync } = await import('child_process');
          const output = execSync(cmd, {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          if (output) stdout.write(output);
        } catch (err) {
          stderr.write(`\x1b[31m${err.stderr || err.message}\x1b[0m\n`);
        }
      }
      rl.prompt(); continue;
    }

    // Slash commands
    if (input.startsWith('/')) {
      const result = await handleSlashCommand(input, session);
      if (result) {
        // If a skill turn was executed, do post-turn accounting
        if (result.turnResult) {
          const tr = result.turnResult;
          sendFeedback(tr.turnMessages, tr.text).catch(e => {
            if (config.verbose) console.error('[feedback]', e.message);
          });
          suggestions = suggestFollowUps(tr.text);
          selectedSuggestion = 0;
          showSuggestions();
          if (tr.usage) {
            const inTok = tr.usage.input_tokens ?? tr.usage.prompt_tokens ?? 0;
            const outTok = tr.usage.output_tokens ?? tr.usage.completion_tokens ?? 0;
            sessionTokens.turns++;
            sessionTokens.totalIn += (typeof inTok === 'number' ? inTok : 0);
            sessionTokens.totalOut += (typeof outTok === 'number' ? outTok : 0);
            const pct = context.usagePercent();
            const ctxColor = pct > 80 ? '31;1' : pct > 60 ? '33;1' : '32';
            const totalStr = formatTokenCount(sessionTokens.totalIn + sessionTokens.totalOut);
            stderr.write(`\x1b[2m[${inTok} in / ${outTok} out ·\x1b[0m \x1b[${ctxColor}m${pct}% ctx\x1b[0m\x1b[2m · Σ${totalStr}]\x1b[0m\n`);
          }
        }
        updatePrompt(); rl.prompt(); continue;
      }
    }

    // Normal prompt — use unified executeTurn
    try {
      // Lazy-load Outlook tools if input mentions email/calendar keywords
      if (/\b(outlook|e-?mails?|correus?|inbox|calendar|calendari|drafts?|borrador|unread|schedule|agenda)\b/i.test(typeof input === 'string' ? input : input.text)) {
        await ensureOutlookTools(config);
      }

      const effectiveConfig = { ...config };
      // Pass coordinator to system prompt builder if active
      if (session.coordinator?.isActive()) {
        effectiveConfig.coordinator = session.coordinator;
      }
      let corporateHint = null;
      if (config.model === 'auto') {
        const decision = router.route(input);
        effectiveConfig.model = decision.model;
        lastModel = decision.model;
        corporateHint = decision.corporateHint;
        stderr.write(`\x1b[2m[auto → ${decision.model} · ${routeLabel(decision)}]\x1b[0m\n`);
      }

      // Prepend attached files
      const ctx = attachManager.buildContext();
      let llmInput;
      if (!ctx) {
        llmInput = input;
      } else if (!ctx.images.length) {
        llmInput = ctx.text + 'User request: ' + input;
      } else {
        llmInput = {
          text: (ctx.text ? ctx.text + 'User request: ' : '') + input,
          images: ctx.images,
        };
      }

      turnAbort = new AbortController();
      const result = await executeTurn({
        input: llmInput,
        config: effectiveConfig,
        logger,
        context,
        undoStack,
        autoCommitter,
        signal: turnAbort.signal,
        planMode,
        effort,
        corporateHint,
      });

      // Feedback (fire-and-forget)
      sendFeedback(result.turnMessages, result.text).catch(e => {
        if (config.verbose) console.error('[feedback]', e.message);
      });

      // Update router stickiness
      if (config.model === 'auto' && result.turnMessages) {
        const toolNames = result.turnMessages
          .filter(m => m.tool_calls)
          .flatMap(m => m.tool_calls.map(tc => tc.function?.name ?? ''));
        router.recordToolsUsed(toolNames);
      }

      // Show follow-up suggestions
      suggestions = suggestFollowUps(result.text);
      selectedSuggestion = 0;
      showSuggestions();

      // Token accounting
      if (result.usage) {
        const inTok = result.usage.input_tokens ?? result.usage.prompt_tokens ?? 0;
        const outTok = result.usage.output_tokens ?? result.usage.completion_tokens ?? 0;
        sessionTokens.turns++;
        sessionTokens.totalIn += (typeof inTok === 'number' ? inTok : 0);
        sessionTokens.totalOut += (typeof outTok === 'number' ? outTok : 0);
        const pct = context.usagePercent();
        const ctxColor = pct > 80 ? '31;1' : pct > 60 ? '33;1' : '32';
        const totalStr = formatTokenCount(sessionTokens.totalIn + sessionTokens.totalOut);
        stderr.write(`\x1b[2m[${inTok} in / ${outTok} out ·\x1b[0m \x1b[${ctxColor}m${pct}% ctx\x1b[0m\x1b[2m · Σ${totalStr}]\x1b[0m\n`);
      }

      // Auto-compaction warning (post-turn)
      const ctxPct = context.usagePercent();
      if (ctxPct > 80) {
        stderr.write(`\x1b[33m⚠ Context ${ctxPct}% full — consider running /compact for LLM-powered summarization\x1b[0m\n`);
      }
    } catch (err) {
      const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || turnAbort?.signal?.aborted;
      if (isAbort) {
        // Don't log abort as error
      } else {
        logger.error('turn_error', { error: err.message, full: err.stack, input });
        stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        stderr.write('\x1b[33m(Turn aborted due to error. Check logs for details.)\x1b[0m\n');
      }
    } finally {
      turnAbort = null;
      stopSpinnerRef = null;
    }

    updatePrompt();
    rl.prompt();
  }
}
