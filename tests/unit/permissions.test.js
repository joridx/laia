import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPermissionContext, checkPermission, setAutoApprove } from '../../src/permissions.js';

describe('createPermissionContext', () => {
  it('auto-allows tier 1 tools by default', async () => {
    const ctx = createPermissionContext();
    assert.equal(await ctx.checkPermission('read', {}), true);
    assert.equal(await ctx.checkPermission('glob', {}), true);
    assert.equal(await ctx.checkPermission('grep', {}), true);
    assert.equal(await ctx.checkPermission('git_diff', {}), true);
    assert.equal(await ctx.checkPermission('git_status', {}), true);
    assert.equal(await ctx.checkPermission('git_log', {}), true);
    assert.equal(await ctx.checkPermission('brain_search', {}), true);
    assert.equal(await ctx.checkPermission('brain_get_context', {}), true);
    assert.equal(await ctx.checkPermission('run_command', {}), true);
  });

  it('autoApprove:true approves all tools', async () => {
    const ctx = createPermissionContext({ autoApprove: true });
    assert.equal(await ctx.checkPermission('bash', { command: 'rm -rf /' }), true);
    assert.equal(await ctx.checkPermission('write', { path: '/etc/passwd' }), true);
    assert.equal(await ctx.checkPermission('edit', {}), true);
    assert.equal(await ctx.checkPermission('unknown_tool', {}), true);
  });

  it('setAutoApprove toggles approval on existing context', async () => {
    const ctx = createPermissionContext();
    ctx.setAutoApprove(true);
    assert.equal(await ctx.checkPermission('bash', { command: 'ls' }), true);
    ctx.setAutoApprove(false);
    // bash is tier 3 — would need askUser, but non-TTY falls back to false
    assert.equal(await ctx.checkPermission('bash', { command: 'ls' }), false);
  });

  it('two instances do not share sessionApproved state', async () => {
    const a = createPermissionContext({ autoApprove: true });
    const b = createPermissionContext();

    // a approves everything, b doesn't
    assert.equal(await a.checkPermission('bash', {}), true);
    // b: bash is tier 3, non-TTY → false
    assert.equal(await b.checkPermission('bash', {}), false);
  });

  it('two instances do not share autoApproveAll state', async () => {
    const a = createPermissionContext();
    const b = createPermissionContext();

    a.setAutoApprove(true);
    assert.equal(await a.checkPermission('bash', {}), true);
    // b should still be non-auto
    assert.equal(await b.checkPermission('bash', {}), false);
  });

  it('tier 2 tools denied in non-TTY without autoApprove', async () => {
    const ctx = createPermissionContext();
    // write is tier 2 — askUser in non-TTY returns false
    assert.equal(await ctx.checkPermission('write', {}), false);
    assert.equal(await ctx.checkPermission('edit', {}), false);
  });
});

describe('default singleton backwards-compat', () => {
  it('checkPermission auto-allows tier 1 tools', async () => {
    assert.equal(await checkPermission('read', {}), true);
    assert.equal(await checkPermission('glob', {}), true);
    assert.equal(await checkPermission('git_status', {}), true);
  });

  it('setAutoApprove affects default singleton', async () => {
    setAutoApprove(true);
    assert.equal(await checkPermission('bash', { command: 'ls' }), true);
    setAutoApprove(false);
    // Restore — bash tier 3, non-TTY → false
    assert.equal(await checkPermission('bash', { command: 'ls' }), false);
  });
});
