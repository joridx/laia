// tests/unit/unified-view.test.js — V4 Track 1 unified memory tests
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedMemoryContext, getMemoryStats } from '../../src/memory/unified-view.js';

describe('buildUnifiedMemoryContext()', () => {
  it('returns string or null', () => {
    const result = buildUnifiedMemoryContext();
    assert.ok(result === null || typeof result === 'string');
  });

  it('result is within budget if non-null', () => {
    const result = buildUnifiedMemoryContext();
    if (result) {
      assert.ok(result.length <= 8200, `Result too long: ${result.length}`);
    }
  });

  it('does not contain control characters (sanitized)', () => {
    const result = buildUnifiedMemoryContext();
    if (result) {
      // Should not contain null bytes or other dangerous control chars
      assert.ok(!result.includes('\0'), 'Contains null bytes');
      assert.ok(!result.includes('<|'), 'Contains potential tag injection');
    }
  });
});

describe('getMemoryStats()', () => {
  it('returns object with expected shape', () => {
    const stats = getMemoryStats();
    assert.equal(typeof stats, 'object');
    assert.ok('typed' in stats);
    assert.ok('promoted' in stats);
    assert.ok('total' in stats);
    assert.equal(typeof stats.typed, 'number');
    assert.equal(typeof stats.promoted, 'number');
    assert.equal(typeof stats.total, 'number');
  });

  it('total is non-negative', () => {
    const stats = getMemoryStats();
    assert.ok(stats.total >= 0);
  });
});
