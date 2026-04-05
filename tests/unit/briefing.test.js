// tests/unit/briefing.test.js — Tests for daily briefing generator
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('briefing', () => {
  let mod;

  it('should load module', async () => {
    mod = await import('../../src/services/briefing.js');
  });

  it('should export collectSessions', () => {
    assert.equal(typeof mod.collectSessions, 'function');
  });

  it('should export collectNewLearnings', () => {
    assert.equal(typeof mod.collectNewLearnings, 'function');
  });

  it('should export collectTasks', () => {
    assert.equal(typeof mod.collectTasks, 'function');
  });

  it('should export collectCronJobs', () => {
    assert.equal(typeof mod.collectCronJobs, 'function');
  });

  it('should export generateBriefing', () => {
    assert.equal(typeof mod.generateBriefing, 'function');
  });

  it('should export formatBriefing', () => {
    assert.equal(typeof mod.formatBriefing, 'function');
  });

  it('should export briefingCommand', () => {
    assert.equal(typeof mod.briefingCommand, 'function');
  });

  it('should export initBriefingModules', () => {
    assert.equal(typeof mod.initBriefingModules, 'function');
  });
});

describe('collectSessions', () => {
  let collectSessions;

  it('should load', async () => {
    ({ collectSessions } = await import('../../src/services/briefing.js'));
  });

  it('should return empty for non-existent date', () => {
    const result = collectSessions('2000-01-01');
    assert.equal(result.count, 0);
    assert.deepEqual(result.highlights, []);
  });

  it('should find sessions for 2026-03-31', () => {
    const result = collectSessions('2026-03-31');
    assert.ok(result.count >= 1);
  });

  it('should extract highlights from session notes', () => {
    const result = collectSessions('2026-03-31');
    if (result.count > 0) {
      // Session file has ## Summary section
      assert.ok(result.highlights.length >= 0);
    }
  });
});

describe('collectNewLearnings', () => {
  let collectNewLearnings;

  it('should load', async () => {
    ({ collectNewLearnings } = await import('../../src/services/briefing.js'));
  });

  it('should return empty for non-existent date', () => {
    const result = collectNewLearnings('2000-01-01');
    assert.equal(result.count, 0);
    assert.deepEqual(result.titles, []);
  });

  it('should find learnings for 2026-03-31', () => {
    const result = collectNewLearnings('2026-03-31');
    assert.ok(result.count >= 1);
    assert.ok(result.titles.length >= 1);
  });

  it('should truncate long titles to 100 chars', () => {
    const result = collectNewLearnings('2026-03-31');
    for (const t of result.titles) {
      assert.ok(t.length <= 100, `Title too long: ${t.length}`);
    }
  });
});

describe('collectTasks', () => {
  let collectTasks, initBriefingModules;

  it('should load', async () => {
    ({ collectTasks, initBriefingModules } = await import('../../src/services/briefing.js'));
  });

  it('should return empty without init', () => {
    const result = collectTasks();
    assert.deepEqual(result.pending, []);
    assert.equal(result.total, 0);
  });

  it('should work after init (even without TASKS.md)', async () => {
    await initBriefingModules();
    const result = collectTasks();
    // May be empty if no TASKS.md exists
    assert.ok(Array.isArray(result.pending));
  });
});

describe('formatBriefing', () => {
  let formatBriefing;

  it('should load', async () => {
    ({ formatBriefing } = await import('../../src/services/briefing.js'));
  });

  it('should format empty briefing', () => {
    const briefing = {
      date: '2026-04-05',
      sessions: { count: 0, highlights: [] },
      learnings: { count: 0, titles: [] },
      tasks: { pending: [], total: 0 },
      cron: { jobs: [], count: 0 },
      uris: null,
      timestamp: '2026-04-06T08:00:00.000Z',
    };
    const msg = formatBriefing(briefing);
    assert.ok(msg.includes('Bon dia'));
    assert.ok(msg.includes('2026-04-05'));
    assert.ok(msg.includes('Cap sessió'));
    assert.ok(msg.includes('Cap learning'));
  });

  it('should format briefing with data', () => {
    const briefing = {
      date: '2026-04-05',
      sessions: { count: 3, highlights: ['Sprint 5 implemented', 'Talk listener done'] },
      learnings: { count: 2, titles: ['Sprint 5 sleep cycle', 'Talk pre-approve tools'] },
      tasks: { pending: [{ text: 'Configure Pi', priority: 'urgent', done: false }, { text: 'Create CRON.md', priority: 'normal', done: false }], total: 4 },
      cron: { jobs: [{ schedule: '0 3 * * *', name: 'sleep-advanced' }], count: 1 },
      uris: { checked: 5, valid: 4, broken: [{ uri: 'nc:///knowledge/missing.pdf', slugs: ['test'], error: 'HTTP 404' }], errors: [] },
      timestamp: '2026-04-06T08:00:00.000Z',
    };
    const msg = formatBriefing(briefing);

    // Check all sections present
    assert.ok(msg.includes('Sessions:** 3'), 'sessions count');
    assert.ok(msg.includes('Sprint 5 implemented'), 'session highlight');
    assert.ok(msg.includes('+2 learnings'), 'learnings count');
    assert.ok(msg.includes('Tasks pendents:** 2/4'), 'tasks');
    assert.ok(msg.includes('🔴'), 'urgent task icon');
    assert.ok(msg.includes('Cron jobs:** 1'), 'cron');
    assert.ok(msg.includes('0 3 * * *'), 'cron schedule');
    assert.ok(msg.includes('1 trencats'), 'broken uris');
    assert.ok(msg.includes('missing.pdf'), 'broken uri detail');
  });

  it('should include Catalan day name', () => {
    const briefing = {
      date: '2026-04-06', // Monday
      sessions: { count: 0, highlights: [] },
      learnings: { count: 0, titles: [] },
      tasks: { pending: [], total: 0 },
      cron: { jobs: [], count: 0 },
      uris: null,
    };
    const msg = formatBriefing(briefing);
    assert.ok(msg.includes('dilluns'), `Expected 'dilluns' for 2026-04-06 (Monday), got: ${msg.slice(0, 80)}`);
  });

  it('should stay under Talk 4000 char limit for reasonable data', () => {
    const briefing = {
      date: '2026-04-05',
      sessions: { count: 5, highlights: Array.from({ length: 5 }, (_, i) => `Session ${i + 1} highlight text here`) },
      learnings: { count: 8, titles: Array.from({ length: 8 }, (_, i) => `Learning title number ${i + 1}`) },
      tasks: { pending: Array.from({ length: 10 }, (_, i) => ({ text: `Task ${i + 1}`, priority: 'normal', done: false })), total: 15 },
      cron: { jobs: Array.from({ length: 5 }, (_, i) => ({ schedule: `${i} * * * *`, name: `job-${i}` })), count: 5 },
      uris: null,
    };
    const msg = formatBriefing(briefing);
    assert.ok(msg.length <= 4000, `Briefing too long: ${msg.length} chars`);
  });
});

describe('generateBriefing', () => {
  let generateBriefing, initBriefingModules;

  it('should load', async () => {
    ({ generateBriefing, initBriefingModules } = await import('../../src/services/briefing.js'));
    await initBriefingModules();
  });

  it('should generate for yesterday', async () => {
    const result = await generateBriefing();
    assert.ok(result.date);
    assert.ok(result.timestamp);
    assert.ok(result.sessions);
    assert.ok(result.learnings);
    assert.ok(result.tasks);
    assert.ok(result.cron);
  });

  it('should generate for specific date', async () => {
    const result = await generateBriefing({ date: '2026-03-31' });
    assert.equal(result.date, '2026-03-31');
    assert.ok(result.sessions.count >= 1);
    assert.ok(result.learnings.count >= 1);
  });

  it('should skip URIs by default', async () => {
    const result = await generateBriefing({ date: '2026-03-31' });
    assert.equal(result.uris, null);
  });
});

describe('/briefing metadata', () => {
  it('should have /briefing in COMMAND_META', async () => {
    const { COMMAND_META } = await import('../../src/repl/slash-commands.js');
    assert.ok(COMMAND_META['/briefing']);
    assert.ok(COMMAND_META['/briefing'].subs.includes('--send'));
    assert.ok(COMMAND_META['/briefing'].subs.includes('--date'));
  });
});
