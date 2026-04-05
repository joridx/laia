// tests/unit/talk-client.test.js — Tests for Talk client (Sprint 2a)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── splitMessage tests ──────────────────────────────────────────────────────

describe('splitMessage', () => {
  let splitMessage;

  it('should load module', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    splitMessage = mod.splitMessage;
  });

  it('should return single-element array for short message', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const result = mod.splitMessage('Hello world', 4000);
    assert.equal(result.length, 1);
    assert.equal(result[0], 'Hello world');
  });

  it('should split at paragraph boundary', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const para1 = 'A'.repeat(60);
    const para2 = 'B'.repeat(60);
    const msg = `${para1}\n\n${para2}`;
    const result = mod.splitMessage(msg, 100);
    assert.equal(result.length, 2);
    assert.ok(result[0].includes('(1/2)'));
    assert.ok(result[1].includes('(2/2)'));
  });

  it('should split at newline if no paragraph break', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const line1 = 'A'.repeat(60);
    const line2 = 'B'.repeat(60);
    const msg = `${line1}\n${line2}`;
    const result = mod.splitMessage(msg, 100);
    assert.equal(result.length, 2);
  });

  it('should hard-split if no good break point', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const msg = 'A'.repeat(200);
    const result = mod.splitMessage(msg, 100);
    assert.ok(result.length >= 2);
  });

  it('should handle exact-limit message', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const msg = 'X'.repeat(4000);
    const result = mod.splitMessage(msg, 4000);
    assert.equal(result.length, 1);
    assert.equal(result[0], msg);
  });

  it('should handle empty message', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const result = mod.splitMessage('', 4000);
    assert.equal(result.length, 1);
    assert.equal(result[0], '');
  });
});

// ─── cleanMessageContent tests ──────────────────────────────────────────────

describe('cleanMessageContent', () => {
  it('should replace file placeholders', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const msg = {
      message: 'Check this: {file0}',
      messageParameters: {
        file0: { name: 'report.pdf', type: 'file' }
      }
    };
    const result = mod.cleanMessageContent(msg);
    assert.equal(result, 'Check this: [report.pdf]');
  });

  it('should strip bot mention', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const msg = {
      message: '{mention-user1} do something',
      messageParameters: {
        'mention-user1': { id: 'laia-fuji', name: 'LAIA Fujitsu', type: 'user' }
      }
    };
    const result = mod.cleanMessageContent(msg, 'laia-fuji');
    assert.equal(result, 'do something');
  });

  it('should keep other user mentions', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const msg = {
      message: '{mention-user1} said hello',
      messageParameters: {
        'mention-user1': { id: 'jorid', name: 'Yuri', type: 'user' }
      }
    };
    const result = mod.cleanMessageContent(msg, 'laia-fuji');
    assert.equal(result, '@Yuri said hello');
  });

  it('should handle message with no parameters', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const msg = { message: 'Plain text', messageParameters: {} };
    const result = mod.cleanMessageContent(msg);
    assert.equal(result, 'Plain text');
  });

  it('should handle null messageParameters', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const msg = { message: 'Text', messageParameters: null };
    assert.equal(mod.cleanMessageContent(msg), 'Text');
  });

  it('should handle array messageParameters (Talk edge case)', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const msg = { message: 'Text', messageParameters: [] };
    assert.equal(mod.cleanMessageContent(msg), 'Text');
  });
});

// ─── filterRelevantMessages tests ────────────────────────────────────────────

describe('filterRelevantMessages', () => {
  it('should filter out system messages', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const messages = [
      { actorType: 'users', actorId: 'jorid', message: 'hello' },
      { actorType: 'system', actorId: '', systemMessage: 'user_added' },
      { actorType: 'users', actorId: 'jorid', message: 'world' },
    ];
    const result = mod.filterRelevantMessages(messages, 'laia-fuji');
    assert.equal(result.length, 2);
  });

  it('should filter out bot own messages', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const messages = [
      { actorType: 'users', actorId: 'jorid', message: 'question' },
      { actorType: 'users', actorId: 'laia-fuji', message: 'answer' },
    ];
    const result = mod.filterRelevantMessages(messages, 'laia-fuji');
    assert.equal(result.length, 1);
    assert.equal(result[0].actorId, 'jorid');
  });

  it('should filter system events even from users', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    const messages = [
      { actorType: 'users', actorId: 'jorid', message: 'hi', systemMessage: 'call_started' },
    ];
    const result = mod.filterRelevantMessages(messages, 'laia-fuji');
    assert.equal(result.length, 0);
  });

  it('should handle null/empty input', async () => {
    const mod = await import('../../src/channels/talk-client.js');
    assert.deepEqual(mod.filterRelevantMessages(null, 'bot'), []);
    assert.deepEqual(mod.filterRelevantMessages([], 'bot'), []);
  });
});
