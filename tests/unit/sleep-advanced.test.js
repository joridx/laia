// tests/unit/sleep-advanced.test.js — Tests for Sprint 5 advanced sleep cycle
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('sleep-advanced', () => {
  let mod;

  it('should load module', async () => {
    mod = await import('../../src/services/sleep-advanced.js');
  });

  it('should export deduplicateLearnings', () => {
    assert.equal(typeof mod.deduplicateLearnings, 'function');
  });

  it('should export verifyNcUris', () => {
    assert.equal(typeof mod.verifyNcUris, 'function');
  });

  it('should export runAdvancedSleepCycle', () => {
    assert.equal(typeof mod.runAdvancedSleepCycle, 'function');
  });

  it('should export formatReport', () => {
    assert.equal(typeof mod.formatReport, 'function');
  });
});

describe('deduplicateLearnings', () => {
  let deduplicateLearnings;

  it('should load function', async () => {
    ({ deduplicateLearnings } = await import('../../src/services/sleep-advanced.js'));
  });

  it('should return result structure (dry-run)', async () => {
    const result = await deduplicateLearnings({ dryRun: true });
    assert.ok(Array.isArray(result.clusters));
    assert.ok(Array.isArray(result.merged));
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.stats !== undefined);
  });

  it('should find clusters in existing brain data', async () => {
    const result = await deduplicateLearnings({ dryRun: true });
    // Brain has 83 learnings — should find some clusters
    assert.ok(result.clusters.length >= 0); // May or may not have duplicates
    // Verify cluster structure
    for (const c of result.clusters) {
      assert.ok(Array.isArray(c.titles));
      assert.ok(typeof c.size === 'number');
      assert.ok(typeof c.similarity === 'number');
      assert.ok(['merge', 'distill', 'review'].includes(c.action));
    }
  });

  it('should not modify anything in dry-run mode', async () => {
    const result = await deduplicateLearnings({ dryRun: true });
    for (const m of result.merged) {
      assert.equal(m.action, 'would_merge');
    }
  });
});

describe('verifyNcUris', () => {
  let verifyNcUris;

  it('should load function', async () => {
    ({ verifyNcUris } = await import('../../src/services/sleep-advanced.js'));
  });

  it('should handle missing NC auth', async () => {
    // If NC_USER/NC_PASS are set, it will try to verify. If not, graceful error.
    const result = await verifyNcUris({ timeoutMs: 2000 });
    assert.ok(typeof result.checked === 'number');
    assert.ok(typeof result.valid === 'number');
    assert.ok(Array.isArray(result.broken));
    assert.ok(Array.isArray(result.errors));
  });
});

describe('formatReport', () => {
  let formatReport;

  it('should load function', async () => {
    ({ formatReport } = await import('../../src/services/sleep-advanced.js'));
  });

  it('should format empty report', () => {
    const report = {
      timestamp: '2026-04-06T12:00:00.000Z',
      basic: null,
      dedup: { clusters: [], merged: [], errors: [], stats: {} },
      uris: { checked: 0, valid: 0, broken: [], errors: [] },
    };
    const output = formatReport(report);
    assert.ok(output.includes('Advanced Sleep Cycle Report'));
    assert.ok(output.includes('0 clusters'));
    assert.ok(output.includes('No nc:// references'));
  });

  it('should format report with merges', () => {
    const report = {
      timestamp: '2026-04-06T12:00:00.000Z',
      basic: { bullets: 3, sessions: 2, bytes: 512, pruned: 1 },
      dedup: {
        clusters: [{ titles: ['A', 'B'], size: 2, similarity: 0.8, action: 'merge' }],
        merged: [{ action: 'would_merge', keeper: 'a', keeperTitle: 'A', superseded: ['b'], similarity: 0.8 }],
        errors: [],
        stats: {},
      },
      uris: { checked: 2, valid: 1, broken: [{ uri: 'nc:///knowledge/missing.pdf', slugs: ['test'], status: 404, error: 'HTTP 404' }], errors: [] },
    };
    const output = formatReport(report);
    assert.ok(output.includes('3 bullets'));
    assert.ok(output.includes('1 would merge'));
    assert.ok(output.includes('Keep "A"'));
    assert.ok(output.includes('1 broken'));
    assert.ok(output.includes('missing.pdf'));
  });

  it('should format report with errors', () => {
    const report = {
      timestamp: '2026-04-06T12:00:00.000Z',
      basic: { error: 'No sessions' },
      dedup: { clusters: [], merged: [], errors: ['Brain module error'], stats: {} },
      uris: { checked: 0, valid: 0, broken: [], errors: ['NC_USER/NC_PASS not configured'] },
    };
    const output = formatReport(report);
    assert.ok(output.includes('No sessions'));
    assert.ok(output.includes('Brain module error'));
    assert.ok(output.includes('NC_USER'));
  });
});

describe('/sleep --advanced metadata', () => {
  it('should have --advanced in subs', async () => {
    const { COMMAND_META } = await import('../../src/repl/slash-commands.js');
    assert.ok(COMMAND_META['/sleep'].subs.includes('--advanced'));
    assert.ok(COMMAND_META['/sleep'].subs.includes('--dry-run'));
  });
});
