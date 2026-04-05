// tests/unit/talk-extractor.test.js — Tests for Talk conversation extraction
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('talk-extractor module', () => {
  let mod;

  it('should load', async () => {
    mod = await import('../../src/services/talk-extractor.js');
  });

  it('should export all public functions', () => {
    assert.equal(typeof mod.filterExtractableMessages, 'function');
    assert.equal(typeof mod.batchMessages, 'function');
    assert.equal(typeof mod.buildExtractionPrompt, 'function');
    assert.equal(typeof mod.parseExtractionResponse, 'function');
    assert.equal(typeof mod.extractFromTalk, 'function');
    assert.equal(typeof mod.formatExtractionReport, 'function');
    assert.equal(typeof mod.loadExtractState, 'function');
    assert.equal(typeof mod.saveExtractState, 'function');
  });
});

describe('filterExtractableMessages', () => {
  let filterExtractableMessages;

  it('should load', async () => {
    ({ filterExtractableMessages } = await import('../../src/services/talk-extractor.js'));
  });

  it('should filter bot messages', () => {
    const msgs = [
      { id: 1, actorId: 'laia-fujitsu', message: 'Hello', actorType: 'users' },
      { id: 2, actorId: 'jorid', message: 'Hi', actorType: 'users' },
    ];
    const result = filterExtractableMessages(msgs, 'laia-fujitsu');
    assert.equal(result.length, 1);
    assert.equal(result[0].author, 'jorid');
  });

  it('should filter system messages', () => {
    const msgs = [
      { id: 1, actorId: 'jorid', message: 'joined', actorType: 'users', systemMessage: 'user_added' },
      { id: 2, actorId: 'jorid', message: 'Hello', actorType: 'users' },
    ];
    const result = filterExtractableMessages(msgs, 'laia');
    assert.equal(result.length, 1);
  });

  it('should filter system actor types', () => {
    const msgs = [
      { id: 1, actorId: 'bridge', message: 'Relayed msg', actorType: 'bridged' },
      { id: 2, actorId: 'jorid', message: 'Hello', actorType: 'users' },
    ];
    const result = filterExtractableMessages(msgs, 'laia');
    assert.equal(result.length, 1);
  });

  it('should filter slash commands', () => {
    const msgs = [
      { id: 1, actorId: 'jorid', message: '/sleep --advanced', actorType: 'users' },
      { id: 2, actorId: 'jorid', message: 'La Pi té 8GB', actorType: 'users' },
    ];
    const result = filterExtractableMessages(msgs, 'laia');
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'La Pi té 8GB');
  });

  it('should filter plain URLs', () => {
    const msgs = [
      { id: 1, actorId: 'jorid', message: 'https://example.com/file.pdf', actorType: 'users' },
      { id: 2, actorId: 'jorid', message: 'Mira this https://example.com link', actorType: 'users' },
    ];
    const result = filterExtractableMessages(msgs, 'laia');
    assert.equal(result.length, 1); // URL-only filtered, URL-within-text kept
  });

  it('should filter emoji-only messages', () => {
    const msgs = [
      { id: 1, actorId: 'jorid', message: '👍', actorType: 'users' },
      { id: 2, actorId: 'jorid', message: '✅❌', actorType: 'users' },
      { id: 3, actorId: 'jorid', message: 'Ok 👍 bon', actorType: 'users' },
    ];
    const result = filterExtractableMessages(msgs, 'laia');
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'Ok 👍 bon');
  });

  it('should filter empty messages', () => {
    const msgs = [
      { id: 1, actorId: 'jorid', message: '', actorType: 'users' },
      { id: 2, actorId: 'jorid', message: '   ', actorType: 'users' },
      { id: 3, actorId: 'jorid', message: 'Real content', actorType: 'users' },
    ];
    const result = filterExtractableMessages(msgs, 'laia');
    assert.equal(result.length, 1);
  });

  it('should map fields correctly', () => {
    const msgs = [{
      id: 42,
      actorId: 'jorid',
      actorDisplayName: 'Jordi',
      message: 'Test message',
      timestamp: 1712400000,
      actorType: 'users',
    }];
    const result = filterExtractableMessages(msgs, 'laia');
    assert.equal(result[0].id, 42);
    assert.equal(result[0].author, 'Jordi');
    assert.equal(result[0].text, 'Test message');
    assert.ok(result[0].timestamp.includes('2024-04-06'));
  });
});

describe('batchMessages', () => {
  let batchMessages;

  it('should load', async () => {
    ({ batchMessages } = await import('../../src/services/talk-extractor.js'));
  });

  it('should return empty for empty input', () => {
    assert.deepEqual(batchMessages([]), []);
  });

  it('should fit small messages in one batch', () => {
    const msgs = [
      { author: 'a', text: 'Hello', timestamp: '', id: 1 },
      { author: 'a', text: 'World', timestamp: '', id: 2 },
    ];
    const batches = batchMessages(msgs, 2000);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
  });

  it('should split large messages into multiple batches', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      author: 'jorid',
      text: 'A'.repeat(200),
      timestamp: '',
      id: i,
    }));
    const batches = batchMessages(msgs, 500);
    assert.ok(batches.length > 1);
    // All messages accounted for
    const total = batches.reduce((sum, b) => sum + b.length, 0);
    assert.equal(total, 20);
  });

  it('should never return empty batches', () => {
    const msgs = [{ author: 'a', text: 'x', timestamp: '', id: 1 }];
    const batches = batchMessages(msgs, 10);
    assert.ok(batches.every(b => b.length > 0));
  });
});

describe('buildExtractionPrompt', () => {
  let buildExtractionPrompt;

  it('should load', async () => {
    ({ buildExtractionPrompt } = await import('../../src/services/talk-extractor.js'));
  });

  it('should include conversation text', () => {
    const batch = [
      { author: 'Jordi', text: 'La Pi té 8GB RAM', timestamp: '2026-04-06T10:00:00Z', id: 1 },
    ];
    const prompt = buildExtractionPrompt(batch);
    assert.ok(prompt.includes('Jordi: La Pi té 8GB RAM'));
    assert.ok(prompt.includes('knowledge extractor'));
    assert.ok(prompt.includes('JSON array'));
  });

  it('should include all messages', () => {
    const batch = [
      { author: 'A', text: 'msg1', timestamp: 't1', id: 1 },
      { author: 'B', text: 'msg2', timestamp: 't2', id: 2 },
    ];
    const prompt = buildExtractionPrompt(batch);
    assert.ok(prompt.includes('msg1'));
    assert.ok(prompt.includes('msg2'));
  });
});

describe('parseExtractionResponse', () => {
  let parseExtractionResponse;

  it('should load', async () => {
    ({ parseExtractionResponse } = await import('../../src/services/talk-extractor.js'));
  });

  it('should parse valid JSON array', () => {
    const raw = JSON.stringify([
      { type: 'learning', title: 'Pi has 8GB', description: 'Raspberry Pi 4 has 8GB RAM', tags: ['hardware'] },
    ]);
    const { learnings, parseError } = parseExtractionResponse(raw);
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0].type, 'learning');
    assert.equal(learnings[0].title, 'Pi has 8GB');
    assert.equal(parseError, null);
  });

  it('should handle markdown code fences', () => {
    const raw = '```json\n[{"type":"learning","title":"Test","description":"Desc","tags":[]}]\n```';
    const { learnings } = parseExtractionResponse(raw);
    assert.equal(learnings.length, 1);
  });

  it('should return empty for empty response', () => {
    assert.deepEqual(parseExtractionResponse('').learnings, []);
    assert.deepEqual(parseExtractionResponse(null).learnings, []);
    assert.deepEqual(parseExtractionResponse('  ').learnings, []);
  });

  it('should return empty for empty array', () => {
    assert.deepEqual(parseExtractionResponse('[]').learnings, []);
  });

  it('should return parseError for invalid JSON', () => {
    const { learnings, parseError } = parseExtractionResponse('not json');
    assert.deepEqual(learnings, []);
    assert.ok(parseError);
    assert.ok(parseError.includes('JSON parse failed'));
  });

  it('should return empty for non-array JSON', () => {
    assert.deepEqual(parseExtractionResponse('{"key":"val"}').learnings, []);
  });

  it('should filter invalid entries', () => {
    const raw = JSON.stringify([
      { type: 'learning', title: 'Valid', description: 'Good', tags: [] },
      { type: 'invalid_type', title: 'Bad type', description: 'X', tags: [] },
      { type: 'learning', title: '', description: 'Empty title', tags: [] },
      { type: 'learning', title: 'No desc', description: '', tags: [] },
      null,
      42,
    ]);
    const { learnings } = parseExtractionResponse(raw);
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0].title, 'Valid');
  });

  it('should truncate long titles to 120 chars', () => {
    const raw = JSON.stringify([
      { type: 'learning', title: 'A'.repeat(200), description: 'Desc', tags: [] },
    ]);
    const { learnings } = parseExtractionResponse(raw);
    assert.ok(learnings[0].title.length <= 120);
  });

  it('should truncate long descriptions to 500 chars', () => {
    const raw = JSON.stringify([
      { type: 'learning', title: 'Title', description: 'D'.repeat(600), tags: [] },
    ]);
    const { learnings } = parseExtractionResponse(raw);
    assert.ok(learnings[0].description.length <= 500);
  });

  it('should normalize tags', () => {
    const raw = JSON.stringify([
      { type: 'learning', title: 'T', description: 'D', tags: ['HardWare', '  Pi ', 123, null] },
    ]);
    const { learnings } = parseExtractionResponse(raw);
    assert.deepEqual(learnings[0].tags, ['hardware', 'pi']);
  });

  it('should limit tags to 5', () => {
    const raw = JSON.stringify([
      { type: 'learning', title: 'T', description: 'D', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    ]);
    const { learnings } = parseExtractionResponse(raw);
    assert.ok(learnings[0].tags.length <= 5);
  });

  it('should accept preference and warning types', () => {
    const raw = JSON.stringify([
      { type: 'preference', title: 'Catalan', description: 'Prefers Catalan', tags: [] },
      { type: 'warning', title: 'SSL issues', description: 'Corporate proxy blocks', tags: [] },
    ]);
    const { learnings } = parseExtractionResponse(raw);
    assert.equal(learnings.length, 2);
    assert.equal(learnings[0].type, 'preference');
    assert.equal(learnings[1].type, 'warning');
  });
});

describe('formatExtractionReport', () => {
  let formatExtractionReport;

  it('should load', async () => {
    ({ formatExtractionReport } = await import('../../src/services/talk-extractor.js'));
  });

  it('should format empty report', () => {
    const report = {
      rooms: 2,
      messagesProcessed: 0,
      batchesSent: 0,
      learningsExtracted: [],
      learningsSaved: 0,
      errors: [],
      dryRun: true,
    };
    const output = formatExtractionReport(report);
    assert.ok(output.includes('dry-run'));
    assert.ok(output.includes('Rooms scanned: 2'));
    assert.ok(output.includes('nothing new'));
  });

  it('should format report with learnings', () => {
    const report = {
      rooms: 1,
      messagesProcessed: 15,
      batchesSent: 2,
      learningsExtracted: [
        { type: 'learning', title: 'Pi specs', tags: [] },
        { type: 'warning', title: 'SSL block', tags: [] },
      ],
      learningsSaved: 0,
      errors: [],
      dryRun: true,
    };
    const output = formatExtractionReport(report);
    assert.ok(output.includes('Messages processed: 15'));
    assert.ok(output.includes('Learnings found: 2'));
    assert.ok(output.includes('Pi specs'));
    assert.ok(output.includes('SSL block'));
  });

  it('should show saved count when not dry-run', () => {
    const report = {
      rooms: 1,
      messagesProcessed: 5,
      batchesSent: 1,
      learningsExtracted: [{ type: 'learning', title: 'T', tags: [] }],
      learningsSaved: 1,
      errors: [],
      dryRun: false,
    };
    const output = formatExtractionReport(report);
    assert.ok(output.includes('Saved to brain: 1'));
  });

  it('should show errors', () => {
    const report = {
      rooms: 1,
      messagesProcessed: 0,
      batchesSent: 0,
      learningsExtracted: [],
      learningsSaved: 0,
      errors: ['Connection refused'],
      dryRun: true,
    };
    const output = formatExtractionReport(report);
    assert.ok(output.includes('Errors: 1'));
    assert.ok(output.includes('Connection refused'));
  });
});

describe('loadExtractState', () => {
  let loadExtractState;

  it('should load', async () => {
    ({ loadExtractState } = await import('../../src/services/talk-extractor.js'));
  });

  it('should return empty rooms on first call', () => {
    const state = loadExtractState();
    assert.ok(state.rooms);
    assert.equal(typeof state.rooms, 'object');
  });
});
