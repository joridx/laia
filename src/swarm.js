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
