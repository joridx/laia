// Agent turn loop: user input -> LLM -> tool calls -> LLM -> final text
import { createLLMClient, runAgentTurn } from './llm.js';
import { getCopilotToken, getProviderToken } from './auth.js';
import { detectProvider, isProviderAvailable } from '@laia/providers';
import { buildSystemPrompt } from './system-prompt.js';
import { getToolSchemas, executeTool as dispatchTool } from './tools/index.js';
import { checkPermission, setAutoApprove } from './permissions.js';
import { createDispatchToolBatch } from './swarm.js';
import { colorDiff } from './diff.js';

// Tools excluded in plan mode (mutating operations)
const PLAN_MODE_EXCLUDED_TOOLS = ['write', 'edit', 'bash'];

// Fallback chain for rate-limited free-tier models
// Order: best intelligence first, then speed, then backup
const FALLBACK_CHAIN = [
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'groq', model: 'moonshotai/kimi-k2-instruct' },
  { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
  { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  { provider: 'cerebras', model: 'qwen-3-235b-a22b-instruct-2507' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'google', model: 'gemini-3.1-flash-lite-preview' },
  { provider: 'copilot', model: 'claude-sonnet-4' },
];

export function createClient(config) {
  const { providerId, model } = detectProvider(config.model, { forceProvider: config.provider });
  return createLLMClient({
    getToken: () => getProviderToken(providerId),
    model,
    providerId,
  });
}

function createClientForFallback(provider, model) {
  return createLLMClient({
    getToken: () => getProviderToken(provider),
    model,
    providerId: provider,
  });
}

export async function runTurn({ input, config, logger, onStep, history = [], corporateHint, planMode = false, effort, signal } = {}) {
  const systemPrompt = buildSystemPrompt({
    workspaceRoot: config.workspaceRoot,
    model: config.model,
    brainPath: config.brainPath,
    corporateHint,
    planMode,
    coordinator: config.coordinator,
  });
  const tools = planMode
    ? getToolSchemas({ exclude: PLAN_MODE_EXCLUDED_TOOLS })
    : getToolSchemas();

  // Server-side enforcement: block mutating tools in plan mode even if model emits them
  const blockedTools = planMode ? new Set(PLAN_MODE_EXCLUDED_TOOLS) : null;

  // Swarm mode: parallel batch dispatcher for concurrent agent() calls
  const executeToolBatch = config.swarm
    ? createDispatchToolBatch(async (name, args, callId) => {
        if (blockedTools?.has(name)) return { error: true, message: `Tool '${name}' is disabled in plan mode` };
        const allowed = await checkPermission(name, args);
        if (!allowed) throw new Error('User denied permission');
        return dispatchTool(name, args, callId);
      })
    : undefined;

  const makeTurnArgs = (client) => ({
    client,
    systemPrompt,
    userInput: input,
    history,
    tools,
    executeTool: async (name, args, callId) => {
      if (blockedTools?.has(name)) return { error: true, message: `Tool '${name}' is disabled in plan mode` };
      const allowed = await checkPermission(name, args);
      if (!allowed) throw new Error('User denied permission');
      const t0 = Date.now();
      const result = await dispatchTool(name, args, callId);
      const durationMs = Date.now() - t0;
      const bytesOut = (result.stdout?.length || 0) + (result.stderr?.length || 0) + (result.error ? 100 : 0);
      const bytesIn = JSON.stringify(args ?? {}).length;
      logger.logToolStats?.({ tool: name, bytesIn, bytesOut, truncated: !!result.rawFile, rawFile: result.rawFile, exitCode: result.exitCode, durationMs });
      return result;
    },
    executeToolBatch,
    effort,
    signal,
    onStep: (step) => {
      logger.info('agent_step', step);
      onStep?.(step);
    },
  });

  // Try primary model, then fallback chain on transient API errors
  // Errors that trigger fallback: 429 (rate limit), 413 (too large), 404 (model not found),
  // 400 (tool calling not supported), and "Request too large" messages.
  const shouldFallback = (err) => {
    if (!err) return false;
    const s = err.status;
    if (s === 429 || s === 413 || s === 404) return true;
    // Groq returns 400 for "tool calling not supported" and "Request too large"
    if (s === 400 && /tool calling.*not supported|request too large/i.test(err.message)) return true;
    return false;
  };

  const primaryClient = createClient(config);
  try {
    return await runAgentTurn(makeTurnArgs(primaryClient));
  } catch (err) {
    if (!shouldFallback(err)) throw err;

    // Build fallback candidates: skip the current model, skip unavailable providers
    const currentKey = `${primaryClient.providerId}:${primaryClient.model}`;
    const candidates = FALLBACK_CHAIN.filter(f =>
      `${f.provider}:${f.model}` !== currentKey && isProviderAvailable(f.provider)
    );

    for (const fb of candidates) {
      const tag = `${fb.provider}:${fb.model}`;
      onStep?.({ type: 'error', error: `\u2717 ${err.message?.slice(0, 80)} — falling back to ${tag}`, retriable: true });
      logger.info('fallback_model', { from: currentKey, to: tag, reason: String(err.status) });
      try {
        const fbClient = createClientForFallback(fb.provider, fb.model);
        return await runAgentTurn(makeTurnArgs(fbClient));
      } catch (fbErr) {
        if (shouldFallback(fbErr)) continue; // transient error, try next
        throw fbErr; // fatal error, propagate
      }
    }

    // All fallbacks exhausted
    throw err;
  }
}

export async function runOneShot({ prompt, config, logger, json, maxTurns }) {
  // One-shot mode: auto-approve all tools (no interactive stdin)
  setAutoApprove(true);

  const { startBrain, stopBrain } = await import('./brain/client.js');
  try { await startBrain({ brainPath: config.brainPath }); } catch (err) { console.error('startBrain error:', err); }

  const { registerBuiltinTools } = await import('./tools/index.js');
  await registerBuiltinTools(config);

  try {
    let streamed = false;
    logger.startTurn?.();
    const result = await runTurn({
      input: prompt,
      config,
      logger,
      planMode: config.planMode || false,
      maxTurns: maxTurns ?? undefined,
      onStep: json ? undefined : (step) => {
        if (step.type === 'token') streamed = true;
        printStep(step);
      },
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!streamed) {
      console.log(result.text);
    }
    // if streamed: tokens already written to stdout via printStep's 'token' case
  } finally {
    await stopBrain();
  }
}

export function printStep(step) {
  const DIM = '\x1b[2m';
  const R = '\x1b[0m';
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const YELLOW = '\x1b[33m';

  switch (step.type) {
    case 'reasoning':
      process.stderr.write(`${DIM}💭 ${step.summary}${R}\n`);
      break;
    case 'tool_call': {
      // Build a compact, informative tool call description
      const name = step.name;
      const args = step.args || {};
      let detail = '';
      switch (name) {
        case 'read':
          detail = args.path ? `${args.path}${args.offset ? `:${args.offset}` : ''}${args.limit ? `-${(args.offset||1)+args.limit-1}` : ''}` : '';
          break;
        case 'write':
          detail = args.path || '';
          break;
        case 'edit':
          detail = args.path ? `${args.path} · ${args.edits?.length || '?'} edit${(args.edits?.length||0) !== 1 ? 's' : ''}` : '';
          break;
        case 'bash':
          detail = (args.command || '').slice(0, 60) + ((args.command?.length || 0) > 60 ? '…' : '');
          break;
        case 'grep':
          detail = `"${(args.query || '').slice(0, 30)}"${args.path ? ` in ${args.path}` : ''}`;
          break;
        case 'glob':
          detail = args.pattern || '';
          break;
        case 'agent':
          detail = (args.prompt || '').slice(0, 50) + ((args.prompt?.length || 0) > 50 ? '…' : '');
          break;
        default:
          detail = JSON.stringify(args).substring(0, 60);
      }
      process.stderr.write(`${CYAN}⚡ ${name}${R}${detail ? `${DIM}(${detail})${R}` : ''}\n`);
      break;
    }
    case 'tool_result': {
      const name = step.name;
      const hasError = Boolean(step.result?.error) || (step.name === 'bash' && Number(step.result?.exitCode) !== 0);
      const icon = hasError ? `${YELLOW}⚠` : `${GREEN}✓`;
      let suffix = '';
      if (step.name === 'bash' && step.result?.exitCode !== undefined) {
        suffix = ` ${DIM}exit ${step.result.exitCode}${R}`;
      } else if ((step.name === 'edit' || step.name === 'write') && step.result?.path) {
        suffix = ` ${DIM}${step.result.path}${R}`;
      } else if (step.name === 'agent' && step.result?.text) {
        const preview = step.result.text.slice(0, 60).replace(/\n/g, ' ');
        suffix = ` ${DIM}${preview}${(step.result.text.length > 60 ? '…' : '')}${R}`;
      }
      process.stderr.write(`${icon} ${name}${R}${suffix}\n`);
      // Show diff preview for edit and write tools (truncate large diffs)
      if ((step.name === 'edit' || step.name === 'write') && step.result?.diff) {
        const MAX_DIFF_LINES = 50;
        const diffLines = step.result.diff.split('\n');
        const truncated = diffLines.length > MAX_DIFF_LINES;
        const display = truncated ? diffLines.slice(0, MAX_DIFF_LINES).join('\n') : step.result.diff;
        process.stderr.write(colorDiff(display) + '\n');
        if (truncated) process.stderr.write(`${DIM}  ... (${diffLines.length - MAX_DIFF_LINES} more lines truncated)${R}\n`);
      }
      break;
    }
    case 'token':
      process.stdout.write(step.text);
      break;
    case 'error':
      process.stderr.write(`${RED}✗ ${step.error}${R}\n`);
      break;
  }
}
