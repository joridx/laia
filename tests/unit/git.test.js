// tests/unit/git.test.js
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getToolSchemas, executeTool } from '../../src/tools/index.js';
import { registerGitTools } from '../../src/tools/git.js';

function createTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'laia-git-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

let repoDir;

describe('git_diff', () => {
  beforeEach(() => {
    repoDir = createTempRepo();
    registerGitTools({ workspaceRoot: repoDir });
  });

  it('returns empty when no changes', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_diff', {});
    assert.equal(result.empty, true);
  });

  it('shows unstaged changes', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'hello world');
    const result = await executeTool('git_diff', {});
    assert.ok(result.diff.includes('-hello'));
    assert.ok(result.diff.includes('+hello world'));
    assert.ok(result.stat);
  });

  it('shows staged changes with staged=true', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'changed');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_diff', { staged: true });
    assert.ok(result.diff.includes('+changed'));
  });

  it('shows stat-only with stat=true', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'changed');
    const result = await executeTool('git_diff', { stat: true });
    assert.ok(result.diff.includes('a.txt'));
  });

  it('filters by path', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'aaa');
    writeFileSync(join(repoDir, 'b.txt'), 'bbb');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'aaa changed');
    writeFileSync(join(repoDir, 'b.txt'), 'bbb changed');
    const result = await executeTool('git_diff', { path: 'a.txt' });
    assert.ok(result.diff.includes('a.txt'));
    assert.ok(!result.diff.includes('b.txt'));
  });

  it('compares against ref', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'v1');
    execSync('git add . && git commit -m "v1"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'v2');
    execSync('git add . && git commit -m "v2"', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_diff', { ref: 'HEAD~1' });
    assert.ok(result.diff.includes('-v1'));
    assert.ok(result.diff.includes('+v2'));
  });
});

describe('git_status', () => {
  beforeEach(() => {
    repoDir = createTempRepo();
    registerGitTools({ workspaceRoot: repoDir });
  });

  it('returns branch and empty files for clean repo', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_status', {});
    assert.ok(result.branch);
    assert.deepEqual(result.files, []);
    assert.equal(result.ahead, 0);
    assert.equal(result.behind, 0);
  });

  it('detects untracked files', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'new.txt'), 'new');
    const result = await executeTool('git_status', {});
    assert.ok(result.files.some(f => f.status === '??' && f.path === 'new.txt'));
    assert.ok(result.summary.includes('1 untracked'));
  });

  it('detects staged files', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'changed');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_status', {});
    assert.ok(result.files.some(f => f.path === 'a.txt'));
    assert.ok(result.summary.includes('staged'));
  });

  it('returns error for non-git dir', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'laia-nogit-'));
    registerGitTools({ workspaceRoot: nonGitDir });
    const result = await executeTool('git_status', {});
    assert.ok(result.error);
    assert.ok(result.message);
  });
});

describe('git_log', () => {
  beforeEach(() => {
    repoDir = createTempRepo();
    registerGitTools({ workspaceRoot: repoDir });
  });

  it('returns commits', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'v1');
    execSync('git add . && git commit -m "first commit"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'v2');
    execSync('git add . && git commit -m "second commit"', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_log', {});
    assert.ok(result.log.includes('first commit'));
    assert.ok(result.log.includes('second commit'));
  });

  it('limits count', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'v1');
    execSync('git add . && git commit -m "first"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'v2');
    execSync('git add . && git commit -m "second"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'a.txt'), 'v3');
    execSync('git add . && git commit -m "third"', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_log', { count: 2 });
    assert.ok(result.log.includes('third'));
    assert.ok(result.log.includes('second'));
    assert.ok(!result.log.includes('first'));
  });

  it('filters by path', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    execSync('git add . && git commit -m "add a"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'b.txt'), 'b');
    execSync('git add . && git commit -m "add b"', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_log', { path: 'a.txt' });
    assert.ok(result.log.includes('add a'));
    assert.ok(!result.log.includes('add b'));
  });

  it('returns empty for no commits matching path', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    execSync('git add . && git commit -m "add a"', { cwd: repoDir, stdio: 'ignore' });
    const result = await executeTool('git_log', { path: 'nonexistent.txt' });
    assert.equal(result.empty, true);
  });

  it('clamps count to 1-100', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    execSync('git add . && git commit -m "commit"', { cwd: repoDir, stdio: 'ignore' });
    const r1 = await executeTool('git_log', { count: 0 });
    assert.ok(r1.log);
    const r2 = await executeTool('git_log', { count: 999 });
    assert.ok(r2.log);
  });
});

describe('git tools registration', () => {
  it('registers git_diff, git_status, git_log', () => {
    const names = getToolSchemas().map(s => s.name);
    assert.ok(names.includes('git_diff'));
    assert.ok(names.includes('git_status'));
    assert.ok(names.includes('git_log'));
  });
});
