// tests/unit/sprint2-integration.test.js — Tests for Sprint 2 core integration
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Confirmation Hook Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('confirmation-hook', () => {
  let mod;

  it('should load module', async () => {
    mod = await import('../../src/hooks/confirmation-hook.js');
  });

  it('should export registerConfirmationHook', () => {
    assert.equal(typeof mod.registerConfirmationHook, 'function');
  });

  it('should export resetConfirmationHook', () => {
    assert.equal(typeof mod.resetConfirmationHook, 'function');
  });

  it('should not throw on register', () => {
    mod.resetConfirmationHook();
    mod.registerConfirmationHook();
  });

  it('should be idempotent (double register)', () => {
    mod.registerConfirmationHook(); // second call, no-op
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Unified View TASKS.md injection
// ═══════════════════════════════════════════════════════════════════════════════

describe('unified-view tasks injection', () => {
  it('should import unified-view without errors', async () => {
    const mod = await import('../../src/memory/unified-view.js');
    assert.equal(typeof mod.buildUnifiedMemoryContext, 'function');
    assert.equal(typeof mod.getMemoryStats, 'function');
  });

  it('should import cron-file exports used by unified-view', async () => {
    const mod = await import('../../src/channels/cron-file.js');
    assert.equal(typeof mod.loadTasksFile, 'function');
    assert.equal(typeof mod.formatTasksForPrompt, 'function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Flags integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('flags integration', () => {
  let flags;

  it('should load flags module', async () => {
    flags = await import('../../src/config/flags.js');
  });

  it('should have confirmation_enabled flag (default false)', () => {
    const all = flags.loadFlags(true);
    assert.equal(all.confirmation_enabled, false);
  });

  it('should have tasks_inject flag (default false)', () => {
    const all = flags.loadFlags(true);
    assert.equal(all.tasks_inject, false);
  });

  it('should have talk_poll_enabled flag (default false)', () => {
    const all = flags.loadFlags(true);
    assert.equal(all.talk_poll_enabled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Slash command metadata
// ═══════════════════════════════════════════════════════════════════════════════

describe('slash-command metadata', () => {
  let meta;

  it('should load command metadata', async () => {
    const mod = await import('../../src/repl/slash-commands.js');
    meta = mod.COMMAND_META;
    assert.ok(meta);
  });

  it('should have /talk command', () => {
    assert.ok(meta['/talk']);
    assert.equal(meta['/talk'].cat, 'nextcloud');
    assert.ok(meta['/talk'].subs.includes('poll'));
    assert.ok(meta['/talk'].subs.includes('send'));
    assert.ok(meta['/talk'].subs.includes('rooms'));
  });

  it('should have /cron command', () => {
    assert.ok(meta['/cron']);
    assert.equal(meta['/cron'].cat, 'nextcloud');
  });

  it('should have /confirm command', () => {
    assert.ok(meta['/confirm']);
    assert.equal(meta['/confirm'].cat, 'nextcloud');
    assert.ok(meta['/confirm'].subs.includes('approve'));
    assert.ok(meta['/confirm'].subs.includes('deny'));
  });

  it('should have /nc-tasks command', () => {
    assert.ok(meta['/nc-tasks']);
    assert.equal(meta['/nc-tasks'].cat, 'nextcloud');
  });

  it('should include nextcloud in BUILTIN_COMMANDS', async () => {
    const mod = await import('../../src/repl/slash-commands.js');
    assert.ok(mod.BUILTIN_COMMANDS.includes('/talk'));
    assert.ok(mod.BUILTIN_COMMANDS.includes('/cron'));
    assert.ok(mod.BUILTIN_COMMANDS.includes('/confirm'));
    assert.ok(mod.BUILTIN_COMMANDS.includes('/nc-tasks'));
  });
});
