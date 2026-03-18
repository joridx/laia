#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { runRepl } from '../src/repl.js';
import { runOneShot } from '../src/agent.js';
import { createLogger } from '../src/logger.js';

function parseArgv(argv) {
  const args = { prompt: null, model: null, json: false, help: false, version: false, verbose: false, swarm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--prompt') args.prompt = argv[++i];
    else if (a === '-m' || a === '--model') args.model = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--swarm') args.swarm = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else if (!a.startsWith('-') && !args.prompt) args.prompt = a;
  }
  return args;
}

const args = parseArgv(process.argv);

if (args.help) {
  console.log(`claudia - CLI coding agent (Copilot Business)

Usage:
  claudia                   Interactive REPL
  claudia -p "prompt"       One-shot mode
  claudia "prompt"          One-shot mode (positional)

Options:
  -p, --prompt <text>   One-shot prompt
  -m, --model <id>      Override model (default: claude-opus-4.6)
  --json                JSON output (one-shot mode)
  --swarm                 Enable swarm mode (agent tool)
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

const config = await loadConfig({ modelOverride: args.model, verbose: args.verbose, swarm: args.swarm });
const logger = createLogger(config);

if (args.prompt) {
  await runOneShot({ prompt: args.prompt, config, logger, json: args.json });
} else {
  await runRepl({ config, logger });
}
