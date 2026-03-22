// Agent tool — in-process worker with fresh context
// Self-contained: no changes needed to existing files.
// Registered only when config.swarm=true (see tools/index.js registerBuiltinTools)

import { readFileSync, existsSync } from 'fs';
import { resolve, extname, basename } from 'path';
import { createLLMClient, runAgentTurn as _runAgentTurnDefault } from '../llm.js';
import { getCopilotToken, getProviderToken } from '../auth.js';
import { detectProvider } from '@claude/providers';
import { buildWorkerSystemPrompt } from '../system-prompt.js';
import { executeTool, getToolSchemas, getToolNames, registerTool } from './index.js';
import { createPermissionContext } from '../permissions.js';
import { loadProfile, resolveToolSet } from '../profiles.js';

const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 500_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DEPTH = 3;
const MAX_STEPS_CAP = 100;

let workerCounter = 0;

export function createAgentTool({ config, _runAgentTurn, timeoutMs = DEFAULT_TIMEOUT_MS, maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const runAgentTurnFn = _runAgentTurn ?? _runAgentTurnDefault;

  async function execute({ prompt, files = [], model, timeout, allowedTools, profile: profileName, _depth = 0, _signal } = {}) {
    // Recursion guard
    if (_depth >= maxDepth) {
      return { success: false, error: `max recursion depth (${maxDepth}) exceeded`, workerId: 'blocked' };
    }

    // Load profile if specified
    let profile = null;
    if (profileName) {
      try {
        profile = loadProfile(profileName);
        if (!profile) return { success: false, error: `Profile '${profileName}' not found in ~/.claudia/agents/`, workerId: 'blocked' };
      } catch (e) {
        return { success: false, error: e.message, workerId: 'blocked' };
      }
    }

    const workerId = `worker-${++workerCounter}`;
    const effectiveTimeout = timeout ?? profile?.timeout ?? timeoutMs;
    const effectiveModel = model ?? profile?.model ?? config.model;
    const effectiveMaxSteps = Math.min(
      profile?.maxSteps ?? MAX_STEPS_CAP,
      MAX_STEPS_CAP
    );

    // Build injected file contents
    const fileContents = buildFileContents(files, config.workspaceRoot ?? process.cwd());

    // V2b: Memory prefetch — inject agent-relevant learnings into worker context
    let prefetchedMemory = '';
    if (profile?.memoryPrefetch === 'topK' && profileName) {
      try {
        const searchQuery = prompt.slice(0, 200);
        const limit = profile.memoryPrefetchLimit || 5;
        const brainResult = await executeTool('brain_search', {
          query: searchQuery,
          agentContext: profileName,
          limit,
        });
        if (brainResult && typeof brainResult === 'string' && brainResult.length > 10) {
          // Truncate to avoid prompt bloat (max ~2000 chars)
          prefetchedMemory = brainResult.slice(0, 2000);
        } else if (brainResult?.text) {
          prefetchedMemory = String(brainResult.text).slice(0, 2000);
        }
      } catch {
        // Fail-open: prefetch failure should not block agent spawn
      }
    }

    // Worker system prompt — profile customPrompt augments, never replaces base safety
    const systemPrompt = buildWorkerSystemPrompt({
      workerId, depth: _depth + 1,
      workspaceRoot: config.workspaceRoot ?? process.cwd(),
      fileContents,
      customPrompt: profile?.systemPrompt,
      profileName: profileName || null,
      prefetchedMemory,
    });

    // Per-worker LLM client — provider-aware
    const { providerId } = detectProvider(effectiveModel);
    const client = createLLMClient({
      getToken: () => getProviderToken(providerId),
      model: effectiveModel,
      providerId,
    });

    // Per-worker permission context: explicit auto-approve (spec §4.2 step 4)
    // Workers never prompt interactively — autoApprove is by design, not by omission.
    const permCtx = createPermissionContext({ autoApprove: true });

    // Resolve tool set: profile + inline overrides
    const baseToolNames = getToolNames();
    const resolvedNames = resolveToolSet(baseToolNames, profile, { allowedTools });
    const effectiveToolNames = new Set(resolvedNames);

    const workerExecuteTool = async (name, args, callId) => {
      // Enforce tool restrictions at execution level (defense in depth)
      // Note: 'agent' is handled by depth guard in tool list building, not here
      if (!effectiveToolNames.has(name)) {
        return { error: true, message: `Tool '${name}' not allowed for this worker${profile ? ` (profile: ${profileName})` : ''}` };
      }

      // V2b: Agent memory namespace injection
      if (profileName) {
        if (name === 'brain_remember') {
          // Auto-tag with agent:<profile> + add agentProfile metadata
          const existingTags = (args.tags || []).filter(t => !t.startsWith('agent:'));
          args = { ...args, tags: [...existingTags, `agent:${profileName}`], agentProfile: profileName };
        }
        if (name === 'brain_search') {
          // Pass agent context for boosted results
          args = { ...args, agentContext: profileName };
        }
      }

      const allowed = await permCtx.checkPermission(name, args);
      if (!allowed) return { error: true, message: 'Worker permission denied' };
      if (name === 'agent') {
        // Pass depth through to nested agent calls (depth guard enforced there)
        return executeTool(name, { ...args, _depth: _depth + 1 }, callId);
      }
      return executeTool(name, args, callId);
    };

    // AbortController for timeout + optional external cancellation (e.g. MCP client cancel)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    if (_signal) _signal.addEventListener('abort', () => controller.abort());
    const abortPromise = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new Error(`timeout after ${effectiveTimeout}ms`))
      );
    });

    try {
      // Build tool schemas from resolved set, then depth guard
      let workerTools = getToolSchemas()
        .filter(t => effectiveToolNames.has(t.name))
        .filter(t => t.name !== 'agent' || _depth + 1 < maxDepth);

      // V2b: Remove brain tools based on profile capabilities
      if (profile && !profile.brain?.remember) {
        workerTools = workerTools.filter(t => t.name !== 'brain_remember');
      }
      if (profile && !profile.brain?.search) {
        workerTools = workerTools.filter(t => t.name !== 'brain_search');
      }

      const result = await Promise.race([
        runAgentTurnFn({
          client,
          systemPrompt,
          userInput: prompt,
          history: [],
          tools: workerTools,
          executeTool: workerExecuteTool,
          signal: controller.signal,
          maxIterations: effectiveMaxSteps,
          onStep: (step) => {
            // Workers MUST NOT write to stdout (corrupts MCP JSON-RPC protocol)
            if (step.type === 'tool_call') {
              process.stderr.write(`  \x1b[2m[${workerId}] → ${step.name}\x1b[0m\n`);
            }
          },
        }),
        abortPromise,
      ]);

      const usage = result.usage ?? {};
      const tokensUsed = (usage.input_tokens ?? usage.prompt_tokens ?? 0)
                       + (usage.output_tokens ?? usage.completion_tokens ?? 0);

      return { success: true, text: result.text, tokensUsed, workerId };

    } catch (err) {
      if (controller.signal.aborted) {
        return { success: false, error: `timeout after ${effectiveTimeout}ms`, workerId };
      }
      return { success: false, error: err.message ?? String(err), workerId };
    } finally {
      clearTimeout(timer);
    }
  }

  const schema = {
    type: 'function',
    name: 'agent',
    description: 'Spawn a focused worker agent to complete a specific subtask with a clean context window. Workers run in parallel when multiple agent() calls are made in the same turn. Returns a concise result summary.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task description and instructions for the worker' },
        profile: { type: 'string', description: 'Named agent profile from ~/.claudia/agents/<name>.yml (overrides model, tools, timeout, prompt)' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to inject directly into the worker context (optional, max 100KB/file, 500KB total)',
        },
        model: { type: 'string', description: 'Model override for this worker (optional, default: config model)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (optional, default: 60000)' },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict worker to these tools only (optional, default: all tools). Example: ["read","grep","glob"] for read-only worker.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };

  return { schema, execute };
}

function buildFileContents(files, workspaceRoot) {
  if (!files?.length) return '';
  let totalBytes = 0;
  const parts = [];

  for (const fp of files) {
    const abs = resolve(workspaceRoot, fp);
    if (!existsSync(abs)) {
      parts.push(`<!-- not found: ${basename(fp)} -->`);
      continue;
    }
    try {
      const content = readFileSync(abs, 'utf8');
      if (content.length > MAX_FILE_BYTES) {
        parts.push(`<!-- skipped (too large, ${content.length} bytes): ${basename(abs)} -->`);
        continue;
      }
      if (totalBytes + content.length > MAX_TOTAL_BYTES) {
        parts.push(`<!-- skipped (total limit reached): ${basename(abs)} -->`);
        continue;
      }
      totalBytes += content.length;
      const lang = extname(abs).slice(1) || 'text';
      parts.push(`<file path="${abs}" lang="${lang}">\n${content}\n</file>`);
    } catch {
      parts.push(`<!-- unreadable: ${basename(abs)} -->`);
    }
  }

  return parts.length ? `<files>\n${parts.join('\n')}\n</files>` : '';
}

// Called by registerBuiltinTools when config.swarm=true
// Accepts optional registry param for custom registries (tests, MCP).
// Default: writes to global defaultRegistry via registerTool.
export function registerAgentTool(config, registry) {
  const tool = createAgentTool({ config });
  const def = {
    description: tool.schema.description,
    parameters: tool.schema.parameters,
    execute: tool.execute,
  };
  if (registry) {
    registry.set('agent', def);
  } else {
    registerTool('agent', def);
  }
}
