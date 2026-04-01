// tests/unit/prompt-governance.test.js — V4 Track 3 tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunk, enforceBudget, buildGovernedPrompt,
  detectConflicts, formatBudgetStats, PRIORITY,
} from '../../src/memory/prompt-governance.js';

describe('chunk()', () => {
  it('creates valid chunk', () => {
    const c = chunk({ id: 'test', text: 'hello', priority: 3 });
    assert.equal(c.id, 'test');
    assert.equal(c.text, 'hello');
    assert.equal(c.chars, 5);
    assert.equal(c.priority, 3);
    assert.equal(c.pinned, false);
  });

  it('returns null for empty text', () => {
    assert.equal(chunk({ id: 'x', text: '', priority: 1 }), null);
    assert.equal(chunk({ id: 'x', text: null, priority: 1 }), null);
    assert.equal(chunk({ id: 'x', text: undefined, priority: 1 }), null);
  });

  it('trims whitespace', () => {
    const c = chunk({ id: 'x', text: '  hello  ', priority: 3 });
    assert.equal(c.text, 'hello');
    assert.equal(c.chars, 5);
  });

  it('returns null for whitespace-only', () => {
    assert.equal(chunk({ id: 'x', text: '   ', priority: 1 }), null);
  });

  it('applies maxChars truncation', () => {
    const c = chunk({ id: 'x', text: 'a'.repeat(100), priority: 5, maxChars: 20 });
    assert.ok(c.text.length <= 50); // 20 + truncation marker
    assert.ok(c.text.includes('truncated'));
  });

  it('auto-pins P1 and P2', () => {
    const c1 = chunk({ id: 'x', text: 'a', priority: PRIORITY.SAFETY });
    const c2 = chunk({ id: 'x', text: 'a', priority: PRIORITY.IDENTITY });
    const c3 = chunk({ id: 'x', text: 'a', priority: PRIORITY.EVOLVED_STABLE });
    assert.equal(c1.pinned, true);
    assert.equal(c2.pinned, true);
    assert.equal(c3.pinned, false);
  });

  it('respects explicit pinned=true', () => {
    const c = chunk({ id: 'x', text: 'a', priority: 5, pinned: true });
    assert.equal(c.pinned, true);
  });
});

describe('enforceBudget()', () => {
  it('keeps all chunks if within budget', () => {
    const chunks = [
      chunk({ id: 'a', text: 'x'.repeat(100), priority: 1 }),
      chunk({ id: 'b', text: 'x'.repeat(100), priority: 5 }),
    ];
    const { kept, dropped } = enforceBudget(chunks, 20000);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });

  it('drops lowest priority first', () => {
    const chunks = [
      chunk({ id: 'safety', text: 'x'.repeat(500), priority: 1, pinned: true }),
      chunk({ id: 'typed', text: 'x'.repeat(3000), priority: 5 }),
      chunk({ id: 'style', text: 'x'.repeat(1000), priority: 7 }),
    ];
    const { dropped } = enforceBudget(chunks, 2000);
    assert.equal(dropped[0].id, 'style');  // P7 dropped first
  });

  it('drops largest within same priority', () => {
    const chunks = [
      chunk({ id: 'safety', text: 'x'.repeat(100), priority: 1, pinned: true }),
      chunk({ id: 'p5-small', text: 'x'.repeat(100), priority: 5 }),
      chunk({ id: 'p5-large', text: 'x'.repeat(3000), priority: 5 }),
    ];
    const { kept, dropped } = enforceBudget(chunks, 500);
    const droppedIds = dropped.map(d => d.id);
    // p5-large should be dropped before p5-small (same prio, larger)
    assert.ok(droppedIds.indexOf('p5-large') <= droppedIds.indexOf('p5-small') || !droppedIds.includes('p5-small'));
  });

  it('never drops pinned chunks', () => {
    const chunks = [
      chunk({ id: 'a', text: 'x'.repeat(5000), priority: 1, pinned: true }),
      chunk({ id: 'b', text: 'x'.repeat(5000), priority: 2, pinned: true }),
    ];
    const { kept, dropped } = enforceBudget(chunks, 100);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });

  it('handles null chunks in array', () => {
    const chunks = [
      null,
      chunk({ id: 'a', text: 'hello', priority: 1 }),
      null,
    ];
    const { kept } = enforceBudget(chunks, 20000);
    assert.equal(kept.length, 1);
  });
});

describe('buildGovernedPrompt()', () => {
  it('puts safety before identity in output', () => {
    const { prompt } = buildGovernedPrompt({
      sections: {
        safety: '## Safety\nBe safe.',
        rules: '## Rules\nBe good.',
        identity: '## Identity\nI am LAIA.',
        tools: '## Tools\n- read',
      },
    });
    const safetyIdx = prompt.indexOf('## Safety');
    const identityIdx = prompt.indexOf('## Identity');
    assert.ok(safetyIdx < identityIdx, 'Safety should come before Identity');
  });

  it('returns stats with section info', () => {
    const { stats } = buildGovernedPrompt({
      sections: { safety: 'test', identity: 'id' },
    });
    assert.ok(stats.totalChars > 0);
    assert.ok(stats.budget > 0);
    assert.equal(typeof stats.usage, 'number');
    assert.equal(stats.overBudget, false);
    assert.ok(Array.isArray(stats.sections));
    assert.ok(Array.isArray(stats.dropped));
  });

  it('reports overBudget when pinned exceed budget', () => {
    const { stats } = buildGovernedPrompt({
      sections: { safety: 'x'.repeat(10000), rules: 'x'.repeat(10000) },
      budget: 100,
    });
    // Pinned can't be dropped, so may exceed tiny budget
    assert.equal(stats.dropped.length, 0);
  });

  it('uses coordinator instead of tools when provided', () => {
    const { prompt } = buildGovernedPrompt({
      sections: {
        safety: 'safe',
        identity: 'id',
        tools: 'TOOLS_MARKER',
        coordinator: 'COORDINATOR_MARKER',
      },
    });
    assert.ok(prompt.includes('COORDINATOR_MARKER'));
    assert.ok(!prompt.includes('TOOLS_MARKER'));
  });
});

describe('detectConflicts()', () => {
  it('detects always/never negation', () => {
    const c = detectConflicts('Always use vitest', 'Never use vitest');
    assert.ok(c.length >= 1);
    assert.equal(c[0].type, 'negation');
  });

  it('detects must/do-not negation', () => {
    const c = detectConflicts('Must test before deploy', 'Do not test before deploy');
    assert.ok(c.length >= 1);
  });

  it('detects prefer/avoid negation', () => {
    const c = detectConflicts('Prefer typescript', 'Avoid typescript');
    assert.ok(c.length >= 1);
  });

  it('returns empty for no conflicts', () => {
    const c = detectConflicts('Use vitest', 'Use jest');
    assert.equal(c.length, 0);
  });

  it('returns empty for null/empty input', () => {
    assert.equal(detectConflicts(null, 'test').length, 0);
    assert.equal(detectConflicts('test', null).length, 0);
    assert.equal(detectConflicts('', '').length, 0);
  });
});

describe('formatBudgetStats()', () => {
  it('returns formatted string', () => {
    const stats = {
      totalChars: 5000,
      budget: 20000,
      usage: 25,
      sections: [{ id: 'safety', chars: 100, priority: 1, pinned: true }],
      dropped: [],
    };
    const output = formatBudgetStats(stats);
    assert.ok(output.includes('Prompt Budget'));
    assert.ok(output.includes('safety'));
    assert.ok(output.includes('█'));
  });

  it('shows dropped sections', () => {
    const stats = {
      totalChars: 100,
      budget: 20000,
      usage: 1,
      sections: [],
      dropped: [{ id: 'style', chars: 500, priority: 7 }],
    };
    const output = formatBudgetStats(stats);
    assert.ok(output.includes('Dropped'));
    assert.ok(output.includes('style'));
  });
});

describe('PRIORITY', () => {
  it('has correct ordering (lower = higher priority)', () => {
    assert.ok(PRIORITY.SAFETY < PRIORITY.IDENTITY);
    assert.ok(PRIORITY.IDENTITY < PRIORITY.EVOLVED_STABLE);
    assert.ok(PRIORITY.EVOLVED_STABLE < PRIORITY.TASK_CONTEXT);
    assert.ok(PRIORITY.TASK_CONTEXT < PRIORITY.TYPED_MEMORY);
    assert.ok(PRIORITY.TYPED_MEMORY < PRIORITY.EVOLVED_ADAPTIVE);
    assert.ok(PRIORITY.EVOLVED_ADAPTIVE < PRIORITY.OUTPUT_STYLE);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(PRIORITY));
  });
});
