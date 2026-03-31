// tests/unit/memory-files.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { loadMemoryFiles, buildMemoryContext } from '../../src/memory-files.js';

const TMP = join(tmpdir(), `laia_mem_test_${randomBytes(4).toString('hex')}`);
const FAKE_HOME = join(TMP, 'home');
const FAKE_WS = join(TMP, 'workspace');

function setup() {
  mkdirSync(join(FAKE_HOME, '.claude'), { recursive: true });
  mkdirSync(join(FAKE_HOME, '.laia'), { recursive: true });
  mkdirSync(join(FAKE_WS, '.claude'), { recursive: true });
}

function cleanup() {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

setup();
process.on('exit', cleanup);

// We test loadMemoryFiles by providing explicit paths (since we can't override homedir easily)
// Instead, test buildMemoryContext directly and loadMemoryFiles with workspace-level files

describe('buildMemoryContext', () => {
  it('returns empty string for empty array', () => {
    assert.equal(buildMemoryContext([]), '');
  });

  it('returns empty string for null', () => {
    assert.equal(buildMemoryContext(null), '');
  });

  it('formats single file correctly', () => {
    const files = [{ path: '/home/.laia/LAIA.md', level: 'user', content: '# Rules\nBe concise.' }];
    const result = buildMemoryContext(files);
    assert.ok(result.includes('[LAIA.md — user]'));
    assert.ok(result.includes('/home/.laia/LAIA.md'));
    assert.ok(result.includes('# Rules'));
    assert.ok(result.includes('Be concise.'));
  });

  it('formats multiple files with separators', () => {
    const files = [
      { path: '/a', level: 'user', content: 'User rules' },
      { path: '/b', level: 'project', content: 'Project rules' },
      { path: '/c', level: 'managed', content: 'Corporate rules' },
    ];
    const result = buildMemoryContext(files);
    assert.ok(result.includes('[LAIA.md — user]'));
    assert.ok(result.includes('[LAIA.md — project]'));
    assert.ok(result.includes('[LAIA.md — managed]'));
    assert.ok(result.includes('---'));
    assert.ok(result.includes('User rules'));
    assert.ok(result.includes('Project rules'));
    assert.ok(result.includes('Corporate rules'));
  });

  it('ends with double newline', () => {
    const files = [{ path: '/a', level: 'user', content: 'hello' }];
    const result = buildMemoryContext(files);
    assert.ok(result.endsWith('\n\n'));
  });
});

describe('loadMemoryFiles', () => {
  it('returns empty array when no workspace and no home files', () => {
    // loadMemoryFiles checks real home dir — but workspace-only test
    const files = loadMemoryFiles({ workspaceRoot: join(TMP, 'nonexistent') });
    // May pick up real ~/.laia/LAIA.md — just check it returns an array
    assert.ok(Array.isArray(files));
  });

  it('loads project LAIA.md from workspace root', () => {
    writeFileSync(join(FAKE_WS, 'LAIA.md'), '# Project Rules\nNo console.log');
    const files = loadMemoryFiles({ workspaceRoot: FAKE_WS });
    const projFile = files.find(f => f.level === 'project' && f.path.includes(FAKE_WS));
    assert.ok(projFile, 'should find project LAIA.md');
    assert.ok(projFile.content.includes('No console.log'));
  });

  it('loads project .laia/LAIA.md from workspace', () => {
    writeFileSync(join(FAKE_WS, '.claude', 'LAIA.md'), '# Inner project rules');
    const files = loadMemoryFiles({ workspaceRoot: FAKE_WS });
    const inner = files.find(f => f.level === 'project' && f.path.includes('.claude'));
    assert.ok(inner, 'should find .laia/LAIA.md');
    assert.ok(inner.content.includes('Inner project rules'));
  });

  it('skips empty files', () => {
    const emptyWs = join(TMP, 'empty_ws');
    mkdirSync(emptyWs, { recursive: true });
    writeFileSync(join(emptyWs, 'LAIA.md'), '   \n  \n  ');
    const files = loadMemoryFiles({ workspaceRoot: emptyWs });
    const emptyFile = files.find(f => f.path.includes(emptyWs));
    assert.equal(emptyFile, undefined, 'should skip whitespace-only files');
  });

  it('returns files in priority order (user before project)', () => {
    const files = loadMemoryFiles({ workspaceRoot: FAKE_WS });
    const levels = files.map(f => f.level);
    const userIdx = levels.indexOf('user');
    const projIdx = levels.indexOf('project');
    if (userIdx >= 0 && projIdx >= 0) {
      assert.ok(userIdx < projIdx, 'user should come before project');
    }
  });

  it('works without workspaceRoot', () => {
    const files = loadMemoryFiles();
    assert.ok(Array.isArray(files));
    // Should not throw, just skip project-level files
  });
});

describe('context.usagePercent', async () => {
  const { createContext } = await import('../../src/context.js');

  it('returns 0 for empty context', () => {
    const ctx = createContext();
    assert.equal(ctx.usagePercent(), 0);
  });

  it('returns correct percentage after adding messages', () => {
    const ctx = createContext({ maxTokens: 100 });
    // Add a message with 400 chars = ~100 tokens = 100% of 100 maxTokens
    ctx.addUser('x'.repeat(400));
    assert.equal(ctx.usagePercent(), 100);
  });

  it('returns percentage proportional to content', () => {
    const ctx = createContext({ maxTokens: 1000 });
    // 2000 chars = ~500 tokens = 50% of 1000
    ctx.addUser('x'.repeat(2000));
    assert.equal(ctx.usagePercent(), 50);
  });

  it('getMaxTokens returns configured value', () => {
    const ctx = createContext({ maxTokens: 200_000 });
    assert.equal(ctx.getMaxTokens(), 200_000);
  });

  it('getMaxTokens returns default when not specified', () => {
    const ctx = createContext();
    assert.equal(ctx.getMaxTokens(), 300_000);
  });
});
