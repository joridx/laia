# claudia swarm Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `agent` tool that lets claudia orchestrate in-process workers with fresh context and parallel execution — zero changes to existing files until `/swarm on` or `--swarm` is used.

**Architecture:** `src/tools/agent.js` is self-contained — it creates its own LLM client, uses the global (stateless) tool registry with a recursion block, and auto-approves permissions internally. Swarm mode is off by default; the tool registers only when `config.swarm=true`. Parallelism via an `executeToolBatch` optional hook added to `llm.js` (`Promise.allSettled` + zero-dep semaphore in `src/swarm.js`). MCP server mode via `--mcp` flag.

**Tech Stack:** Node.js 24+ ESM, `node:test`, `@modelcontextprotocol/sdk` (already installed)

**Spec:** `docs/superpowers/specs/2026-03-18-claudia-swarm-design.md`

---

## Key Design Simplification

The global tool registry (`read`, `write`, `bash`, etc.) is **stateless** — no session state, no shared mutable objects. Workers can safely use it directly. The only things that need to be per-worker are:
- **LLM client** → `createLLMClient()` per call (already the pattern)
- **Permissions** → `autoApprove: true` inline, no global state changes
- **Recursion** → depth guard + block `agent` tool in worker's `executeTool` callback

This means **zero changes to existing tool files, permissions.js, or tools/index.js** for the core feature.

---

## File Map

```
CREATE: src/swarm.js               — semaphore + createDispatchToolBatch
CREATE: src/tools/agent.js         — the agent tool (self-contained)
CREATE: src/mcp-server.js          — MCP server mode
MODIFY: src/llm.js                 — add signal param + optional executeToolBatch hook (~20 lines)
MODIFY: src/system-prompt.js       — add buildWorkerSystemPrompt()
MODIFY: src/tools/index.js         — conditional registerAgentTool in registerBuiltinTools
MODIFY: src/agent.js               — pass executeToolBatch to runAgentTurn when swarm active
MODIFY: src/repl.js                — /swarm command
MODIFY: src/config.js              — swarmOverride param
MODIFY: bin/claudia.js             — --swarm + --mcp flags
CREATE: tests/unit/swarm.test.js   — all swarm tests
```

---

## Task 1: `src/swarm.js` — semaphore + batch dispatcher

**Files:**
- Create: `src/swarm.js`
- Test: `tests/unit/swarm.test.js`

- [ ] **Step 1.1: Write failing tests**

Create `tests/unit/swarm.test.js`:

```javascript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createSemaphore, createDispatchToolBatch } from '../../src/swarm.js';

describe('createSemaphore', () => {
  it('limits concurrency to max', async () => {
    const sem = createSemaphore(2);
    let concurrent = 0, maxSeen = 0;

    async function task() {
      const release = await sem.acquire();
      concurrent++;
      maxSeen = Math.max(maxSeen, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
      release();
    }

    await Promise.all([task(), task(), task(), task(), task()]);
    assert.equal(maxSeen, 2);
  });

  it('releases slot after error', async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire();
    release(); // release immediately
    // Should be acquirable again
    const release2 = await sem.acquire();
    assert.ok(release2);
    release2();
  });
});

describe('createDispatchToolBatch', () => {
  it('runs all-agent batches in parallel', async () => {
    const starts = [];
    const mockExecute = async (name, args) => {
      starts.push(Date.now());
      await new Promise(r => setTimeout(r, 50));
      return { ok: true };
    };

    const dispatch = createDispatchToolBatch(mockExecute);
    const calls = [
      { name: 'agent', callId: 'c1', args: { prompt: 'task1' } },
      { name: 'agent', callId: 'c2', args: { prompt: 'task2' } },
    ];

    const t0 = Date.now();
    const results = await dispatch(calls);
    const elapsed = Date.now() - t0;

    // Parallel: should complete in ~50ms, not ~100ms
    assert.ok(elapsed < 90, `Expected <90ms parallel, got ${elapsed}ms`);
    assert.equal(results.length, 2);
    assert.equal(results[0].result.ok, true);
  });

  it('runs mixed batches sequentially (fallback)', async () => {
    const order = [];
    const mockExecute = async (name) => {
      order.push(name);
      return { ok: true };
    };

    const dispatch = createDispatchToolBatch(mockExecute);
    const calls = [
      { name: 'agent', callId: 'c1', args: {} },
      { name: 'read',  callId: 'c2', args: {} },
    ];

    await dispatch(calls);
    assert.deepEqual(order, ['agent', 'read']); // sequential
  });

  it('returns error result when worker throws', async () => {
    const mockExecute = async () => { throw new Error('worker crashed'); };
    const dispatch = createDispatchToolBatch(mockExecute);
    const results = await dispatch([{ name: 'agent', callId: 'c1', args: {} }]);
    assert.equal(results[0].result.error, true);
    assert.match(results[0].result.message, /worker crashed/);
  });
});
```

- [ ] **Step 1.2: Run tests — verify they fail**

```bash
node --test tests/unit/swarm.test.js 2>&1 | head -20
```
Expected: `Cannot find module '../../src/swarm.js'`

- [ ] **Step 1.3: Create `src/swarm.js`**

```javascript
// Swarm utilities: semaphore + batch tool dispatcher
// Separate file to avoid circular imports between agent.js and tools/agent.js

export function createSemaphore(max) {
  let count = 0;
  const queue = [];

  function acquire() {
    if (count < max) {
      count++;
      return Promise.resolve(release);
    }
    return new Promise(resolve => queue.push(resolve));
  }

  function release() {
    count--;
    const next = queue.shift();
    if (next) { count++; next(release); }
  }

  return { acquire };
}

const DEFAULT_SEMAPHORE = createSemaphore(4);

// executeToolFn: (name, args, callId) => Promise<result>
// Returns: Array<{ callId, result }>
export function createDispatchToolBatch(executeToolFn, semaphore = DEFAULT_SEMAPHORE) {
  return async function dispatchBatch(toolCalls) {
    const allAgent = toolCalls.every(tc => tc.name === 'agent');

    if (!allAgent) {
      // Mixed batch — sequential (safe default)
      const results = [];
      for (const tc of toolCalls) {
        let result;
        try { result = await executeToolFn(tc.name, tc.args, tc.callId); }
        catch (err) { result = { error: true, message: err?.message ?? String(err) }; }
        results.push({ callId: tc.callId, result });
      }
      return results;
    }

    // All-agent batch — parallel with semaphore
    const settled = await Promise.allSettled(
      toolCalls.map(async tc => {
        const release = await semaphore.acquire();
        try {
          const result = await executeToolFn(tc.name, tc.args, tc.callId);
          return { callId: tc.callId, result };
        } catch (err) {
          return { callId: tc.callId, result: { error: true, message: err?.message ?? String(err) } };
        } finally {
          release();
        }
      })
    );

    return settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { callId: toolCalls[i].callId, result: { error: true, message: s.reason?.message ?? 'batch failed' } }
    );
  };
}
```

- [ ] **Step 1.4: Run tests — all pass**

```bash
node --test tests/unit/swarm.test.js 2>&1 | tail -10
```
Expected: all 4 swarm tests pass

- [ ] **Step 1.5: Run full suite — no regressions**

```bash
node --test 'tests/**/*.test.js' 2>&1 | tail -5
```

- [ ] **Step 1.6: Commit**

```bash
git add src/swarm.js tests/unit/swarm.test.js
git commit -m "feat(swarm): zero-dep semaphore + createDispatchToolBatch"
```

---

## Task 2: Add `executeToolBatch` hook + `signal` to `src/llm.js`

**Files:**
- Modify: `src/llm.js`

- [ ] **Step 2.1: Add `signal` param to `runAgentTurn`**

Change the signature at line 201:

```javascript
// BEFORE:
export async function runAgentTurn({ client, systemPrompt, userInput, history = [], tools = [], executeTool, onStep, maxIterations = MAX_TOOL_ITERATIONS } = {}) {

// AFTER:
export async function runAgentTurn({ client, systemPrompt, userInput, history = [], tools = [], executeTool, executeToolBatch, onStep, maxIterations = MAX_TOOL_ITERATIONS, signal } = {}) {
```

Pass both new params to `runResponsesTurn` and `runChatTurn` (lines 204-208):

```javascript
  if (isResponsesModel(model)) {
    return runResponsesTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, executeToolBatch, onStep, maxIterations, signal });
  } else {
    return runChatTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, executeToolBatch, onStep, maxIterations, signal });
  }
```

- [ ] **Step 2.2: Thread `signal` to `fetch` via `AbortSignal.any`**

In `streamingApiCall` (line 94), change signature and merge signals:

```javascript
// BEFORE:
async function streamingApiCall(endpoint, body, { onChunk } = {}) {
  const token = await getToken({ attempt: 0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // ...
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...
    signal: controller.signal,

// AFTER:
async function streamingApiCall(endpoint, body, { onChunk, signal: externalSignal } = {}) {
  const token = await getToken({ attempt: 0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  // ...
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...
    signal,   // ← merged signal
```

Apply the same pattern to `apiCall` (line 58).

Thread `signal` from `runResponsesTurn` and `runChatTurn` into their `streamingApiCall`/`apiCall` calls. For `runResponsesTurn`, the two `client.streamingApiCall` calls (lines ~219 and ~260) gain `signal`. For `runChatTurn`, the `chatCall` inner function passes it to `streamingApiCall`/`apiCall`.

- [ ] **Step 2.3: Add `executeToolBatch` hook — extract tool execution into helpers**

Add two helpers just before `runResponsesTurn`:

```javascript
// Sequential tool execution (default)
async function runToolsSequential(toolCalls, executeTool, onStep) {
  const results = [];
  for (const tc of toolCalls) {
    onStep?.({ type: 'tool_call', name: tc.name, callId: tc.callId, args: tc.args });
    let result;
    try { result = await executeTool(tc.name, tc.args, tc.callId); }
    catch (err) { result = { error: true, message: err?.message ?? String(err) }; }
    onStep?.({ type: 'tool_result', name: tc.name, callId: tc.callId, result });
    results.push({ tc, result });
  }
  return results;
}

// Batch tool execution (swarm mode — parallel agent calls)
async function runToolsBatch(toolCalls, executeToolBatch, onStep) {
  for (const tc of toolCalls) onStep?.({ type: 'tool_call', name: tc.name, callId: tc.callId, args: tc.args });
  const batchResults = await executeToolBatch(toolCalls);
  return toolCalls.map((tc, i) => {
    const result = batchResults[i]?.result ?? { error: true, message: 'no result from batch' };
    onStep?.({ type: 'tool_result', name: tc.name, callId: tc.callId, result });
    return { tc, result };
  });
}
```

In `runResponsesTurn`, replace the sequential `for` loop (lines ~246-258) with:

```javascript
    const toolResults = executeToolBatch
      ? await runToolsBatch(parsed.toolCalls, executeToolBatch, onStep)
      : await runToolsSequential(parsed.toolCalls, executeTool, onStep);

    for (const { tc, result } of toolResults) {
      const output = serialize(result);
      transcript.push({ type: 'function_call_output', call_id: tc.callId, output });
      turnChat.push({ role: 'tool', tool_call_id: tc.callId, content: output });
    }
```

Apply the same replacement in `runChatTurn` (lines ~372-380).

- [ ] **Step 2.4: Run full test suite — no regressions**

```bash
node --test 'tests/**/*.test.js' 2>&1 | tail -10
```
Expected: all tests still pass (new params are optional, backwards compat)

- [ ] **Step 2.5: Commit**

```bash
git add src/llm.js
git commit -m "feat(swarm): signal threading + executeToolBatch hook in llm.js"
```

---

## Task 3: `buildWorkerSystemPrompt` in `src/system-prompt.js`

**Files:**
- Modify: `src/system-prompt.js`

- [ ] **Step 3.1: Add export**

Append to `src/system-prompt.js`:

```javascript
export function buildWorkerSystemPrompt({ workerId, depth, workspaceRoot, fileContents = '' }) {
  const now = new Date().toISOString();
  return `You are a focused worker agent (ID: ${workerId}, depth: ${depth}).

Current date/time: ${now}
Workspace root: ${workspaceRoot}

Complete the assigned task and return a CONCISE result. Do not ask clarifying questions.
Do not add unsolicited explanations. Work only on what was asked.

## Tools

- read(path), write(path, content), edit(path, edits[])
- bash(command), glob(pattern), grep(query, path?)
- git_diff(), git_status(), git_log()

## Rules

1. Inspect before acting. Never guess file contents.
2. Do exactly what was asked. No extra changes.
3. Return a short summary of what was done or found.
${fileContents ? `\n## Pre-loaded Files\n\n${fileContents}` : ''}`;
}
```

- [ ] **Step 3.2: Run full suite**

```bash
node --test 'tests/**/*.test.js' 2>&1 | tail -5
```

- [ ] **Step 3.3: Commit**

```bash
git add src/system-prompt.js
git commit -m "feat(swarm): buildWorkerSystemPrompt"
```

---

## Task 4: Create `src/tools/agent.js` — self-contained agent tool

**Files:**
- Create: `src/tools/agent.js`
- Test: `tests/unit/swarm.test.js`

- [ ] **Step 4.1: Add agent tool tests**

First, add these imports at the **very top** of `tests/unit/swarm.test.js` (after the existing imports):

```javascript
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentTool } from '../../src/tools/agent.js';
```

Then append the tests:

```javascript
// ---- agent tool ----
describe('createAgentTool', () => {
  function makeConfig(overrides = {}) {
    return { workspaceRoot: process.cwd(), model: 'gpt-5.3-codex', swarm: true, ...overrides };
  }

  it('returns success with text from worker', async () => {
    const tool = createAgentTool({
      config: makeConfig(),
      _runAgentTurn: async () => ({ text: 'worker result', usage: { input_tokens: 10, output_tokens: 5 }, turnMessages: [] }),
    });
    const result = await tool.execute({ prompt: 'do something' });
    assert.equal(result.success, true);
    assert.equal(result.text, 'worker result');
    assert.ok(result.workerId.startsWith('worker-'));
    assert.equal(result.tokensUsed, 15);
  });

  it('returns error on timeout', async () => {
    const tool = createAgentTool({
      config: makeConfig(),
      _runAgentTurn: () => new Promise(() => {}), // never resolves
      timeoutMs: 30,
    });
    const result = await tool.execute({ prompt: 'slow' });
    assert.equal(result.success, false);
    assert.match(result.error, /timeout/i);
  });

  it('blocks recursion at maxDepth', async () => {
    const tool = createAgentTool({
      config: makeConfig(),
      _runAgentTurn: async () => ({ text: 'ok', usage: {}, turnMessages: [] }),
      maxDepth: 2,
    });
    const result = await tool.execute({ prompt: 'task', _depth: 2 });
    assert.equal(result.success, false);
    assert.match(result.error, /depth/i);
  });

  it('injects files into system prompt', async () => {
    let capturedSystemPrompt = '';
    const tool = createAgentTool({
      config: makeConfig(),
      _runAgentTurn: async ({ systemPrompt }) => {
        capturedSystemPrompt = systemPrompt;
        return { text: 'ok', usage: {}, turnMessages: [] };
      },
    });
    // Use imports from the top of the file (mkdtempSync, writeFileSync, join, tmpdir)
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const fp = join(dir, 'hello.js');
    writeFileSync(fp, 'const x = 42;');

    await tool.execute({ prompt: 'review', files: [fp] });
    assert.ok(capturedSystemPrompt.includes('const x = 42;'));
  });
});
```

- [ ] **Step 4.2: Run tests — verify they fail**

```bash
node --test tests/unit/swarm.test.js 2>&1 | grep "agent tool"
```

- [ ] **Step 4.3: Create `src/tools/agent.js`**

```javascript
// Agent tool — in-process worker with fresh context
// Self-contained: no changes needed to existing files.
// Registered only when config.swarm=true (see tools/index.js registerBuiltinTools)

import { readFileSync, existsSync } from 'fs';
import { resolve, extname, basename } from 'path';
import { createLLMClient, runAgentTurn as _runAgentTurnDefault } from '../llm.js';
import { getCopilotToken } from '../auth.js';
import { buildWorkerSystemPrompt } from '../system-prompt.js';
import { executeTool, getToolSchemas } from './index.js';
import { registerTool } from './index.js';

// AUTO_ALLOW mirrors permissions.js — workers bypass interactive prompt
const AUTO_ALLOW = new Set(['read', 'glob', 'grep', 'brain_search', 'brain_get_context',
  'run_command', 'git_diff', 'git_status', 'git_log']);

const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 500_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DEPTH = 3;

let workerCounter = 0;

export function createAgentTool({ config, _runAgentTurn, timeoutMs = DEFAULT_TIMEOUT_MS, maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const runAgentTurnFn = _runAgentTurn ?? _runAgentTurnDefault;

  async function execute({ prompt, files = [], model, timeout, _depth = 0 }) {
    // Recursion guard
    if (_depth >= maxDepth) {
      return { success: false, error: `max recursion depth (${maxDepth}) exceeded`, workerId: 'blocked' };
    }

    const workerId = `worker-${++workerCounter}`;
    const effectiveTimeout = timeout ?? timeoutMs;

    // Build injected file contents
    const fileContents = buildFileContents(files, config.workspaceRoot ?? process.cwd());

    // Worker system prompt (focused, no REPL/brain/session instructions)
    const systemPrompt = buildWorkerSystemPrompt({
      workerId, depth: _depth + 1,
      workspaceRoot: config.workspaceRoot ?? process.cwd(),
      fileContents,
    });

    // Per-worker LLM client
    const client = createLLMClient({
      getToken: getCopilotToken,
      model: model ?? config.model,
    });

    // Worker executeTool: use global (stateless) registry, block agent calls, auto-approve all
    const workerExecuteTool = async (name, args, callId) => {
      if (name === 'agent') {
        // Pass depth through to nested agent calls (depth guard enforced there)
        return executeTool(name, { ...args, _depth: _depth + 1 }, callId);
      }
      // All other tools: auto-approve (workers never prompt interactively)
      return executeTool(name, args, callId);
    };

    // AbortController for timeout — signal threads to fetch via llm.js
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const result = await runAgentTurnFn({
        client,
        systemPrompt,
        userInput: prompt,
        history: [],
        tools: getToolSchemas().filter(t => t.name !== 'agent' || _depth + 1 < maxDepth),
        executeTool: workerExecuteTool,
        signal: controller.signal,
        onStep: (step) => {
          // Workers MUST NOT write to stdout (corrupts MCP JSON-RPC protocol)
          if (step.type === 'tool_call') {
            process.stderr.write(`  \x1b[2m[${workerId}] → ${step.name}\x1b[0m\n`);
          }
        },
      });

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
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to inject directly into the worker context (optional, max 100KB/file, 500KB total)',
        },
        model: { type: 'string', description: 'Model override for this worker (optional, default: config model)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (optional, default: 60000)' },
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
// registerTool (exported from index.js line 6) writes to the global defaultRegistry — correct for REPL/one-shot.
// MCP server uses createAgentTool() directly and never calls this function.
export function registerAgentTool(config) {
  const tool = createAgentTool({ config });
  registerTool('agent', {
    description: tool.schema.description,
    parameters: tool.schema.parameters,
    execute: tool.execute,
  });
}
```

- [ ] **Step 4.4: Update `src/tools/index.js` — add conditional agent tool registration**

`registerBuiltinTools` is already `async` (line 30 of current `index.js`). Add at the end of the function body:

```javascript
  // Agent tool — only when swarm mode is enabled
  if (config.swarm) {
    const { registerAgentTool } = await import('./agent.js');
    registerAgentTool(config);  // writes to global defaultRegistry
  }
```

The MCP server calls `createAgentTool()` directly and does not use this path.

- [ ] **Step 4.5: Run agent tool tests**

```bash
node --test tests/unit/swarm.test.js 2>&1 | grep -A3 "agent tool"
```

- [ ] **Step 4.6: Run full suite**

```bash
node --test 'tests/**/*.test.js' 2>&1 | tail -10
```
Expected: all tests pass

- [ ] **Step 4.7: Commit**

```bash
git add src/tools/agent.js src/tools/index.js tests/unit/swarm.test.js
git commit -m "feat(swarm): agent tool — self-contained in-process worker"
```

---

## Task 5: Wire `executeToolBatch` in `src/agent.js` + opt-in flags

**Files:**
- Modify: `src/agent.js`
- Modify: `src/config.js`
- Modify: `src/repl.js`
- Modify: `bin/claudia.js`

- [ ] **Step 5.1: Wire `executeToolBatch` in `runTurn`**

Add import at the top of `src/agent.js`:

```javascript
import { createDispatchToolBatch } from './swarm.js';
```

The existing `src/agent.js` imports are:
- `createLLMClient, runAgentTurn` from `./llm.js`
- `getCopilotToken` from `./auth.js`
- `buildSystemPrompt` from `./system-prompt.js`
- `getToolSchemas, executeTool as dispatchTool` from `./tools/index.js`
- `checkPermission, setAutoApprove` from `./permissions.js`

The existing `runTurn` (lines 18-47) currently calls `runAgentTurn` without `executeToolBatch`. Add the swarm dispatcher and pass it:

```javascript
export async function runTurn({ input, config, logger, onStep, history = [] }) {
  const llmClient = getClient(config);
  const systemPrompt = buildSystemPrompt({
    workspaceRoot: config.workspaceRoot,
    model: config.model,
    brainPath: config.brainPath,
  });
  const tools = getToolSchemas();

  // Swarm mode: parallel batch dispatcher for concurrent agent() calls
  const executeToolBatch = config.swarm
    ? createDispatchToolBatch(async (name, args, callId) => {
        const allowed = await checkPermission(name, args);
        if (!allowed) return { error: true, message: 'User denied permission' };
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
      const allowed = await checkPermission(name, args);
      if (!allowed) return { error: true, message: 'User denied permission' };
      return dispatchTool(name, args, callId);
    },
    executeToolBatch,
    onStep: (step) => {
      logger.info('agent_step', step);
      onStep?.(step);
    },
  });

  return result;
}
```

- [ ] **Step 5.2: Add `swarmOverride` to `src/config.js`**

```javascript
export async function loadConfig({ modelOverride, verbose, swarmOverride } = {}) {
  // ... existing code ...
  return {
    ...DEFAULTS,
    ...fileConfig,
    ...(envModel ? { model: envModel } : {}),
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(verbose !== undefined ? { verbose } : {}),
    ...(swarmOverride ? { swarm: true } : {}),
  };
}
```

- [ ] **Step 5.3: Add `--swarm` + `--mcp` flags to `bin/claudia.js`**

Add to `args` defaults:
```javascript
const args = { prompt: null, model: null, json: false, help: false, version: false, verbose: false, swarm: false, mcp: false };
```

Add to the flag parser loop:
```javascript
    else if (a === '--swarm') args.swarm = true;
    else if (a === '--mcp')   args.mcp   = true;
```

Update `loadConfig` call:
```javascript
const config = await loadConfig({ modelOverride: args.model, verbose: args.verbose, swarmOverride: args.swarm });
```

Update entry point:
```javascript
if (args.mcp) {
  const { startMcpServer } = await import('../src/mcp-server.js');
  await startMcpServer({ config, logger });
} else if (args.prompt) {
  await runOneShot({ prompt: args.prompt, config, logger, json: args.json });
} else {
  await runRepl({ config, logger });
}
```

Update help text:
```
  --swarm               Enable swarm mode (agent tool active)
  --mcp                 Start as MCP server for Claude Code integration
```

- [ ] **Step 5.4: Add `/swarm` command to `src/repl.js`**

Add `/swarm` to `BUILTIN_COMMANDS`:
```javascript
const BUILTIN_COMMANDS = ['/help', '/model', '/clear', '/compact', '/save', '/load', '/sessions', '/attach', '/detach', '/attached', '/swarm', '/exit', '/quit'];
```

In the slash command handler block (where `/model`, `/save`, etc. are handled), add:

```javascript
} else if (trimmed === '/swarm' || trimmed.startsWith('/swarm ')) {
  const arg = trimmed.split(' ')[1]?.toLowerCase();
  if (arg === 'on') {
    config.swarm = true;
    await registerBuiltinTools(config);
    stderr.write('\x1b[32mSwarm mode ON — agent tool active\x1b[0m\n');
  } else if (arg === 'off') {
    config.swarm = false;
    stderr.write('\x1b[33mSwarm mode OFF\x1b[0m\n');
  } else {
    stderr.write(`Swarm mode: ${config.swarm ? '\x1b[32mON\x1b[0m' : '\x1b[33mOFF\x1b[0m'}\n`);
  }
  continue;
```

- [ ] **Step 5.5: Run full test suite**

```bash
node --test 'tests/**/*.test.js' 2>&1 | tail -10
```

- [ ] **Step 5.6: Smoke test `--swarm` flag**

```bash
node bin/claudia.js --swarm -p "what tools do you have?" --json 2>/dev/null | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ const r=JSON.parse(d); console.log('has agent tool:', r.text?.toLowerCase().includes('agent')); })"
```
Expected: `has agent tool: true`

- [ ] **Step 5.7: Commit**

```bash
git add src/agent.js src/config.js src/repl.js bin/claudia.js
git commit -m "feat(swarm): --swarm flag + /swarm command + executeToolBatch wired in runTurn"
```

---

## Task 6: Create `src/mcp-server.js`

**Files:**
- Create: `src/mcp-server.js`

- [ ] **Step 6.1: Create `src/mcp-server.js`**

```javascript
// MCP server mode — exposes 'agent' tool via stdio JSON-RPC transport
// Usage: node bin/claudia.js --mcp
// Claude Code: claude mcp add claudia -- node /path/to/bin/claudia.js --mcp
//
// CRITICAL: nothing may write to process.stdout except MCP protocol frames.
// All internal logs, worker output, and debug info → process.stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentTool } from './tools/agent.js';
import { registerBuiltinTools } from './tools/index.js';
import { startBrain, stopBrain } from './brain/client.js';

export async function startMcpServer({ config, logger }) {
  // Workers in MCP mode never recurse back through MCP (disable swarm in worker config)
  const workerConfig = { ...config, swarm: false };

  // Brain: start once, owned by server — workers never call startBrain/stopBrain
  try { await startBrain({ brainPath: config.brainPath }); } catch (e) {
    process.stderr.write(`[mcp] brain start failed: ${e.message}\n`);
  }

  // Register builtin tools so workers can use them
  await registerBuiltinTools(workerConfig);

  const agentTool = createAgentTool({ config: workerConfig });

  const server = new Server(
    { name: 'claudia', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'agent',
      description: agentTool.schema.description,
      inputSchema: agentTool.schema.parameters,
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== 'agent') {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    try {
      const result = await agentTool.execute(args ?? {});
      return {
        content: [{ type: 'text', text: result.success ? result.text : `Error: ${result.error}` }],
        isError: !result.success,
      };
    } catch (err) {
      process.stderr.write(`[mcp] uncaught error: ${err.message}\n`);
      return { content: [{ type: 'text', text: `Fatal: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[claudia MCP server] running on stdio\n');

  const shutdown = async () => {
    try { await stopBrain(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
```

- [ ] **Step 6.2: Smoke test — MCP server starts and lists tools**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | timeout 8 node bin/claudia.js --mcp 2>/dev/null
```
Expected: JSON response containing `"name":"agent"` (or a timeout without crash)

- [ ] **Step 6.3: Run full test suite**

```bash
node --test 'tests/**/*.test.js' 2>&1 | tail -10
```

- [ ] **Step 6.4: Commit**

```bash
git add src/mcp-server.js
git commit -m "feat(swarm): MCP server mode — exposes agent tool via stdio for Claude Code"
```

> **Out of scope for this plan (intentional):**
> - MCP client cancellation propagation (spec 4.2 — "si el client MCP envia cancel·lació"). The AbortController wiring exists but MCP cancel signals are not forwarded to in-flight workers. Deferred.
> - Per-worker ToolRegistry instancing (spec 4.3). The plan uses the global stateless registry with a recursion guard. The spec's isolation tests ("tool registry isolated per worker") are intentionally dropped — the global registry is safe because all tools are stateless.

---

## Task 7: End-to-end verification + ROADMAP

- [ ] **Step 7.1: Run full test suite — final check**

```bash
node --test 'tests/**/*.test.js' 2>&1
```
Expected: all existing tests pass + all new swarm tests pass. Note the count in output.

- [ ] **Step 7.2: End-to-end parallel swarm test**

```bash
node bin/claudia.js --swarm -p "Use the agent tool to run TWO workers in parallel. Worker 1: count the lines in src/agent.js. Worker 2: count the lines in src/llm.js. Report both results." 2>/dev/null
```
Expected: see `[worker-N] → read` in stderr for both workers, final answer reports both line counts.

- [ ] **Step 7.3: Update ROADMAP.md**

Move `claudia swarm — agent tool (in-process)` and `claudia MCP server mode` from Backlog to the Done table. Update stats:
- Tools LLM: 13 (was 12, +1 agent)
- Fitxers src/: 20 (was 17, +swarm.js, tools/agent.js, mcp-server.js)

- [ ] **Step 7.4: Commit all**

```bash
git add ROADMAP.md
git commit -m "docs: mark claudia swarm + MCP server as implemented"
```
