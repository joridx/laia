#!/usr/bin/env node
import { loadConfig, migrateLegacyConfig } from '../src/config.js';

// Run legacy migration FIRST — before any module reads process.env at import time.
// Note: ES import declarations are hoisted, but config.js has no import-time env reads
// (we removed them in refactor #4). Dynamic imports below are an extra safety layer.
migrateLegacyConfig();

function parseArgv(argv) {
  const args = { prompt: null, model: null, json: false, help: false, version: false, verbose: false, swarm: true, mcp: false, mcpStdoutPolicy: 'strict', streamJson: false, outputFormat: null, autoCommit: false, plan: false, genai: null, effort: null, fork: null, subcommand: null, mcpConfig: null, maxTurns: null };
  // Check for subcommands (e.g. "auth status") before flag parsing
  if (argv[2] && !argv[2].startsWith('-')) {
    const sub = argv.slice(2).join(' ');
    if (sub.startsWith('auth ') || sub === 'auth') { args.subcommand = sub; return args; }
    if (sub.startsWith('mcp ')) { args.subcommand = sub; return args; }
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--prompt') args.prompt = argv[++i];
    else if (a === '-m' || a === '--model') args.model = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--swarm') args.swarm = true;
    else if (a === '--no-swarm') args.swarm = false;
    else if (a === '--mcp') args.mcp = true;
    else if (a === '--stream-json' || (a === '--input-format' && argv[i+1] === 'stream-json')) { args.streamJson = true; if (a === '--input-format') i++; }
    else if (a === '--output-format' && argv[i+1] === 'stream-json') { args.streamJson = true; i++; }
    else if (a === '--output-format') { args.outputFormat = argv[++i]; }
    else if (a === '--mcp-config') args.mcpConfig = argv[++i];
    else if (a === '--max-turns') args.maxTurns = parseInt(argv[++i], 10);
    // Claude Code compat: accepted silently (no-op)
    else if (a === '--setting-sources' || a === '--disallowedTools' || a === '--permission-prompt-tool') { i++; /* skip value */ }
    else if (a === '--no-session-persistence' || a === '--worktree') { if (argv[i+1] && !argv[i+1].startsWith('-')) i++; /* skip optional value */ }
    else if (a === '--permission-mode') { i++; /* skip value */ }
    else if (a === '--mcp-stdout-policy') args.mcpStdoutPolicy = argv[++i];
    else if (a === '--dangerously-skip-permissions') { /* accepted for Claude Code compat, stream-json always auto-approves */ }
    else if (a === '--auto-commit') args.autoCommit = true;
    else if (a === '--plan') args.plan = true;
    else if (a === '--effort') args.effort = argv[++i];
    else if (a === '--fork') args.fork = argv[++i];
    else if (a === '--genai') args.genai = argv[++i] || 'sonnet';
    else if (a === '-v' || a === '--version') args.version = true;
    else if (!a.startsWith('-') && !args.prompt) args.prompt = a;
  }
  return args;
}

const args = parseArgv(process.argv);

if (args.help) {
  console.log(`laia - Local AI Agent with evolving memory

Usage:
  laia                     Interactive REPL
  laia -p "prompt"       One-shot mode
  laia "prompt"          One-shot mode (positional)

Options:
  -p, --prompt <text>   One-shot prompt
  -m, --model <id>      Override model (default: claude-opus-4.6)
  --json                JSON output (one-shot mode)
  --swarm               Enable swarm mode (default: on)
  --no-swarm            Disable swarm mode
  --mcp                 Run as MCP server over stdio (exposes agent tool)
  --mcp-stdout-policy <strict|redirect>
                        Stdout safety policy in MCP mode (default: strict)
  --stream-json         NDJSON bidirectional protocol over stdin/stdout
                        (compatible with Claude Code stream-json format)
  --input-format stream-json
  --output-format stream-json
                        Aliases for --stream-json (Claude Code compatibility)
  --auto-commit           Enable git auto-commit after each turn
  --plan                Read-only plan mode (no write/edit/bash)
  --effort <level>      Reasoning effort: low, medium, high, max (default: none)
  --fork <name|id>      Fork a saved session (new ID, preserves history)
  --genai <agent>       Use GenAI Lab backend (sonnet|claude|gpt-5|o3|o4-mini)
  --verbose             Verbose logging
  -h, --help            Show help
  -v, --version         Show version`);
  process.exit(0);
}

if (args.version) {
  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
  console.log(pkg.version);
  process.exit(0);
}

// Subcommands (Claude Code compatibility)
if (args.subcommand) {
  if (args.subcommand.startsWith('auth')) {
    // Check if any API key is configured
    const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY);
    console.log(JSON.stringify({ loggedIn: hasKey, authMethod: hasKey ? 'api_key' : null }));
    process.exit(0);
  }
  if (args.subcommand.startsWith('mcp ')) {
    console.error(`LAIA does not support '${args.subcommand}' yet.`);
    process.exit(1);
  }
  console.error(`Unknown subcommand: ${args.subcommand}`);
  process.exit(1);
}

// Dynamic imports — loaded AFTER migrateLegacyConfig() has run
const { createLogger } = await import('../src/logger.js');
const config = await loadConfig({ modelOverride: args.model, verbose: args.verbose, swarm: args.swarm, autoCommit: args.autoCommit, planMode: args.plan, effort: args.effort, genai: args.genai });
const logger = createLogger(config);

if (args.mcp) {
  const { startMcpServer } = await import('../src/mcp-server.js');
  await startMcpServer({ config, logger, stdoutPolicy: args.mcpStdoutPolicy });
} else if (args.streamJson) {
  const { runStreamJson } = await import('../src/stream-json.js');
  await runStreamJson({ config, logger, mcpConfig: args.mcpConfig, maxTurns: args.maxTurns });
} else if (args.prompt && args.outputFormat === 'text') {
  // One-shot text mode (Claude Code preflight compat: -p "..." --output-format text)
  const { runOneShot } = await import('../src/agent.js');
  await runOneShot({ prompt: args.prompt, config, logger, json: false, maxTurns: args.maxTurns ?? 1 });
} else if (args.prompt) {
  const { runOneShot } = await import('../src/agent.js');
  await runOneShot({ prompt: args.prompt, config, logger, json: args.json, maxTurns: args.maxTurns });
} else {
  const { runRepl } = await import('../src/repl.js');
  await runRepl({ config, logger, planMode: args.plan, forkSession: args.fork });
}
