import readline from 'readline/promises';
import { stdin, stdout, stderr } from 'process';
import { registerBuiltinTools, defaultRegistry } from './tools/index.js';
import { runTurn, printStep } from './agent.js';
import { createContext } from './context.js';
import { loadFileCommands, expandCommand } from './commands/loader.js';
import { getCopilotToken, getProviderToken } from './auth.js';
import { detectProvider, getProvider, resolveUrl, buildAuthHeaders } from '@claude/providers';
import { startBrain, stopBrain } from './brain/client.js';
import { setReadlineInterface } from './permissions.js';
import { renderMarkdown } from './render.js';
import { loadMemoryFiles } from './memory-files.js';
import { createRouter, routeLabel, MODEL_IDS } from './router.js';
import { saveSession, autoSave, loadAutoSave, loadSession, listSessions, deleteAutoSave } from './session.js';
import { createAttachManager } from './attach.js';
import { createAutoCommitter } from './git-commit.js';

// --- Slash command list for autocomplete ---
const BUILTIN_COMMANDS = ['/help', '/model', '/clear', '/compact', '/save', '/load', '/sessions', '/attach', '/detach', '/attached', '/swarm', '/autocommit', '/exit', '/quit'];

// --- Heuristic follow-up suggestions based on assistant response ---
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

export async function runRepl({ config, logger }) {
  // Start brain MCP server
  stderr.write('\x1b[2m[brain] Starting MCP server...\x1b[0m\n');
  try {
    await startBrain({ brainPath: config.brainPath, verbose: config.verbose });
    stderr.write('\x1b[2m[brain] Connected\x1b[0m\n');
  } catch (err) {
    stderr.write(`\x1b[33m[brain] Failed to start: ${err.message} (brain tools disabled)\x1b[0m\n`);
console.log('\x1b[33m[WARNING]\x1b[0m Brain features are disabled for this session. Some AI features may be limited.');
  }

  await registerBuiltinTools({ ...config, freeze: false });
  const context = createContext();
  const fileCommands = loadFileCommands(config.commandDirs);
  const router = createRouter();
  const attachManager = createAttachManager(config.workspaceRoot);
  const autoCommitter = createAutoCommitter({ cwd: config.workspaceRoot });
  if (config.autoCommit) autoCommitter.enabled = true;

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

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    completer,
    prompt: '\x1b[1mclaudia>\x1b[0m ',
  });

  // Register readline with permission system so it pauses during prompts
  setReadlineInterface(rl);

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

  // Session metadata for saves
  const sessionMeta = {
    sessionId: logger.sessionId,
    model: config.model,
    workspaceRoot: config.workspaceRoot,
  };

  printBanner(config);
  rl.prompt();

  rl.on('close', async () => {
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
    let input = line.trim();

    // If empty input + suggestion selected → use suggestion
    if (!input && selectedSuggestion >= 0 && suggestions[selectedSuggestion]) {
      input = suggestions[selectedSuggestion];
      stderr.write(`\x1b[2m  → ${input}\x1b[0m\n`);
    }

    clearSuggestions();

    if (!input) { rl.prompt(); continue; }

    // Slash commands
    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, config, logger, context, fileCommands, attachManager, autoCommitter);
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

      const result = await runTurn({
        input: llmInput,
        config: effectiveConfig,
        logger,
        history: context.getHistory(),
        corporateHint,
        onStep: (step) => {
          if (step.type === 'token') { streamed = true; process.stdout.write(step.text); }
          else {
            // Track files modified by write/edit for auto-commit
            if (step.type === 'tool_result' && (step.name === 'write' || step.name === 'edit') && step.result?.path) {
              autoCommitter.trackFile(step.result.path);
            }
            printStep(step);
          }
        },
      });
      const text = result.text || '';
      if (streamed) {
        process.stdout.write('\n\n');
      } else if (text) {
        console.log(`\n${renderMarkdown(text)}\n`);
      } else {
        stderr.write('\x1b[33m⚠ (empty response — model returned no text)\x1b[0m\n');
      }
      // Atomic: store full tool transcript + assistant reply together (user already added above)
      context.addTurn({
        assistantText: text,
        turnMessages: result.turnMessages,
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
        const inTok = result.usage.input_tokens ?? result.usage.prompt_tokens ?? '?';
        const outTok = result.usage.output_tokens ?? result.usage.completion_tokens ?? '?';
        const pct = context.usagePercent();
        const ctxColor = pct > 80 ? '31;1' : pct > 60 ? '33;1' : '32'; // red bold / yellow bold / green
        stderr.write(`\x1b[2m[${inTok} in / ${outTok} out ·\x1b[0m \x1b[${ctxColor}m${pct}% ctx\x1b[0m\x1b[2m]\x1b[0m\n`);
      }
    } catch (err) {
      // Structured error reporting
      logger.error('turn_error', { error: err.message, full: err.stack, input });
      // Surface error to user as visible message
      stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
      stderr.write(`\x1b[33m(Turn aborted due to error. Check logs for details.)\x1b[0m\n`);
    }

    rl.prompt();
  }
}

async function handleSlashCommand(input, config, logger, context, fileCommands, attachManager, autoCommitter) {
  const spaceIdx = input.indexOf(' ');
  const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();

  switch (name) {
    case 'help':
      console.log('Built-in commands: /help /model /clear /compact /save /load /sessions /attach /detach /attached /swarm /autocommit /exit');
      console.log('Session: /save [name], /load [name|number], /sessions');
      console.log('Attach: /attach <path|glob>, /detach <path|name|number|all>, /attached');
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
          let streamed = false;
          const result = await runTurn({
            input: expanded, config, logger, history: context.getHistory(),
            onStep: (step) => {
              if (step.type === 'token') { streamed = true; process.stdout.write(step.text); }
              else {
                if (step.type === 'tool_result' && (step.name === 'write' || step.name === 'edit') && step.result?.path) {
                  autoCommitter.trackFile(step.result.path);
                }
                printStep(step);
              }
            },
          });
          if (streamed) {
            process.stdout.write('\n\n');
          } else if (result.text) {
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

function printBanner(config) {
  const W = 29; // inner width of box
  const C = '\x1b[1m\x1b[36m', R = '\x1b[0m';
  const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const pad = (s) => s + ' '.repeat(Math.max(0, W - visLen(s)));
  const modelLabel = config.model === 'auto' ? 'auto (routing)' : config.model;
  console.log(`
${C}  ┌${'─'.repeat(W)}┐${R}
${C}  │${R}${pad(`  ${C}claudia${R} v0.1.0`)}${C}│${R}
${C}  │${R}${pad(`  model: ${modelLabel}`)}${C}│${R}
${C}  │${R}${pad('  /help for commands')}${C}│${R}
${C}  └${'─'.repeat(W)}┘${R}
`);
  // Show loaded CLAUDE.md files
  const memFiles = loadMemoryFiles({ workspaceRoot: config.workspaceRoot });
  if (memFiles.length) {
    for (const f of memFiles) {
      process.stderr.write(`\x1b[2m  📋 ${f.level}: ${f.path}\x1b[0m\n`);
    }
  }
}
