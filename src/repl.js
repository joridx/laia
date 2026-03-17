import readline from 'readline/promises';
import { stdin, stdout, stderr } from 'process';
import { registerBuiltinTools } from './tools/index.js';
import { runTurn, printStep, getClient } from './agent.js';
import { createContext } from './context.js';
import { loadFileCommands, expandCommand } from './commands/loader.js';
import { getCopilotToken } from './auth.js';
import { startBrain, stopBrain } from './brain/client.js';
import { setReadlineInterface } from './permissions.js';
import { renderMarkdown } from './render.js';

const COPILOT_HEADERS = {
  'Editor-Version': 'JetBrains-IC/2025.3',
  'Editor-Plugin-Version': 'copilot-intellij/1.5.66',
  'Copilot-Integration-Id': 'vscode-chat',
};

// --- Slash command list for autocomplete ---
const BUILTIN_COMMANDS = ['/help', '/model', '/clear', '/compact', '/exit', '/quit'];

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
  }

  await registerBuiltinTools(config);
  const context = createContext();
  const fileCommands = loadFileCommands(config.commandDirs);

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

  printBanner(config);
  rl.prompt();

  rl.on('close', async () => {
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
      const handled = await handleSlashCommand(input, config, logger, context, fileCommands);
      if (handled) { rl.prompt(); continue; }
    }

    // Normal prompt
    try {
      context.addUser(input);
      if (context.needsCompaction()) context.compact();
      const result = await runTurn({
        input,
        config,
        logger,
        history: context.getMessages().slice(0, -1), // all except current (already in userInput)
        onStep: printStep,
      });
      const text = result.text || '';
      if (text) {
        console.log(`\n${renderMarkdown(text)}\n`);
      } else {
        stderr.write(`\x1b[2m(no response)\x1b[0m\n`);
      }
      context.addAssistant(text);

      // Show follow-up suggestions
      suggestions = suggestFollowUps(text);
      selectedSuggestion = 0;
      showSuggestions();
      if (result.usage) {
        const inTok = result.usage.input_tokens ?? result.usage.prompt_tokens ?? '?';
        const outTok = result.usage.output_tokens ?? result.usage.completion_tokens ?? '?';
        stderr.write(`\x1b[2m[${inTok} in / ${outTok} out]\x1b[0m\n`);
      }
    } catch (err) {
      stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
      logger.error('turn_error', { error: err.message });
    }

    rl.prompt();
  }
}

async function handleSlashCommand(input, config, logger, context, fileCommands) {
  const spaceIdx = input.indexOf(' ');
  const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();

  switch (name) {
    case 'help':
      console.log('Built-in commands: /help /model /clear /compact /exit');
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
      await stopBrain();
      console.log('Bye!');
      process.exit(0);

    default: {
      const cmd = fileCommands.get(name);
      if (cmd) {
        const expanded = expandCommand(cmd, args);
        stderr.write(`\x1b[2m[/${name}] Expanding command...\x1b[0m\n`);
        try {
          context.addUser(expanded);
          const result = await runTurn({ input: expanded, config, logger, history: context.getMessages().slice(0, -1), onStep: printStep });
          if (result.text) {
            console.log(`\n${renderMarkdown(result.text)}\n`);
            context.addAssistant(result.text);
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
      const token = await getCopilotToken();
      const res = await fetch('https://api.business.githubcopilot.com/models', {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...COPILOT_HEADERS },
      });
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

      console.log('\nAvailable models:\n');
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

  config.model = args.trim();
  console.log(`Model switched to: ${config.model}`);
}

function printBanner(config) {
  console.log(`
\x1b[1m\x1b[36m  ┌─────────────────────────────┐\x1b[0m
\x1b[1m\x1b[36m  │  claudia\x1b[0m v0.1.0            \x1b[1m\x1b[36m│\x1b[0m
\x1b[1m\x1b[36m  │\x1b[0m  model: ${config.model.padEnd(18)}\x1b[1m\x1b[36m│\x1b[0m
\x1b[1m\x1b[36m  │\x1b[0m  /help for commands          \x1b[1m\x1b[36m│\x1b[0m
\x1b[1m\x1b[36m  └─────────────────────────────┘\x1b[0m
`);
}
