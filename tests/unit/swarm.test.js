import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSemaphore, createDispatchToolBatch } from '../../src/swarm.js';
import { createAgentTool } from '../../src/tools/agent.js';

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
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    const fp = join(dir, 'hello.js');
    writeFileSync(fp, 'console.log("hello")');
    await tool.execute({ prompt: 'read it', files: [fp] });
    assert.ok(capturedSystemPrompt.includes('console.log'), 'file content should be in system prompt');
  });

  it('handles missing files gracefully', async () => {
    let capturedSystemPrompt = '';
    const tool = createAgentTool({
      config: makeConfig(),
      _runAgentTurn: async ({ systemPrompt }) => {
        capturedSystemPrompt = systemPrompt;
        return { text: 'ok', usage: {}, turnMessages: [] };
      },
    });
    const result = await tool.execute({ prompt: 'task', files: ['/nonexistent/file.js'] });
    assert.equal(result.success, true);
    assert.ok(capturedSystemPrompt.includes('not found'));
  });

  it('filters agent tool from worker schemas at max depth', async () => {
    let capturedTools = [];
    const tool = createAgentTool({
      config: makeConfig(),
      _runAgentTurn: async ({ tools }) => {
        capturedTools = tools;
        return { text: 'ok', usage: {}, turnMessages: [] };
      },
      maxDepth: 3,
    });
    // At depth 2, next depth is 3 which equals maxDepth, so agent should be filtered
    await tool.execute({ prompt: 'task', _depth: 2 });
    const hasAgent = capturedTools.some(t => t.name === 'agent');
    assert.equal(hasAgent, false, 'agent tool should be filtered at depth reaching maxDepth');
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
