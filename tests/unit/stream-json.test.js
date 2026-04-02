// tests/unit/stream-json.test.js
// Unit tests for stream-json protocol: parseUserMessage + createStepEmitter
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseUserMessage, createStepEmitter } from '../../src/stream-json.js';

// ── parseUserMessage ───────────────────────────────────────────────

describe('parseUserMessage', () => {
  it('parses Claude Code format with content array', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello world' }],
      },
    };
    assert.equal(parseUserMessage(msg), 'hello world');
  });

  it('joins multiple text blocks with newline', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      },
    };
    assert.equal(parseUserMessage(msg), 'line 1\nline 2');
  });

  it('accepts string content directly', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'plain string' },
    };
    assert.equal(parseUserMessage(msg), 'plain string');
  });

  it('returns null for non-user type', () => {
    assert.equal(parseUserMessage({ type: 'assistant', message: {} }), null);
  });

  it('returns null for missing message', () => {
    assert.equal(parseUserMessage({ type: 'user' }), null);
  });

  it('returns null for empty content array', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: [] },
    };
    assert.equal(parseUserMessage(msg), null);
  });

  it('ignores non-text content blocks', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', url: 'http://...' },
          { type: 'text', text: 'only text' },
        ],
      },
    };
    assert.equal(parseUserMessage(msg), 'only text');
  });

  it('returns null when content is an object (not array/string)', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: { some: 'object' } },
    };
    assert.equal(parseUserMessage(msg), null);
  });
});

// ── createStepEmitter ──────────────────────────────────────────────

describe('createStepEmitter', () => {
  function collect(model = 'test-model') {
    const messages = [];
    const emitter = createStepEmitter(model, (msg) => messages.push(msg));
    return { messages, emitter };
  }

  // -- token --

  it('buffers tokens and flushes on flush()', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'token', text: 'hello' });
    assert.equal(messages.length, 0); // buffered, not flushed yet
    emitter.flush();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'assistant');
    assert.equal(messages[0].message.content[0].text, 'hello');
    assert.equal(messages[0].message.stop_reason, 'end_turn');
  });

  it('auto-flushes tokens at 200 chars', () => {
    const { messages, emitter } = collect();
    // Send 210 chars in one token
    emitter.onStep({ type: 'token', text: 'a'.repeat(210) });
    assert.equal(messages.length, 1); // auto-flushed
    assert.equal(messages[0].message.content[0].text, 'a'.repeat(210));
    assert.equal(messages[0].message.stop_reason, null); // intermediate, not end_turn
  });

  it('accumulates multiple small tokens', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'token', text: 'foo' });
    emitter.onStep({ type: 'token', text: ' bar' });
    emitter.flush();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.content[0].text, 'foo bar');
  });

  it('flush with no pending text is a no-op', () => {
    const { messages, emitter } = collect();
    emitter.flush();
    assert.equal(messages.length, 0);
  });

  // -- tool_call --

  it('emits tool_use in assistant message with stop_reason tool_use', () => {
    const { messages, emitter } = collect();
    emitter.onStep({
      type: 'tool_call',
      name: 'read',
      callId: 'call_123',
      args: { path: '/tmp/foo' },
    });
    assert.equal(messages.length, 1);
    const msg = messages[0];
    assert.equal(msg.type, 'assistant');
    assert.equal(msg.message.stop_reason, 'tool_use');
    const block = msg.message.content[0];
    assert.equal(block.type, 'tool_use');
    assert.equal(block.id, 'call_123');
    assert.equal(block.name, 'read');
    assert.deepEqual(block.input, { path: '/tmp/foo' });
  });

  it('flushes pending text before tool_call', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'token', text: 'thinking...' });
    emitter.onStep({ type: 'tool_call', name: 'bash', callId: 'c1', args: { command: 'ls' } });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].message.content[0].type, 'text');
    assert.equal(messages[0].message.content[0].text, 'thinking...');
    assert.equal(messages[1].message.content[0].type, 'tool_use');
  });

  it('defaults args to empty object when missing', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'tool_call', name: 'read', callId: 'c2' });
    assert.deepEqual(messages[0].message.content[0].input, {});
  });

  // -- tool_result --

  it('emits tool_result as user message', () => {
    const { messages, emitter } = collect();
    emitter.onStep({
      type: 'tool_result',
      name: 'read',
      callId: 'call_123',
      result: 'file content here',
    });
    assert.equal(messages.length, 1);
    const msg = messages[0];
    assert.equal(msg.type, 'user');
    assert.equal(msg.content[0].type, 'tool_result');
    assert.equal(msg.content[0].tool_use_id, 'call_123');
    assert.equal(msg.content[0].content, 'file content here');
    assert.equal(msg.content[0].is_error, false);
  });

  it('detects bash error via exitCode', () => {
    const { messages, emitter } = collect();
    emitter.onStep({
      type: 'tool_result',
      name: 'bash',
      callId: 'c1',
      result: { exitCode: 1, stdout: '', stderr: 'not found' },
    });
    assert.equal(messages[0].content[0].is_error, true);
  });

  it('detects error flag in result object', () => {
    const { messages, emitter } = collect();
    emitter.onStep({
      type: 'tool_result',
      name: 'read',
      callId: 'c1',
      result: { error: true, message: 'not found' },
    });
    assert.equal(messages[0].content[0].is_error, true);
  });

  it('handles null result', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'tool_result', name: 'read', callId: 'c1', result: null });
    assert.equal(messages[0].content[0].content, 'null');
    assert.equal(messages[0].content[0].is_error, false);
  });

  it('serializes object result to JSON', () => {
    const { messages, emitter } = collect();
    emitter.onStep({
      type: 'tool_result',
      name: 'glob',
      callId: 'c1',
      result: { files: ['a.js', 'b.js'], count: 2 },
    });
    const parsed = JSON.parse(messages[0].content[0].content);
    assert.deepEqual(parsed, { files: ['a.js', 'b.js'], count: 2 });
  });

  // -- final --

  it('flushes remaining text on final with end_turn', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'token', text: 'partial' });
    emitter.onStep({ type: 'final', text: 'partial answer' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.content[0].text, 'partial');
    assert.equal(messages[0].message.stop_reason, 'end_turn');
  });

  it('emits final text directly for non-streaming providers', () => {
    const { messages, emitter } = collect();
    // No tokens seen — final.text should be emitted directly
    emitter.onStep({ type: 'final', text: 'complete answer' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.content[0].text, 'complete answer');
    assert.equal(messages[0].message.stop_reason, 'end_turn');
  });

  it('does not double-emit when tokens were streamed', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'token', text: 'streamed' });
    emitter.onStep({ type: 'final', text: 'streamed' });
    // Only 1 message (the flushed tokens), not a second one for final.text
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.content[0].text, 'streamed');
  });

  // -- reasoning --

  it('emits reasoning as laia:reasoning extension', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'reasoning', summary: 'deep thought' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'laia:reasoning');
    assert.equal(messages[0].content, 'deep thought');
  });

  it('flushes pending text before reasoning', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'token', text: 'before' });
    emitter.onStep({ type: 'reasoning', summary: 'think' });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'assistant');
    assert.equal(messages[1].type, 'laia:reasoning');
  });

  // -- error --

  it('emits error as laia:error', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'error', error: 'something broke', retriable: true });
    assert.equal(messages[0].type, 'laia:error');
    assert.equal(messages[0].error, 'something broke');
    assert.equal(messages[0].retriable, true);
  });

  it('defaults retriable to false', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'error', error: 'fail' });
    assert.equal(messages[0].retriable, false);
  });

  // -- request --

  it('emits request as laia:request', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'request', phase: 'api_call' });
    assert.equal(messages[0].type, 'laia:request');
    assert.equal(messages[0].phase, 'api_call');
  });

  // -- debug --

  it('emits debug as laia:debug', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'debug', info: 'details' });
    assert.equal(messages[0].type, 'laia:debug');
    assert.deepEqual(messages[0].content, { type: 'debug', info: 'details' });
  });

  // -- unknown type --

  it('emits unknown types as laia:* extension', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'custom_thing', data: 42 });
    assert.equal(messages[0].type, 'laia:custom_thing');
    assert.deepEqual(messages[0].content, { type: 'custom_thing', data: 42 });
  });

  // -- message structure (Claude Code compat) --

  it('includes model, type, role, session_id in assistant messages', () => {
    const { messages, emitter } = collect('claude-opus-4.6');
    emitter.onStep({ type: 'token', text: 'hi' });
    emitter.flush();
    const msg = messages[0];
    assert.equal(msg.type, 'assistant');
    assert.equal(msg.message.type, 'message');
    assert.equal(msg.message.role, 'assistant');
    assert.equal(msg.message.model, 'claude-opus-4.6');
    assert.ok(msg.message.id.startsWith('msg_'));
    assert.ok(msg.session_id);
  });

  it('uses "unknown" when model is not provided', () => {
    const messages = [];
    const emitter = createStepEmitter(undefined, (msg) => messages.push(msg));
    emitter.onStep({ type: 'token', text: 'x' });
    emitter.flush();
    assert.equal(messages[0].message.model, 'unknown');
  });

  it('assigns incrementing message IDs', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'tool_call', name: 'read', callId: 'a' });
    emitter.onStep({ type: 'tool_call', name: 'write', callId: 'b' });
    const id1 = messages[0].message.id;
    const id2 = messages[1].message.id;
    assert.notEqual(id1, id2);
    // Both start with msg_ prefix
    assert.ok(id1.startsWith('msg_'));
    assert.ok(id2.startsWith('msg_'));
  });

  // -- session_id consistency --

  it('includes session_id on all emitted messages', () => {
    const { messages, emitter } = collect();
    emitter.onStep({ type: 'token', text: 'hi' });
    emitter.flush();
    emitter.onStep({ type: 'tool_call', name: 'x', callId: 'c1' });
    emitter.onStep({ type: 'tool_result', name: 'x', callId: 'c1', result: 'ok' });
    emitter.onStep({ type: 'error', error: 'fail' });
    emitter.onStep({ type: 'request', phase: 'api_call' });
    emitter.onStep({ type: 'reasoning', summary: 'think' });
    for (const msg of messages) {
      assert.ok(msg.session_id, `missing session_id on type ${msg.type}`);
    }
  });

  // -- complex sequence --

  it('handles a full turn sequence correctly', () => {
    const { messages, emitter } = collect('test-model');
    // Simulate: think → tool_call → tool_result → text answer → final
    emitter.onStep({ type: 'request', phase: 'api_call' });
    emitter.onStep({ type: 'token', text: "Let me check" });
    emitter.onStep({ type: 'tool_call', name: 'read', callId: 'tc1', args: { path: '/f' } });
    emitter.onStep({ type: 'tool_result', name: 'read', callId: 'tc1', result: 'data' });
    emitter.onStep({ type: 'token', text: 'The answer is 42' });
    emitter.onStep({ type: 'final', text: 'The answer is 42' });

    const types = messages.map(m => m.type);
    assert.deepEqual(types, [
      'laia:request',       // request
      'assistant',          // flushed text "Let me check"
      'assistant',          // tool_use
      'user',               // tool_result
      'assistant',          // flushed text "The answer is 42" via final
    ]);

    // Verify tool_use message
    assert.equal(messages[2].message.content[0].name, 'read');
    assert.equal(messages[2].message.stop_reason, 'tool_use');

    // Verify final text has end_turn
    assert.equal(messages[4].message.stop_reason, 'end_turn');
    assert.equal(messages[4].message.content[0].text, 'The answer is 42');
  });
});
