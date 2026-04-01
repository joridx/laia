import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Extract pure functions for testing ──────────────────────────────────────
// bridge.js doesn't export its pure helpers, so we replicate them here
// to test the scoring and frontmatter logic in isolation.

const PROMOTION_THRESHOLD = 1.0;

function promotionScore(frontmatter) {
  let score = 0;

  const confirms = parseInt(frontmatter.confirmations || '0', 10);
  if (isNaN(confirms)) return 0;
  score += confirms * 0.5;

  const applied = parseInt(frontmatter.times_applied || '0', 10);
  if (!isNaN(applied) && applied > 1) score += 0.3;

  if (frontmatter.created) {
    const ageDays = (Date.now() - new Date(frontmatter.created).getTime()) / (1000 * 60 * 60 * 24);
    if (!isNaN(ageDays) && ageDays > 3) score += 0.2;
  }

  return score;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw.trim() };

  const fm = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }

  return { frontmatter: fm, content: match[2].trim() };
}

function updateFrontmatter(raw, updates) {
  const { frontmatter, content } = parseFrontmatter(raw);
  Object.assign(frontmatter, updates);

  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined && v !== null) lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n\n${content}\n`;
}

// ─── PROMOTION_THRESHOLD ─────────────────────────────────────────────────────

describe('PROMOTION_THRESHOLD constant', () => {
  it('should equal 1.0', () => {
    assert.equal(PROMOTION_THRESHOLD, 1.0);
  });
});

// ─── promotionScore (scoreFeedback) ──────────────────────────────────────────

describe('promotionScore / scoreFeedback logic', () => {
  it('returns 0 for empty frontmatter', () => {
    assert.equal(promotionScore({}), 0);
  });

  it('returns 0 when confirmations is 0', () => {
    assert.equal(promotionScore({ confirmations: '0' }), 0);
  });

  // Explicit confirm: +0.5 per confirmation
  it('adds +0.5 per explicit confirmation', () => {
    assert.equal(promotionScore({ confirmations: '1' }), 0.5);
    assert.equal(promotionScore({ confirmations: '2' }), 1.0);
    assert.equal(promotionScore({ confirmations: '3' }), 1.5);
  });

  // Repeated success: +0.3 if applied > 1
  it('adds +0.3 for repeated success (times_applied > 1)', () => {
    assert.equal(promotionScore({ confirmations: '0', times_applied: '2' }), 0.3);
    assert.equal(promotionScore({ confirmations: '0', times_applied: '5' }), 0.3);
  });

  it('does not add repeated success bonus when times_applied = 1', () => {
    assert.equal(promotionScore({ confirmations: '0', times_applied: '1' }), 0);
  });

  it('does not add repeated success bonus when times_applied = 0', () => {
    assert.equal(promotionScore({ confirmations: '0', times_applied: '0' }), 0);
  });

  // No contradiction / age bonus: +0.2 if older than 3 days
  it('adds +0.2 age bonus when created > 3 days ago (no contradiction)', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(promotionScore({ confirmations: '0', created: fiveDaysAgo }), 0.2);
  });

  it('does not add age bonus when created < 3 days ago', () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(promotionScore({ confirmations: '0', created: oneDayAgo }), 0);
  });

  it('does not add age bonus when created is missing', () => {
    assert.equal(promotionScore({ confirmations: '1' }), 0.5);
  });

  // Combined scoring
  it('combines all scoring components', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const score = promotionScore({
      confirmations: '2',
      times_applied: '3',
      created: tenDaysAgo,
    });
    // 2*0.5 + 0.3 + 0.2 = 1.5
    assert.equal(score, 1.5);
  });

  it('score meets PROMOTION_THRESHOLD with 2 confirmations', () => {
    const score = promotionScore({ confirmations: '2' });
    assert.ok(score >= PROMOTION_THRESHOLD, `Expected ${score} >= ${PROMOTION_THRESHOLD}`);
  });

  it('score below PROMOTION_THRESHOLD with 1 confirmation only', () => {
    const score = promotionScore({ confirmations: '1' });
    assert.ok(score < PROMOTION_THRESHOLD, `Expected ${score} < ${PROMOTION_THRESHOLD}`);
  });

  // Edge cases
  it('handles NaN confirmations gracefully', () => {
    assert.equal(promotionScore({ confirmations: 'abc' }), 0);
  });

  it('handles NaN times_applied gracefully', () => {
    const score = promotionScore({ confirmations: '1', times_applied: 'xyz' });
    assert.equal(score, 0.5); // only confirmation counted
  });

  it('handles invalid date in created gracefully', () => {
    const score = promotionScore({ confirmations: '1', created: 'not-a-date' });
    assert.equal(score, 0.5); // only confirmation counted, ageDays is NaN
  });
});

// ─── parseFrontmatter ────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const raw = '---\nname: test\ntype: feedback\n---\nSome content here';
    const { frontmatter, content } = parseFrontmatter(raw);
    assert.equal(frontmatter.name, 'test');
    assert.equal(frontmatter.type, 'feedback');
    assert.equal(content, 'Some content here');
  });

  it('strips quotes from values', () => {
    const raw = '---\nname: "quoted"\nother: \'single\'\n---\nbody';
    const { frontmatter } = parseFrontmatter(raw);
    assert.equal(frontmatter.name, 'quoted');
    assert.equal(frontmatter.other, 'single');
  });

  it('returns raw content when no frontmatter delimiters', () => {
    const raw = 'No frontmatter here';
    const { frontmatter, content } = parseFrontmatter(raw);
    assert.deepEqual(frontmatter, {});
    assert.equal(content, 'No frontmatter here');
  });

  it('handles values with colons', () => {
    const raw = '---\nurl: https://example.com\n---\nbody';
    const { frontmatter } = parseFrontmatter(raw);
    assert.equal(frontmatter.url, 'https://example.com');
  });
});

// ─── updateFrontmatter ──────────────────────────────────────────────────────

describe('updateFrontmatter', () => {
  it('adds new fields to frontmatter', () => {
    const raw = '---\nname: test\n---\nbody';
    const updated = updateFrontmatter(raw, { status: 'promoted' });
    const { frontmatter } = parseFrontmatter(updated);
    assert.equal(frontmatter.name, 'test');
    assert.equal(frontmatter.status, 'promoted');
  });

  it('overwrites existing fields', () => {
    const raw = '---\nname: old\n---\nbody';
    const updated = updateFrontmatter(raw, { name: 'new' });
    const { frontmatter } = parseFrontmatter(updated);
    assert.equal(frontmatter.name, 'new');
  });

  it('removes fields set to undefined', () => {
    const raw = '---\nname: test\nstate: pending\n---\nbody';
    const updated = updateFrontmatter(raw, { state: undefined });
    const { frontmatter } = parseFrontmatter(updated);
    assert.equal(frontmatter.name, 'test');
    assert.equal(frontmatter.state, undefined);
  });

  it('preserves content body', () => {
    const raw = '---\nname: test\n---\nMulti\nline\nbody';
    const updated = updateFrontmatter(raw, { status: 'ok' });
    const { content } = parseFrontmatter(updated);
    assert.equal(content, 'Multi\nline\nbody');
  });
});

// ─── promoteFeedback flow (mocked I/O) ──────────────────────────────────────

describe('promoteFeedback flow (mocked)', async () => {
  // We import the real function but mock the fs and ownership modules
  // Since promoteFeedback relies heavily on fs, we test the logic flow
  // by verifying the brainRemember call contract and result shape.

  it('returns empty result when brainRemember is not provided', async () => {
    const { promoteFeedback } = await import('../../src/memory/bridge.js');
    const result = await promoteFeedback({});
    // Graceful skip — no error, no promotions
    assert.deepEqual(result.promoted, []);
    assert.deepEqual(result.skipped, []);
  });

  it('result shape has promoted, skipped, errors arrays', async () => {
    const { promoteFeedback } = await import('../../src/memory/bridge.js');
    const result = await promoteFeedback({ brainRemember: async () => ({}) });
    assert.ok(Array.isArray(result.promoted));
    assert.ok(Array.isArray(result.skipped));
    assert.ok(Array.isArray(result.errors));
  });
});
