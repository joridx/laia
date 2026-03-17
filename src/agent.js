// Agent turn loop: user input -> LLM -> tool calls -> LLM -> final text
import { createLLMClient, runAgentTurn } from './llm.js';
import { getCopilotToken } from './auth.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getToolSchemas, executeTool as dispatchTool } from './tools/index.js';
import { checkPermission, setAutoApprove } from './permissions.js';

let client = null;

export function getClient(config) {
  if (!client || client.model !== config.model) {
    client = createLLMClient({ getToken: getCopilotToken, model: config.model });
  }
  return client;
}

export async function runTurn({ input, config, logger, onStep, history = [] }) {
  const llmClient = getClient(config);
  const systemPrompt = buildSystemPrompt({
    workspaceRoot: config.workspaceRoot,
    model: config.model,
    brainPath: config.brainPath,
  });

  const tools = getToolSchemas();

  const result = await runAgentTurn({
    client: llmClient,
    systemPrompt,
    userInput: input,
    history,
    tools,
    executeTool: async (name, args, callId) => {
      const allowed = await checkPermission(name, args);
      if (!allowed) return { error: true, message: 'User denied permission' };
      return dispatchTool(name, args, callId);
    },
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
  try { await startBrain({ brainPath: config.brainPath }); } catch {}

  const { registerBuiltinTools } = await import('./tools/index.js');
  await registerBuiltinTools(config);

  try {
    const result = await runTurn({
      input: prompt,
      config,
      logger,
      onStep: json ? undefined : (step) => printStep(step),
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.text);
    }
  } finally {
    await stopBrain();
  }
}

export function printStep(step) {
  switch (step.type) {
    case 'reasoning':
      process.stderr.write(`\x1b[2m${step.summary}\x1b[0m\n`);
      break;
    case 'tool_call':
      process.stderr.write(`\x1b[36m→ ${step.name}(${JSON.stringify(step.args).substring(0, 80)})\x1b[0m\n`);
      break;
    case 'tool_result':
      process.stderr.write(`\x1b[32m✓ ${step.name}\x1b[0m\n`);
      break;
    case 'error':
      process.stderr.write(`\x1b[31m✗ ${step.error}\x1b[0m\n`);
      break;
  }
}
