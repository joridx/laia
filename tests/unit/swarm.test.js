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
