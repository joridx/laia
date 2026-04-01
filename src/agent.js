// Agent turn loop: user input -> LLM -> tool calls -> LLM -> final text
import { createLLMClient, runAgentTurn } from './llm.js';
import { getCopilotToken, getProviderToken } from './auth.js';
import { detectProvider } from '@laia/providers';
import { buildSystemPrompt } from './system-prompt.js';
import { getToolSchemas, executeTool as dispatchTool } from './tools/index.js';
import { checkPermission, setAutoApprove } from './permissions.js';
import { createDispatchToolBatch } from './swarm.js';
import { colorDiff } from './diff.js';

// Tools excluded in plan mode (mutating operations)
const PLAN_MODE_EXCLUDED_TOOLS = ['write', 'edit', 'bash'];

export function createClient(config) {
  const { providerId } = detectProvider(config.model);
  return createLLMClient({
    getToken: () => getProviderToken(providerId),
    model: config.model,
    providerId,
  });
}

export async function runTurn({ input, config, logger, onStep, history = [], corporateHint, planMode = false, effort, signal } = {}) {
  const llmClient = createClient(config);
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

  const result = await runAgentTurn({
    client: llmClient,
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
      // Log tool output stats for context consumption analysis (lightweight: use .length on known string fields)
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

  // result includes { text, usage, turnMessages } — turnMessages is the full tool transcript
  return result;
}

export async function runOneShot({ prompt, config, logger, json }) {
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
