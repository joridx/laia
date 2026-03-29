import readline from 'readline/promises';
import { stdin, stdout, stderr } from 'process';
import { registerBuiltinTools, defaultRegistry } from './tools/index.js';
import { runTurn, printStep } from './agent.js';
import { createContext } from './context.js';
import { loadFileCommands, expandCommand, listSkills, loadSkill } from './skills.js';
import { getCopilotToken, getProviderToken } from './auth.js';
import { detectProvider, getProvider, resolveUrl, buildAuthHeaders } from '@claude/providers';
import { startBrain, stopBrain, brainFeedback } from './brain/client.js';
import { setReadlineInterface } from './permissions.js';
import { renderMarkdown } from './render.js';
import { loadMemoryFiles } from './memory-files.js';
import { createRouter, routeLabel, MODEL_IDS } from './router.js';
import { saveSession, autoSave, loadAutoSave, loadSession, listSessions, deleteAutoSave, forkSession as forkSessionFn } from './session.js';
import { createAttachManager } from './attach.js';
import { createAutoCommitter } from './git-commit.js';
import { createUndoStack } from './undo.js';
import { resolve as resolvePath, dirname, join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { emitKeypressEvents } from 'readline';
import { createPasteStream, SENTINEL_RE } from './paste.js';

import { loadProfile, listProfiles } from './profiles.js';
import { normalizeEffort } from './config.js';

// --- Slash command list for autocomplete ---
const BUILTIN_COMMANDS = ['/help', '/model', '/clear', '/compact', '/save', '/load', '/sessions', '/attach', '/detach', '/attached', '/swarm', '/autocommit', '/undo', '/tokens', '/plan', '/execute', '/effort', '/fork', '/agents', '/skills', '/exit', '/quit'];

// --- Human-readable token count (e.g. 1234 → "1.2k", 1234567 → "1.2M") ---
function formatTokenCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// --- Heuristic follow-up suggestions based on assistant response ---

// --- P15.2: Post-turn implicit relevance feedback ---
const FEEDBACK_MIN_RESPONSE = 50;
async function sendFeedback(turnMessages, responseText) {
  if (!turnMessages || !responseText) return;

  // Clean response: strip code blocks, markdown links, table borders
  const cleaned = responseText.slice(0, 2000);
  if (cleaned.length < FEEDBACK_MIN_RESPONSE) return;

  // Find all brain_search tool calls in the turn
  const searchCalls = [];
  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i];
    if (!msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const fn = tc.function;
      if (!fn || fn.name !== 'brain_search') continue;
      // The result is in the next message(s) with matching tool_call_id
      const resultMsg = turnMessages.find(m => m.role === 'tool' && m.tool_call_id === tc.id);
      if (!resultMsg?.content) continue;
      try {
        const args = JSON.parse(fn.arguments || '{}');
        const result = JSON.parse(resultMsg.content);
        searchCalls.push({ query: args.query, result });
      } catch { /* skip malformed */ }
    }
  }
  if (!searchCalls.length) return;

  const isMulti = searchCalls.length > 1;
  const globalUsed = new Set();

  for (const call of searchCalls) {
    // Extract learnings from result (handle various formats)
    const learnings = extractLearningsFromResult(call.result);
    if (!learnings.length) continue;

    const slugs = learnings.map(l => l.slug);
    const titles = learnings.map(l => l.title);
    const explorationSlugs = learnings.filter(l => l._exploration).map(l => l.slug);

    // Quick check: does this search have any "used" results?
    // For multi-search turns, skip if no usage (avoid cross-contamination)
    if (isMulti) {
      const hasUsage = slugs.some(s => {
        if (globalUsed.has(s)) return false;
        const title = titles[slugs.indexOf(s)] || s.replace(/-/g, ' ');
        return cleaned.toLowerCase().includes(s) || cleaned.toLowerCase().includes(title.toLowerCase());
      });
      if (!hasUsage) continue;
    }

    // Filter out already-counted slugs (max 1 hit per learning per turn)
    const dedupedSlugs = slugs.filter(s => !globalUsed.has(s));
    const dedupedTitles = dedupedSlugs.map(s => titles[slugs.indexOf(s)]);

    try {
      await brainFeedback({
        query: call.query,
        result_slugs: dedupedSlugs,
        result_titles: dedupedTitles,
        exploration_slugs: explorationSlugs.filter(s => dedupedSlugs.includes(s)),
        response: cleaned,
      });
      // Only add actually sent slugs that were used — not all, to avoid suppressing
      // appearances/misses in subsequent same-turn searches
      dedupedSlugs.forEach(s => globalUsed.add(s));
    } catch (e) {
      // Feedback is best-effort; log in debug mode via environment
      if (process.env.DEBUG) console.error('[feedback]', call.query, e.message);
    }
  }
}

// Extract learning slugs/titles from brain_search result (handles string or object)
function extractLearningsFromResult(result) {
  // result might be a string or already parsed
  let data = result;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return []; }
  }
  if (!data) return [];

  // Format: { result: "..." } or { query, result } from brain tool wrapper
  const text = data.result || data;
  if (typeof text === 'string') {
    const learnings = [];

    // Primary format: "- **Title** [slug-name] (score:...)"
    const primaryMatches = text.matchAll(/[-•]\s+\*\*(.+?)\*\*\s+\[([a-z0-9-]+)\]/g);
    for (const m of primaryMatches) {
      learnings.push({ slug: m[2], title: m[1] });
    }
    if (learnings.length) return learnings;

    // Fallback: "- **Title** (score:... | ...)"
    // Derive slug from title via simple slugification
    const fallbackMatches = text.matchAll(/[-•]\s+\*\*(.+?)\*\*\s*\(/g);
    for (const m of fallbackMatches) {
      const title = m[1].trim();
      const slug = title.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
      if (slug) learnings.push({ slug, title });
    }
    return learnings;
  }

  // Object format with learnings array
  if (Array.isArray(data.learnings)) {
    return data.learnings.map(l => ({
      slug: l.slug || '',
      title: l.title || l.headline || '',
      _exploration: l._exploration || false,
    }));
  }
  return [];
}

function suggestFollowUps(text) {
  if (!text) return [];
  const s = [];
  if (/error|fail|exception|bug|issue/i.test(text)) {
    s.push('Explain the root cause');
    s.push('Fix this issue');
    s.push('Add a test to prevent this');
  } else if (/created|wrote|written|saved/i.test(text)) {
    s.push('Read the file to verify');
    s.push('Run tests');
    s.push('What should I do next?');
  } else if (/found|match|result|files?:/i.test(text)) {
    s.push('Show me the most relevant one');
    s.push('Summarize the findings');
    s.push('Search for something else');
  } else if (/plan|steps|approach|architecture/i.test(text)) {
    s.push('Implement step 1');
    s.push('What are the edge cases?');
    s.push('Turn this into a checklist');
  } else {
    s.push('Tell me more');
    s.push('Show the code');
    s.push('What should I do next?');
  }
  return s.slice(0, 3);
}

export async function runRepl({ config, logger, planMode: initialPlanMode = false, forkSession: forkTarget = null }) {
  // Plan mode state (togglable via /plan and /execute)
  let planMode = initialPlanMode || config.planMode || false;

  // V2: Effort state (togglable via /effort)
  let effort = config.effort || null;
  // Start brain MCP server
  try {
    await startBrain({ brainPath: config.brainPath, verbose: config.verbose });
    // Show brain version line (read from brain's package.json)
    try {
      const brainPkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'claude-local-brain', 'mcp-server', 'package.json');
      const brainPkg = JSON.parse(readFileSync(brainPkgPath, 'utf8'));
      stderr.write(`\x1b[2m🧠 Claude Brain MCP Server v${brainPkg.version}\x1b[0m\n`);
    } catch {
      stderr.write('\x1b[2m🧠 Claude Brain MCP Server\x1b[0m\n');
    }
  } catch (err) {
    stderr.write(`\x1b[33m[brain] Failed to start: ${err.message} (brain tools disabled)\x1b[0m\n`);
  }

  await registerBuiltinTools({ ...config, freeze: false });
  const context = createContext();
  const fileCommands = loadFileCommands(config.commandDirs);
  const router = createRouter();
  const attachManager = createAttachManager(config.workspaceRoot);
  const autoCommitter = createAutoCommitter({ cwd: config.workspaceRoot });
  if (config.autoCommit) autoCommitter.enabled = true;
  const undoStack = createUndoStack({ workspaceRoot: config.workspaceRoot });

  // Session-wide token accumulator
  const sessionTokens = { turns: 0, totalIn: 0, totalOut: 0 };

  // Build full command list for tab completion
  const allCommands = [...BUILTIN_COMMANDS, ...[...fileCommands.keys()].map(k => `/${k}`)];

  // Suggestion state
  let suggestions = [];
  let selectedSuggestion = -1;

  function completer(line) {
    if (line.startsWith('/')) {
      const hits = allCommands.filter(c => c.startsWith(line));
      return [hits.length ? hits : allCommands, line];
    }
    // Tab with empty line cycles suggestions
    if (!line && suggestions.length) {
      selectedSuggestion = (selectedSuggestion + 1) % suggestions.length;
      return [[suggestions[selectedSuggestion]], ''];
    }
    return [[], line];
  }

  // Bracketed paste: intercept paste markers, replace \n with sentinel
  const { stream: pasteStream, enable: enablePaste, disable: disablePaste } = createPasteStream(stdin, stdout);

  const rl = readline.createInterface({
    input: pasteStream,
    output: stdout,
    completer,
    prompt: planMode ? '\x1b[33m[PLAN]\x1b[0m \x1b[1mclaudia>\x1b[0m ' : '\x1b[1mclaudia>\x1b[0m ',
  });

  // Register readline with permission system so it pauses during prompts
  setReadlineInterface(rl);

  // Helper to update prompt badge when plan mode toggles
  function updatePrompt() {
    rl.setPrompt(planMode ? '\x1b[33m[PLAN]\x1b[0m \x1b[1mclaudia>\x1b[0m ' : '\x1b[1mclaudia>\x1b[0m ');
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

  // V2: --fork startup: load session, assign new ID, skip autosave
  if (forkTarget) {
    const forked = forkSessionFn(forkTarget);
    if (forked && !forked.error) {
      const ok = context.deserialize(forked);
      if (ok) {
        stderr.write(`\x1b[32m🔀 Forked from ${forked.forkedFrom?.slice(0,8) ?? '?'} → ${forked.sessionId?.slice(0,8) ?? '?'} (${forked.turns?.length ?? 0} turns)\x1b[0m\n`);
      } else {
        stderr.write(`\x1b[33m⚠ Failed to fork session\x1b[0m\n`);
      }
    } else {
      stderr.write(`\x1b[33m⚠ Session not found: ${forkTarget}\x1b[0m\n`);
    }
  } else {
  // Try to restore autosave on startup
  const autosaveData = loadAutoSave();
  if (autosaveData && !autosaveData.error && autosaveData.turns?.length > 0) {
    stderr.write(`\x1b[2m[session] Found autosave (${autosaveData.turns.length} turns from ${autosaveData.savedAt ?? '?'})\x1b[0m\n`);
    stderr.write(`\x1b[33mRestore previous session? [Y/n] \x1b[0m`);
    const restore = await askYesNo(rl);
    if (restore) {
      const ok = context.deserialize(autosaveData);
      if (ok) {
        stderr.write(`\x1b[32m✓ Restored ${autosaveData.turns.length} turns\x1b[0m\n`);
      } else {
        stderr.write(`\x1b[33m⚠ Failed to restore session\x1b[0m\n`);
      }
    } else {
      deleteAutoSave();
    }
  }
  } // end of fork/autosave if-else

  // Session metadata for saves
  const sessionMeta = {
    sessionId: logger.sessionId,
    model: config.model,
    workspaceRoot: config.workspaceRoot,
  };

  // --- Esc key interrupt support ---
  let turnAbort = null;  // AbortController for current turn
  let stopSpinnerRef = null;  // reference to current turn's stopSpinner for immediate cleanup
  function onEscKeypress(_ch, key) {
    if (key && key.name === 'escape' && turnAbort && !turnAbort.signal.aborted) {
      turnAbort.abort();
      if (stopSpinnerRef) stopSpinnerRef();  // immediate spinner cleanup
      stderr.write('\n\x1b[33m⏸  Interrupted (Esc). Waiting for your input.\x1b[0m\n');
    }
  }
  if (stdin.isTTY) {
    emitKeypressEvents(pasteStream, rl);
    pasteStream.on('keypress', onEscKeypress);
  }

  await animateCatBanner(config, planMode);
  enablePaste();
  process.on('exit', disablePaste);
  process.on('SIGINT', disablePaste);
  process.on('SIGTERM', disablePaste);
  rl.prompt();

  rl.on('close', async () => {
    // Clean up keypress listener + paste mode
    if (stdin.isTTY) pasteStream.off('keypress', onEscKeypress);
    disablePaste();
    // Auto-save on exit if there are turns
    if (context.turnCount() > 0) {
      try {
        autoSave(context.serialize(), sessionMeta);
        stderr.write('\x1b[2m[session] Auto-saved\x1b[0m\n');
      } catch {}
    }
    await stopBrain();
    process.exit(0);
  });

  for await (const line of rl) {
    // Restore real newlines from paste sentinel, then trim
    let input = line.replace(SENTINEL_RE, '\n').trim();

    // If empty input + suggestion selected → use suggestion
    if (!input && selectedSuggestion >= 0 && suggestions[selectedSuggestion]) {
      input = suggestions[selectedSuggestion];
      stderr.write(`\x1b[2m  → ${input}\x1b[0m\n`);
    }

    clearSuggestions();

    if (!input) { rl.prompt(); continue; }

    // Slash commands
    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, config, logger, context, fileCommands, attachManager, autoCommitter, undoStack, { getPlanMode: () => planMode, setPlanMode: (v) => { planMode = v; updatePrompt(); } }, { getEffort: () => effort, setEffort: (v) => { effort = v; } });
      if (handled) { rl.prompt(); continue; }
    }

    // Normal prompt
    try {
      // Auto-routing: pick best model per turn when config.model === 'auto'
      const effectiveConfig = { ...config };
      let corporateHint = null;
      if (config.model === 'auto') {
        const decision = router.route(input);
        effectiveConfig.model = decision.model;
        corporateHint = decision.corporateHint;
        stderr.write(`\x1b[2m[auto → ${decision.model} · ${routeLabel(decision)}]\x1b[0m\n`);
      }

      let streamed = false;
      let streamBuf = '';  // accumulates ALL streamed text (not just last fragment)
      let spinnerTimer = null;
      let spinnerFrame = 0;
      const spinnerChars = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
      function startSpinner() {
        if (spinnerTimer) return;
        // Write spinner on its own line to avoid overwriting user input
        stderr.write('\n');
        spinnerTimer = setInterval(() => {
          const ch = spinnerChars[spinnerFrame++ % spinnerChars.length];
          stderr.write(`\r\x1b[36m${ch}\x1b[0m`);
        }, 80);
      }
      function stopSpinner() {
        if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; stderr.write('\r\x1b[0K\x1b[1A\x1b[0K'); }
      }
      stopSpinnerRef = stopSpinner;  // expose to Esc handler
      // Prepend attached files to input for LLM context
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

      // addUser BEFORE runTurn so getHistory() includes it; addTurn AFTER stores the rest atomically
      context.addUser(typeof llmInput === 'string' ? llmInput : llmInput.text);
      if (context.needsCompaction()) context.compact();
      undoStack.startTurn();

      turnAbort = new AbortController();
      const result = await runTurn({
        input: llmInput,
        config: effectiveConfig,
        logger,
        history: context.getHistory(),
        corporateHint,
        planMode,
        effort,
        signal: turnAbort.signal,
        onStep: (step) => {
          if (step.type === 'token') {
            streamed = true;
            streamBuf += step.text;
            startSpinner();  // visual feedback without raw markdown
          } else {
            if (step.type === 'tool_call') {
              stopSpinner();
            }
            // Track files modified by write/edit for auto-commit + undo
            if (step.type === 'tool_result' && (step.name === 'write' || step.name === 'edit') && step.result?.path) {
              autoCommitter.trackFile(step.result.path);
            }
            if (step.type === 'tool_call' && (step.name === 'write' || step.name === 'edit') && step.args?.path) {
              undoStack.trackFile(resolvePath(config.workspaceRoot, step.args.path));
            }
            printStep(step);
          }
        },
      });
      const text = result.text || '';
      stopSpinner();
      if (text) {
        console.log(`\n${renderMarkdown(text)}\n`);
      } else {
        stderr.write('\x1b[33m⚠ (empty response — model returned no text)\x1b[0m\n');
      }
      undoStack.commitTurn();
      // Atomic: store full tool transcript + assistant reply together (user already added above)
      context.addTurn({
        assistantText: text,
        turnMessages: result.turnMessages,
      });

      // P15.2: Implicit relevance feedback — fire-and-forget with minimal logging
      sendFeedback(result.turnMessages, text).catch(e => {
        if (config.verbose) console.error('[feedback]', e.message);
      });

      // Update router stickiness based on tools actually used
      if (config.model === 'auto' && result.turnMessages) {
        const toolNames = result.turnMessages
          .filter(m => m.tool_calls)
          .flatMap(m => m.tool_calls.map(tc => tc.function?.name ?? ''));
        router.recordToolsUsed(toolNames);
      }

      // Auto-commit agent changes if enabled
      const commitResult = autoCommitter.commitIfNeeded(text);
      if (commitResult?.hash) {
        stderr.write(`\x1b[2m[git] ${commitResult.hash} — ${commitResult.message}\x1b[0m\n`);
      } else if (commitResult?.error) {
        stderr.write(`\x1b[33m[git] commit failed: ${commitResult.error}\x1b[0m\n`);
      }

      // Show follow-up suggestions
      suggestions = suggestFollowUps(text);
      selectedSuggestion = 0;
      showSuggestions();
      if (result.usage) {
        const inTok = result.usage.input_tokens ?? result.usage.prompt_tokens ?? 0;
        const outTok = result.usage.output_tokens ?? result.usage.completion_tokens ?? 0;
        // Accumulate session totals
        sessionTokens.turns++;
        sessionTokens.totalIn += (typeof inTok === 'number' ? inTok : 0);
        sessionTokens.totalOut += (typeof outTok === 'number' ? outTok : 0);
        const pct = context.usagePercent();
        const ctxColor = pct > 80 ? '31;1' : pct > 60 ? '33;1' : '32'; // red bold / yellow bold / green
        const totalStr = formatTokenCount(sessionTokens.totalIn + sessionTokens.totalOut);
        stderr.write(`\x1b[2m[${inTok} in / ${outTok} out ·\x1b[0m \x1b[${ctxColor}m${pct}% ctx\x1b[0m\x1b[2m · Σ${totalStr}]\x1b[0m\n`);
      }
    } catch (err) {
      const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || turnAbort?.signal?.aborted;
      if (isAbort) {
        if (stopSpinnerRef) stopSpinnerRef();
        // Don't log abort as error — user intentionally interrupted
      } else {
        // Structured error reporting
        logger.error('turn_error', { error: err.message, full: err.stack, input });
        // Surface error to user as visible message
        stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        stderr.write(`\x1b[33m(Turn aborted due to error. Check logs for details.)\x1b[0m\n`);
      }
    } finally {
      turnAbort = null;
      stopSpinnerRef = null;
    }

    rl.prompt();
  }
}

async function handleSlashCommand(input, config, logger, context, fileCommands, attachManager, autoCommitter, undoStack, planCtrl = {}, effortCtrl = {}) {
  const spaceIdx = input.indexOf(' ');
  const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();

  switch (name) {
    case 'help':
      console.log('Built-in commands: /help /model /clear /compact /save /load /sessions /attach /detach /attached /swarm /autocommit /undo /tokens /plan /execute /exit');
      console.log('Session: /save [name], /load [name|number], /sessions');
      console.log('Attach: /attach <path|glob>, /detach <path|name|number|all>, /attached');
      console.log('Undo: /undo — revert files changed in last turn (up to 10 turns)');
      console.log('Tokens: /tokens — show session token usage and context window stats');
      console.log('Plan: /plan — read-only mode (no write/edit/bash), /execute — back to normal');
      console.log('Effort: /effort <low|medium|high|max> — set reasoning effort, /effort — show current');
      console.log('Agents: /agents — list profiles, /agents show|validate|create <name>');
      console.log('Skills: /skills — list all skills (v3 + legacy), /skills show <name>');
      console.log('File commands: ' + [...fileCommands.keys()].map(k => `/${k}`).join(', '));
      console.log('\nTip: Tab to autocomplete commands. After a response, Tab to cycle suggestions.');
      return true;

    case 'model':
      await handleModelCommand(args, config);
      return true;

    case 'clear':
      context.clear();
      console.log('History cleared.');
      return true;

    case 'compact':
      context.compact();
      console.log('History compacted.');
      return true;

    case 'exit':
    case 'quit':
      // Auto-save on exit
      if (context.turnCount() > 0) {
        try {
          autoSave(context.serialize(), { sessionId: '', model: config.model, workspaceRoot: config.workspaceRoot });
          stderr.write('\x1b[2m[session] Auto-saved\x1b[0m\n');
        } catch {}
      }
      await stopBrain();
      console.log('Bye!');
      process.exit(0);

    case 'save': {
      if (context.turnCount() === 0) {
        stderr.write('\x1b[33mNothing to save (no turns yet)\x1b[0m\n');
        return true;
      }
      const meta = { sessionId: '', model: config.model, workspaceRoot: config.workspaceRoot, name: args || '' };
      try {
        const filepath = saveSession(context.serialize(), meta);
        stderr.write(`\x1b[32m✓ Session saved: ${filepath}\x1b[0m\n`);
      } catch (err) {
        stderr.write(`\x1b[31mFailed to save: ${err.message}\x1b[0m\n`);
      }
      return true;
    }

    case 'load': {
      const target = args || null;
      let data;
      if (!target) {
        // No arg: load autosave
        data = loadAutoSave();
        if (!data) { stderr.write('\x1b[33mNo autosave found\x1b[0m\n'); return true; }
      } else {
        data = loadSession(target);
      }
      if (!data) {
        stderr.write(`\x1b[33mSession not found: ${target}\x1b[0m\n`);
        return true;
      }
      if (data.error === 'ambiguous') {
        stderr.write(`\x1b[33mAmbiguous match. Candidates:\x1b[0m\n`);
        data.candidates.forEach(c => stderr.write(`  ${c}\n`));
        return true;
      }
      if (data.error) {
        stderr.write(`\x1b[31mCannot load: ${data.error} — ${data.message ?? ''}\x1b[0m\n`);
        return true;
      }
      const ok = context.deserialize(data);
      if (ok) {
        stderr.write(`\x1b[32m✓ Loaded ${data.turns?.length ?? 0} turns (from ${data.createdAt ?? '?'})\x1b[0m\n`);
      } else {
        stderr.write(`\x1b[31mFailed to deserialize session\x1b[0m\n`);
      }
      return true;
    }

    case 'sessions': {
      const sessions = listSessions(15);
      if (!sessions.length) {
        stderr.write('\x1b[2mNo saved sessions\x1b[0m\n');
        return true;
      }
      stderr.write('\x1b[1mSaved sessions:\x1b[0m\n');
      for (const s of sessions) {
        const date = s.createdAt !== '?' ? s.createdAt.replace('T', ' ').slice(0, 19) : '?';
        stderr.write(`  \x1b[36m${String(s.index).padStart(2)}\x1b[0m  ${date}  ${String(s.turns).padStart(3)} turns  ${s.model}  \x1b[2m${s.file}\x1b[0m\n`);
      }
      stderr.write('\x1b[2mUse /load <number> or /load <name> to restore\x1b[0m\n');
      return true;
    }

    case 'attach': {
      if (!args) {
        stderr.write('\x1b[33mUsage: /attach <path|glob>\x1b[0m\n');
        return true;
      }
      const results = attachManager.attach(args);
      for (const r of results) {
        if (r.ok) {
          const label = r.image ? '🖼' : '✓';
          stderr.write(`\x1b[32m${label} ${r.name} (${(r.size / 1024).toFixed(1)}KB)\x1b[0m\n`);
        } else {
          stderr.write(`\x1b[31m✗ ${r.path}: ${r.error}\x1b[0m\n`);
        }
      }
      if (attachManager.count() > 0) {
        stderr.write(`\x1b[2m[${attachManager.count()} files attached, ~${attachManager.estimateTokens()} tokens]\x1b[0m\n`);
      }
      return true;
    }

    case 'detach': {
      if (!args) {
        stderr.write('\x1b[33mUsage: /detach <path|name|number|all>\x1b[0m\n');
        return true;
      }
      const result = attachManager.detach(args);
      if (result === 'ambiguous') {
        stderr.write('\x1b[33mAmbiguous name — use /attached to see indices, then /detach <number>\x1b[0m\n');
      } else if (result) {
        stderr.write(`\x1b[32m✓ Detached. ${attachManager.count()} files remaining.\x1b[0m\n`);
      } else {
        stderr.write('\x1b[33mNot found. Use /attached to see current attachments.\x1b[0m\n');
      }
      return true;
    }

    case 'autocommit': {
      autoCommitter.enabled = !autoCommitter.enabled;
      stderr.write(`📝 Auto-commit ${autoCommitter.enabled ? 'ON' : 'OFF'}\n`);
      return true;
    }

    case 'plan': {
      if (planCtrl.getPlanMode?.()) {
        stderr.write('\x1b[33mAlready in plan mode. Use /execute to switch back.\x1b[0m\n');
      } else {
        planCtrl.setPlanMode?.(true);
        stderr.write('\x1b[33m🔒 Plan mode ON — read-only (write/edit/bash disabled)\x1b[0m\n');
      }
      return true;
    }

    case 'execute': {
      if (!planCtrl.getPlanMode?.()) {
        stderr.write('\x1b[33mAlready in execute mode.\x1b[0m\n');
      } else {
        planCtrl.setPlanMode?.(false);
        stderr.write('\x1b[32m🔓 Execute mode ON — all tools available\x1b[0m\n');
      }
      return true;
    }

    case 'effort': {
      if (!args) {
        const current = effortCtrl.getEffort?.() || 'default (none)';
        stderr.write(`🧠 Current effort: ${current}\n`);
        stderr.write('Usage: /effort <low|medium|high|max>\n');
      } else {
        try {
          const normalized = normalizeEffort(args);
          effortCtrl.setEffort?.(normalized);
          stderr.write(`🧠 Effort set to: ${normalized}\n`);
        } catch (e) {
          stderr.write(`\x1b[33m${e.message}\x1b[0m\n`);
        }
      }
      return true;
    }

    case 'fork': {
      // Save current state first
      const serialized = context.serialize();
      if (serialized?.turns?.length > 0) {
        const savedPath = saveSession(serialized, { model: config.model, workspaceRoot: config.workspaceRoot });
        stderr.write(`\x1b[2m[session] Pre-fork saved: ${savedPath}\x1b[0m\n`);
      }
      // Fork: assign new session ID
      const { randomBytes } = await import('crypto');
      const oldId = context._sessionId || 'unknown';
      const newId = randomBytes(8).toString('hex');
      context._sessionId = newId;
      stderr.write(`\x1b[32m🔀 Forked session: ${oldId.slice(0,8)}... → ${newId.slice(0,8)}...\x1b[0m\n`);
      return true;
    }

    case 'skills': {
      const sub = args.split(/\s+/)[0]?.toLowerCase() || '';
      const subArg = args.split(/\s+/).slice(1).join(' ').trim();

      if (sub === 'show') {
        if (!subArg) { stderr.write('Usage: /skills show <name>\n'); return true; }
        const skill = loadSkill(subArg, { force: true });
        if (!skill) { stderr.write(`Skill '${subArg}' not found\n`); return true; }
        stderr.write(`\n📦 ${skill.name} [${skill.source}]\n`);
        stderr.write(`  Description: ${skill.description}\n`);
        stderr.write(`  Schema: ${skill.schema}\n`);
        stderr.write(`  Invocation: ${skill.invocation}\n`);
        stderr.write(`  Context: ${skill.context}\n`);
        stderr.write(`  Arguments: ${skill.arguments} ${skill.argumentHint ? `(${skill.argumentHint})` : ''}\n`);
        if (skill.allowedTools.length) stderr.write(`  Allowed tools: ${skill.allowedTools.join(', ')}\n`);
        if (skill.tags.length) stderr.write(`  Tags: ${skill.tags.join(', ')}\n`);
        if (skill.skillDir) stderr.write(`  Directory: ${skill.skillDir}\n`);
        stderr.write(`  Source: ${skill.sourceFile}\n`);
        if (skill.warnings.length) {
          stderr.write(`  ⚠️ Warnings: ${skill.warnings.join('; ')}\n`);
        }
        stderr.write(`  Body: ${skill.body.length} chars\n`);
      } else {
        // Default: list all skills
        const skills = listSkills({ force: true });
        if (skills.length === 0) {
          stderr.write('No skills found.\n');
          return true;
        }
        const v3Count = skills.filter(s => s.source === 'v3').length;
        const legacyCount = skills.filter(s => s.source === 'legacy').length;
        stderr.write(`\n📦 Skills (${v3Count} v3, ${legacyCount} legacy)\n\n`);
        const maxName = Math.max(6, ...skills.map(s => s.name.length));
        stderr.write(`  ${'Name'.padEnd(maxName)}  Source  Description\n`);
        stderr.write(`  ${''.padEnd(maxName, '─')}  ${''.padEnd(6, '─')}  ${''.padEnd(40, '─')}\n`);
        for (const s of skills.sort((a, b) => a.name.localeCompare(b.name))) {
          const src = s.source.padEnd(6);
          const desc = (s.description || '-').slice(0, 50);
          const warn = s.warnings.length ? ' ⚠️' : '';
          stderr.write(`  ${s.name.padEnd(maxName)}  ${src}  ${desc}${warn}\n`);
        }
        stderr.write(`\n${skills.length} skills. Commands: /skills show <name>\n`);
      }
      return true;
    }

    case 'agents': {
      const sub = args.split(/\s+/)[0]?.toLowerCase() || '';
      const subArg = args.split(/\s+/).slice(1).join(' ').trim();

      if (sub === 'validate') {
        const profiles = listProfiles();
        if (profiles.length === 0) {
          stderr.write('No profiles found in ~/.claudia/agents/\n');
          return true;
        }
        let valid = 0, invalid = 0;
        for (const p of profiles) {
          try {
            loadProfile(p.name);
            stderr.write(`  ✅ ${p.name}\n`);
            valid++;
          } catch (e) {
            stderr.write(`  ❌ ${p.name}: ${e.message}\n`);
            invalid++;
          }
        }
        stderr.write(`\n${valid} valid, ${invalid} invalid\n`);
      } else if (sub === 'create') {
        if (!subArg) {
          stderr.write('Usage: /agents create <name>\n');
          return true;
        }
        const safeName = subArg.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
        const { existsSync: exists, writeFileSync: writeFs, mkdirSync: mkDir } = await import('fs');
        const { join: joinPath } = await import('path');
        const { homedir: home } = await import('os');
        const dir = joinPath(home(), '.claudia', 'agents');
        mkDir(dir, { recursive: true });
        const filePath = joinPath(dir, `${safeName}.yml`);
        if (exists(filePath)) {
          stderr.write(`\x1b[33mProfile '${safeName}' already exists: ${filePath}\x1b[0m\n`);
          return true;
        }
        const template = `# Agent profile: ${safeName}\nname: ${safeName}\ndescription: ""\nmodel: claude-opus-4.6\n# allowedTools: [read, glob, grep]\n# deniedTools: [agent]\nmaxSteps: 30\ntimeout: 60000\n# systemPrompt: |\n#   You are a specialized agent...\n`;
        writeFs(filePath, template);
        stderr.write(`\x1b[32m✅ Created: ${filePath}\x1b[0m\n`);
        stderr.write('Edit the file to customize model, tools, and prompt.\n');
      } else if (sub === 'show') {
        if (!subArg) {
          stderr.write('Usage: /agents show <name>\n');
          return true;
        }
        try {
          const p = loadProfile(subArg);
          if (!p) { stderr.write(`Profile '${subArg}' not found\n`); return true; }
          stderr.write(`\n👤 ${p.name}\n`);
          for (const [key, val] of Object.entries(p)) {
            if (key === 'systemPrompt') { stderr.write(`  ${key}: (${val.length} chars)\n`); }
            else { stderr.write(`  ${key}: ${JSON.stringify(val)}\n`); }
          }
        } catch (e) {
          stderr.write(`\x1b[33mError: ${e.message}\x1b[0m\n`);
        }
      } else {
        // Default: list all profiles
        const profiles = listProfiles();
        if (profiles.length === 0) {
          stderr.write('No profiles found. Create one at ~/.claudia/agents/<name>.yml\n');
          return true;
        }
        stderr.write('\n👤 Agent Profiles (~/.claudia/agents/)\n\n');
        const maxName = Math.max(6, ...profiles.map(p => p.name.length));
        stderr.write(`  ${'Name'.padEnd(maxName)}  Model              Description\n`);
        stderr.write(`  ${''.padEnd(maxName, '─')}  ${''.padEnd(18, '─')}  ${''.padEnd(30, '─')}\n`);
        for (const p of profiles) {
          const model = (p.model || '-').slice(0, 18).padEnd(18);
          const desc = (p.description || '-').slice(0, 50);
          stderr.write(`  ${p.name.padEnd(maxName)}  ${model}  ${desc}\n`);
        }
        stderr.write(`\n${profiles.length} profiles. Commands: /agents validate, /agents show <name>, /agents create <name>\n`);
      }
      return true;
    }

    case 'undo': {
      if (undoStack.depth === 0) {
        stderr.write('\x1b[33mNothing to undo\x1b[0m\n');
        return true;
      }
      const files = undoStack.peek();
      const { relative } = await import('path');
      stderr.write(`\x1b[33m↩️  Undo last turn (${files.length} file${files.length > 1 ? 's' : ''}):\x1b[0m\n`);
      for (const f of files) {
        stderr.write(`  ${relative(config.workspaceRoot, f).split('\\').join('/')}\n`);
      }
      const result = undoStack.undo();
      if (result.restored.length) {
        stderr.write(`\x1b[32m✓ Restored: ${result.restored.map(f => relative(config.workspaceRoot, f).split('\\').join('/')).join(', ')}\x1b[0m\n`);
      }
      if (result.deleted.length) {
        stderr.write(`\x1b[32m✓ Deleted (were new): ${result.deleted.map(f => relative(config.workspaceRoot, f).split('\\').join('/')).join(', ')}\x1b[0m\n`);
      }
      if (result.conflicts?.length) {
        stderr.write(`\x1b[33m⚠️  Conflicts (files modified after agent edit): ${result.conflicts.map(f => relative(config.workspaceRoot, f).split('\\').join('/')).join(', ')}\x1b[0m\n`);
      }
      stderr.write(`\x1b[2m[${undoStack.depth} more undo${undoStack.depth !== 1 ? 's' : ''} available]\x1b[0m\n`);
      return true;
    }

    case 'tokens': {
      const pct = context.usagePercent();
      const ctxEst = context.estimateTokens();
      const ctxMax = context.getMaxTokens();
      const turns = context.turnCount();
      const totalAll = sessionTokens.totalIn + sessionTokens.totalOut;
      const ctxColor = pct > 80 ? '31;1' : pct > 60 ? '33;1' : '32';
      stderr.write('\x1b[1m📊 Token Usage\x1b[0m\n');
      stderr.write(`\n  \x1b[1mSession\x1b[0m\n`);
      stderr.write(`    Turns:      ${sessionTokens.turns}\n`);
      stderr.write(`    Input:      ${formatTokenCount(sessionTokens.totalIn)}\n`);
      stderr.write(`    Output:     ${formatTokenCount(sessionTokens.totalOut)}\n`);
      stderr.write(`    Total:      \x1b[1m${formatTokenCount(totalAll)}\x1b[0m\n`);
      stderr.write(`\n  \x1b[1mContext Window\x1b[0m\n`);
      stderr.write(`    Estimated:  ${formatTokenCount(ctxEst)} / ${formatTokenCount(ctxMax)}\n`);
      stderr.write(`    Usage:      \x1b[${ctxColor}m${pct}%\x1b[0m\n`);
      stderr.write(`    Turns:      ${turns}\n`);
      if (attachManager.count() > 0) {
        stderr.write(`\n  \x1b[1mAttachments\x1b[0m\n`);
        stderr.write(`    Files:      ${attachManager.count()}\n`);
        stderr.write(`    Tokens:     ~${formatTokenCount(attachManager.estimateTokens())}\n`);
      }
      stderr.write('\n');
      return true;
    }

    case 'swarm': {
      config.swarm = !config.swarm;
      if (config.swarm) {
        const { registerAgentTool } = await import('./tools/agent.js');
        registerAgentTool(config, defaultRegistry);
      } else {
        defaultRegistry.delete('agent');
      }
      stderr.write(`🐝 Swarm ${config.swarm ? 'ON' : 'OFF'}\n`);
      return true;
    }

    case 'attached': {
      const files = attachManager.list();
      if (!files.length) {
        stderr.write('\x1b[2mNo files attached. Use /attach <path|glob>\x1b[0m\n');
        return true;
      }
      stderr.write('\x1b[1mAttached files:\x1b[0m\n');
      for (const f of files) {
        stderr.write(`  \x1b[36m${String(f.index).padStart(2)}\x1b[0m  ${f.name}  ${(f.size / 1024).toFixed(1)}KB  ~${f.tokens} tok  \x1b[2m${f.path}\x1b[0m\n`);
      }
      const total = attachManager.totalSize();
      const totalTok = attachManager.estimateTokens();
      stderr.write(`\x1b[2m  Total: ${(total / 1024).toFixed(1)}KB, ~${totalTok} tokens\x1b[0m\n`);
      return true;
    }

    default: {
      const cmd = fileCommands.get(name);
      if (cmd) {
        const expanded = expandCommand(cmd, args);
        stderr.write(`\x1b[2m[/${name}] Expanding command...\x1b[0m\n`);
        try {
          context.addUser(expanded);
          undoStack.startTurn();
          let streamed = false;
          let streamBuf = '';
          let spinnerTimer2 = null;
          let spinnerFrame2 = 0;
          const spinChars = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
          function startSpin() {
            if (spinnerTimer2) return;
            stderr.write('\n');
            spinnerTimer2 = setInterval(() => {
              const ch = spinChars[spinnerFrame2++ % spinChars.length];
              stderr.write(`\r\x1b[36m${ch}\x1b[0m`);
            }, 80);
          }
          function stopSpin() {
            if (spinnerTimer2) { clearInterval(spinnerTimer2); spinnerTimer2 = null; stderr.write('\r\x1b[0K\x1b[1A\x1b[0K'); }
          }
          const result = await runTurn({
            input: expanded, config, logger, history: context.getHistory(),
            onStep: (step) => {
              if (step.type === 'token') {
                streamed = true;
                streamBuf += step.text;
                startSpin();
              } else {
                if (step.type === 'tool_call') {
                  stopSpin();
                }
                if (step.type === 'tool_result' && (step.name === 'write' || step.name === 'edit') && step.result?.path) {
                  autoCommitter.trackFile(step.result.path);
                }
                if (step.type === 'tool_call' && (step.name === 'write' || step.name === 'edit') && step.args?.path) {
                  undoStack.trackFile(resolvePath(config.workspaceRoot, step.args.path));
                }
                printStep(step);
              }
            },
          });
          undoStack.commitTurn();
          stopSpin();
          if (result.text) {
            console.log(`\n${renderMarkdown(result.text)}\n`);
          }
          context.addTurn({
            assistantText: result.text || '',
            turnMessages: result.turnMessages,
          });
          // Auto-commit for slash command turns too
          const commitResult = autoCommitter.commitIfNeeded(result.text);
          if (commitResult?.hash) {
            stderr.write(`\x1b[2m[git] ${commitResult.hash} — ${commitResult.message}\x1b[0m\n`);
          } else if (commitResult?.error) {
            stderr.write(`\x1b[33m[git] commit failed: ${commitResult.error}\x1b[0m\n`);
          }
        } catch (err) {
          stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        }
        return true;
      }
      stderr.write(`Unknown command: /${name}. Try /help\n`);
      return true;
    }
  }
}

async function handleModelCommand(args, config) {
  if (!args) {
    try {
      // Use provider-aware model listing
      const { providerId } = detectProvider(config.model);
      const provider = getProvider(providerId);

      if (!provider.supports?.listModels) {
        stderr.write(`\x1b[33mProvider '${providerId}' does not support model listing\x1b[0m\n`);
        console.log(`Current model: ${config.model} (via ${providerId})`);
        return;
      }

      const token = await getProviderToken(providerId);
      const url = resolveUrl(provider, 'models');
      const authHeaders = buildAuthHeaders(provider, token);

      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...authHeaders, ...provider.extraHeaders },
      });
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

      console.log(`\nAvailable models (${providerId}):\n`);
      for (const m of models) {
        if (m.policy?.state !== 'enabled') continue;
        const current = config.model === m.id ? ' \x1b[32m← current\x1b[0m' : '';
        const ctx = m.capabilities?.limits?.max_context_window_tokens;
        const out = m.capabilities?.limits?.max_output_tokens;
        console.log(`  ${m.id}  (${ctx ? (ctx/1000)+'K ctx' : '?'}, ${out ? (out/1000)+'K out' : '?'})${current}`);
      }
      console.log(`\nUse: /model <id>\n`);
    } catch (err) {
      stderr.write(`\x1b[31mFailed to list models: ${err.message}\x1b[0m\n`);
    }
    return;
  }

  const target = args.trim();
  config.model = target;
  if (target === 'auto') {
    console.log(`Model: auto-routing enabled (codex · claude-opus-4.6 · gpt-5-mini per turn)`);
  } else {
    console.log(`Model switched to: ${config.model}`);
  }
}

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

// --- Version (read from package.json) ---
const __dirname_repl = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname_repl, '..', 'package.json'), 'utf8')).version;

// --- Cat logo animation ---
const CAT_POSES = [
  // Pose 0: Neutral (default)
  { l1: ' /\\_/\\', l2: '( ◦.◦ )', l3: '  >‿<' },
  // Pose 1: Blink left
  { l1: ' /\\_/\\', l2: '( -.◦ )', l3: '  >‿<' },
  // Pose 2: Happy
  { l1: ' /\\_/\\', l2: '( ^.^ )', l3: '  >‿<' },
  // Pose 3: Blink right
  { l1: ' /\\_/\\', l2: '( ◦.- )', l3: '  >‿<' },
  // Pose 4: Working
  { l1: ' /\\_/\\', l2: '( ◦_◦ )', l3: '  >‿<' },
  // Pose 5: Sleeping
  { l1: ' /\\_/\\', l2: '( -.- )', l3: '  >‿<' },
];

// Animate the cat logo at startup (quick blink sequence then settle)
async function animateCatBanner(config, planMode) {
  const R = '\x1b[0m';
  const CAT = '\x1b[38;2;167;139;250m';   // Violet #A78BFA
  const CATB = '\x1b[1m\x1b[38;2;167;139;250m'; // Bold violet
  const DIM = '\x1b[2m';

  const modelLabel = config.model === 'auto' ? 'auto (routing)' : config.model;
  const modeLabel = planMode ? ' \x1b[33m[PLAN]\x1b[0m' : '';
  const cwd = config.workspaceRoot?.replace(process.env.HOME, '~') || '.';

  const renderFrame = (pose) => {
    const p = CAT_POSES[pose] || CAT_POSES[0];
    return [
      `${CAT}${p.l1}${R}   ${CATB}Claudia${R} v${PKG_VERSION}${modeLabel}`,
      `${CAT}${p.l2}${R}   ${DIM}${modelLabel}${R}`,
      `${CAT}${p.l3}${R}    ${DIM}${cwd}${R}`,
    ];
  };

  // Animation sequence: neutral → blink → neutral → happy
  const sequence = [0, 0, 1, 0, 3, 0, 2];
  const delays =   [200, 150, 80, 150, 80, 150, 0];

  // Check if terminal supports cursor movement
  const canAnimate = stderr.isTTY && !process.env.CI;

  if (canAnimate) {
    // Print initial frame
    const lines = renderFrame(sequence[0]);
    stderr.write('\n');
    for (const line of lines) stderr.write(line + '\n');
    stderr.write('\n');

    // Animate through poses
    for (let i = 1; i < sequence.length; i++) {
      await new Promise(r => setTimeout(r, delays[i - 1]));
      const frame = renderFrame(sequence[i]);
      // Move cursor up 4 lines (3 lines + 1 blank) and rewrite
      stderr.write(`\x1b[4A`);
      for (const line of frame) stderr.write('\x1b[2K' + line + '\n');
      stderr.write('\x1b[2K\n');
    }
  } else {
    // No animation — just print the happy pose
    const lines = renderFrame(2);
    stderr.write('\n');
    for (const line of lines) stderr.write(line + '\n');
    stderr.write('\n');
  }

  // Show loaded CLAUDE.md files
  const memFiles = loadMemoryFiles({ workspaceRoot: config.workspaceRoot });
  if (memFiles.length) {
    for (const f of memFiles) {
      stderr.write(`\x1b[2m  📋 ${f.level}: ${f.path}\x1b[0m\n`);
    }
  }
}
