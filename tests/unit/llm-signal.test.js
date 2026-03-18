import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// We test the signal-threading and executeToolBatch hook by importing helpers
// directly from llm.js. Since the internal helpers aren't exported, we test
// indirectly via runAgentTurn with mocked clients.

import { runAgentTurn } from '../../src/llm.js';

// --- Mock client factory ---
function mockClient(model, responses) {
  let callIndex = 0;
  return {
    model,
    async streamingApiCall(endpoint, body, opts) {
      return responses[callIndex++] ?? responses[responses.length - 1];
    },
    async apiCall(endpoint, body, opts) {
      return responses[callIndex++] ?? responses[responses.length - 1];
    },
  };
}

// Chat completion response helper
function chatResp({ text, toolCalls, usage } = {}) {
  const msg = { role: 'assistant', content: text || null };
  if (toolCalls?.length) {
    msg.tool_calls = toolCalls.map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }));
  }
  return { choices: [{ message: msg, finish_reason: toolCalls?.length ? 'tool_calls' : 'stop' }], usage: usage ?? {} };
}

describe('runAgentTurn signal threading', () => {
  it('accepts signal param without breaking (backwards-compat)', async () => {
    const client = mockClient('gpt-4o', [chatResp({ text: 'hello' })]);
    const result = await runAgentTurn({
      client,
      systemPrompt: 'test',
      userInput: 'hi',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.text, 'hello');
  });

  it('works without signal param (backwards-compat)', async () => {
    const client = mockClient('gpt-4o', [chatResp({ text: 'world' })]);
    const result = await runAgentTurn({
      client,
      systemPrompt: 'test',
      userInput: 'hi',
    });
    assert.equal(result.text, 'world');
  });
});

describe('runAgentTurn executeToolBatch hook', () => {
  it('uses executeToolBatch when provided', async () => {
    let batchCalled = false;
    const toolCalls = [
      { name: 'agent', id: 'c1', args: { prompt: 'task1' } },
      { name: 'agent', id: 'c2', args: { prompt: 'task2' } },
    ];
    const client = mockClient('gpt-4o', [
      chatResp({ toolCalls }),
      chatResp({ text: 'done' }),
    ]);

    const result = await runAgentTurn({
      client,
      systemPrompt: 'test',
      userInput: 'do it',
      tools: [{ name: 'agent', description: 'agent', parameters: {} }],
      executeTool: async () => ({ ok: true }),
      executeToolBatch: async (calls) => {
        batchCalled = true;
        return calls.map(tc => ({ callId: tc.callId, result: { ok: true } }));
      },
    });

    assert.ok(batchCalled, 'executeToolBatch should have been called');
    assert.equal(result.text, 'done');
  });

  it('falls back to sequential executeTool when no batch hook', async () => {
    const executedTools = [];
    const toolCalls = [
      { name: 'read', id: 'c1', args: { path: 'a.js' } },
      { name: 'read', id: 'c2', args: { path: 'b.js' } },
    ];
    const client = mockClient('gpt-4o', [
      chatResp({ toolCalls }),
      chatResp({ text: 'read both' }),
    ]);

    const result = await runAgentTurn({
      client,
      systemPrompt: 'test',
      userInput: 'read files',
      tools: [{ name: 'read', description: 'read', parameters: {} }],
      executeTool: async (name, args) => {
        executedTools.push(name);
        return { content: 'file content' };
      },
    });

    assert.deepEqual(executedTools, ['read', 'read']);
    assert.equal(result.text, 'read both');
  });

  it('executeToolBatch results are fed back to LLM', async () => {
    const toolCalls = [{ name: 'agent', id: 'c1', args: { prompt: 'x' } }];
    let capturedMessages = null;
    const client = {
      model: 'gpt-4o',
      callCount: 0,
      async streamingApiCall(endpoint, body) {
        this.callCount++;
        if (this.callCount === 1) return chatResp({ toolCalls });
        capturedMessages = body.messages;
        return chatResp({ text: 'final' });
      },
      async apiCall(endpoint, body) {
        return this.streamingApiCall(endpoint, body);
      },
    };

    await runAgentTurn({
      client,
      systemPrompt: 'test',
      userInput: 'go',
      tools: [{ name: 'agent', description: 'agent', parameters: {} }],
      executeTool: async () => ({ ok: true }),
      executeToolBatch: async (calls) => {
        return calls.map(tc => ({ callId: tc.callId, result: { worker: 'result' } }));
      },
    });

    // The tool result should be in the messages sent to the LLM
    const toolMsg = capturedMessages?.find(m => m.role === 'tool');
    assert.ok(toolMsg, 'tool result message should be present');
    assert.ok(toolMsg.content.includes('worker'), 'tool result should contain worker result');
  });
});
