// tests/unit/talk-listener.test.js — Tests for Talk listener
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('talk-listener', () => {
  let mod;

  it('should load module', async () => {
    mod = await import('../../src/channels/talk-listener.js');
  });

  it('should export isListening', () => {
    assert.equal(typeof mod.isListening, 'function');
  });

  it('should export startListener', () => {
    assert.equal(typeof mod.startListener, 'function');
  });

  it('should export stopListener', () => {
    assert.equal(typeof mod.stopListener, 'function');
  });

  it('should export getListenerStats', () => {
    assert.equal(typeof mod.getListenerStats, 'function');
  });

  it('should export splitMessage', () => {
    assert.equal(typeof mod.splitMessage, 'function');
  });

  it('should not be listening initially', () => {
    assert.equal(mod.isListening(), false);
  });

  it('should return inactive stats when not listening', () => {
    const stats = mod.getListenerStats();
    assert.equal(stats.active, false);
    assert.equal(stats.started, null);
    assert.equal(stats.messagesReceived, 0);
    assert.equal(stats.uptimeMs, 0);
  });

  it('should return error when stopping without listener', () => {
    const result = mod.stopListener();
    assert.equal(result.success, false);
  });

  describe('splitMessage', () => {
    it('should return single chunk for short messages', () => {
      const result = mod.splitMessage('Hello world', 100);
      assert.equal(result.length, 1);
      assert.equal(result[0], 'Hello world');
    });

    it('should split long messages', () => {
      const long = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100);
      const result = mod.splitMessage(long, 120);
      assert.ok(result.length >= 2);
    });

    it('should prefer paragraph boundaries', () => {
      const text = 'First paragraph here.\n\nSecond paragraph here.';
      const result = mod.splitMessage(text, 30);
      assert.ok(result.length >= 2);
      assert.ok(result[0].includes('First'));
    });

    it('should add continuation markers', () => {
      const text = 'A'.repeat(200) + '\n\n' + 'B'.repeat(200);
      const result = mod.splitMessage(text, 250);
      if (result.length > 1) {
        assert.ok(result[0].includes('(1/'));
      }
    });

    it('should handle text with no good split points', () => {
      const text = 'A'.repeat(500);
      const result = mod.splitMessage(text, 100);
      assert.ok(result.length >= 5);
      // All chunks should be <= maxLen + marker length
      for (const chunk of result) {
        assert.ok(chunk.length <= 130); // maxLen + marker
      }
    });

    it('should not split messages within limit', () => {
      const text = 'Short message';
      const result = mod.splitMessage(text, 3800);
      assert.equal(result.length, 1);
    });

    it('should split at space when no newlines', () => {
      const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
      const result = mod.splitMessage(words, 100);
      assert.ok(result.length > 1);
      // First chunk should end at a word boundary
      assert.ok(!result[0].endsWith('word'));
    });
  });
});

describe('slash-commands /talk listen|stop|status metadata', () => {
  it('should have listen, stop, status in subs', async () => {
    const { COMMAND_META } = await import('../../src/repl/slash-commands.js');
    const subs = COMMAND_META['/talk'].subs;
    assert.ok(subs.includes('listen'));
    assert.ok(subs.includes('stop'));
    assert.ok(subs.includes('status'));
  });
});
