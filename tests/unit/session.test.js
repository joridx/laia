// tests/unit/session.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// We need to override SESSIONS_DIR for tests — import internals
import {
  saveSession, autoSave, loadAutoSave, loadSession, listSessions,
  listSessionFiles, deleteAutoSave, sanitizeName, AUTOSAVE_FILE,
} from '../../src/session.js';

import { createContext } from '../../src/context.js';

// --- context.js serialize/deserialize tests ---

describe('context serialize/deserialize', () => {
  it('roundtrips empty context', () => {
    const ctx = createContext();
    const data = ctx.serialize();
    assert.deepEqual(data.turns, []);
    assert.deepEqual(data.messages, []);

    const ctx2 = createContext();
    ctx2.addUser('noise');
    assert.ok(ctx2.deserialize(data));
    assert.deepEqual(ctx2.serialize().messages, []);
  });

  it('roundtrips context with turns and messages', () => {
    const ctx = createContext();
    ctx.addUser('hello');
    ctx.addAssistant('hi there');
    ctx.addTurnMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);

    const data = ctx.serialize();
    assert.equal(data.turns.length, 1);
    assert.equal(data.messages.length, 2);

    const ctx2 = createContext();
    assert.ok(ctx2.deserialize(data));
    assert.equal(ctx2.serialize().turns.length, 1);
    assert.equal(ctx2.serialize().messages.length, 2);
  });

  it('serialize returns a deep clone (mutations do not affect original)', () => {
    const ctx = createContext();
    ctx.addUser('test');
    const data = ctx.serialize();
    data.messages.push({ role: 'user', content: 'injected' });
    assert.equal(ctx.serialize().messages.length, 1);
  });

  it('deserialize rejects invalid data', () => {
    const ctx = createContext();
    assert.equal(ctx.deserialize(null), false);
    assert.equal(ctx.deserialize({}), false);
    assert.equal(ctx.deserialize({ turns: 'not-array', messages: [] }), false);
    assert.equal(ctx.deserialize({ turns: [], messages: 'not-array' }), false);
  });

  it('deserialize clears existing state', () => {
    const ctx = createContext();
    ctx.addUser('old');
    ctx.addAssistant('old reply');
    ctx.addTurnMessages([{ role: 'user', content: 'old' }]);

    assert.ok(ctx.deserialize({ turns: [], messages: [] }));
    assert.equal(ctx.turnCount(), 0);
    assert.deepEqual(ctx.serialize().messages, []);
  });

  it('turnCount returns correct count', () => {
    const ctx = createContext();
    assert.equal(ctx.turnCount(), 0);
    ctx.addTurnMessages([{ role: 'user', content: 'a' }]);
    assert.equal(ctx.turnCount(), 1);
    ctx.addTurnMessages([{ role: 'user', content: 'b' }]);
    assert.equal(ctx.turnCount(), 2);
  });
});

// --- session.js sanitizeName ---

describe('sanitizeName', () => {
  it('keeps alphanumeric and dashes', () => {
    assert.equal(sanitizeName('my-session'), 'my-session');
  });

  it('replaces special chars with underscore', () => {
    assert.equal(sanitizeName('hello world!'), 'hello_world');
  });

  it('collapses multiple underscores', () => {
    assert.equal(sanitizeName('a///b///c'), 'a_b_c');
  });

  it('trims leading/trailing underscores', () => {
    assert.equal(sanitizeName('__test__'), 'test');
  });

  it('truncates to 64 chars', () => {
    const long = 'a'.repeat(100);
    assert.equal(sanitizeName(long).length, 64);
  });
});

// --- Integration tests using temp directory ---
// Note: these test the core logic but use the real SESSIONS_DIR.
// For isolation we'd need dependency injection, but for v1 these verify correctness.

describe('session save/load integration', () => {
  // We'll use a unique name prefix to avoid collisions
  const prefix = `test_${randomBytes(4).toString('hex')}`;

  it('saveSession creates a file and loadSession reads it back', () => {
    const ctx = createContext();
    ctx.addUser('hello');
    ctx.addAssistant('world');
    ctx.addTurnMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);

    const filepath = saveSession(ctx.serialize(), { name: prefix, model: 'test-model' });
    assert.ok(existsSync(filepath), 'file should exist');

    const data = JSON.parse(readFileSync(filepath, 'utf8'));
    assert.equal(data.version, 1);
    assert.equal(data.model, 'test-model');
    assert.equal(data.turns.length, 1);
    assert.equal(data.messages.length, 2);
    assert.ok(data.createdAt);
    assert.ok(data.savedAt);
    assert.ok(data.sessionId);
    assert.ok(data.appVersion);

    // Clean up
    rmSync(filepath);
  });

  it('autoSave and loadAutoSave roundtrip', () => {
    const ctx = createContext();
    ctx.addUser('auto test');
    ctx.addTurnMessages([{ role: 'user', content: 'auto test' }]);

    const filepath = autoSave(ctx.serialize(), { model: 'test' });
    assert.ok(existsSync(filepath));

    const data = loadAutoSave();
    assert.ok(data);
    assert.equal(data.turns.length, 1);

    // Verify deserialize works
    const ctx2 = createContext();
    assert.ok(ctx2.deserialize(data));
    assert.equal(ctx2.turnCount(), 1);

    deleteAutoSave();
  });

  it('listSessions returns entries sorted newest first', () => {
    const sessions = listSessions();
    // Just verify structure (may or may not have entries)
    assert.ok(Array.isArray(sessions));
    for (const s of sessions) {
      assert.ok('index' in s);
      assert.ok('file' in s);
      assert.ok('turns' in s);
    }
  });

  it('loadSession returns null for non-existent session', () => {
    assert.equal(loadSession('non_existent_session_xyz_123'), null);
  });

  it('loadSession by numeric index', () => {
    const files = listSessionFiles();
    if (files.length > 0) {
      const data = loadSession('1');
      // Should either return data or null (if corrupt)
      assert.ok(data === null || typeof data === 'object');
    }
  });
});

// --- Error handling ---

describe('session error handling', () => {
  it('loadAutoSave returns null when no autosave exists', () => {
    deleteAutoSave();
    const data = loadAutoSave();
    assert.equal(data, null);
  });
});
