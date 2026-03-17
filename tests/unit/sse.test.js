// tests/unit/sse.test.js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSSEStream } from '../../src/llm.js';

// Helper: turn an array of strings into a ReadableStream
function makeStream(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

describe('parseSSEStream', () => {
  it('yields parsed JSON from data lines', async () => {
    const stream = makeStream(['data: {"type":"hello"}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ type: 'hello' }]);
  });

  it('handles multiple events in one chunk', async () => {
    const stream = makeStream(['data: {"a":1}\n\ndata: {"b":2}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ a: 1 }, { b: 2 }]);
  });

  it('handles events split across chunks', async () => {
    const stream = makeStream(['data: {"a"', ':1}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ a: 1 }]);
  });

  it('ignores comment lines starting with :', async () => {
    const stream = makeStream([': ping\ndata: {"ok":true}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ ok: true }]);
  });

  it('terminates on [DONE]', async () => {
    const stream = makeStream(['data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ a: 1 }]);
  });

  it('skips malformed JSON without crashing', async () => {
    const stream = makeStream(['data: not-json\n\ndata: {"ok":true}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ ok: true }]);
  });

  it('throws immediately for null body', async () => {
    await assert.rejects(
      async () => { for await (const _ of parseSSEStream(null)) {} },
      /Stream body is null/
    );
  });
});
