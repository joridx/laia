// Tests for git-commit.js — auto-commit after agent turns
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAutoCommitter, makeCommitMessage, isGitRepo } from '../src/git-commit.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function makeTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'laia-git-test-'));
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  // Initial commit so HEAD exists
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

describe('makeCommitMessage', () => {
  it('uses first meaningful line from agent text', () => {
    const msg = makeCommitMessage('## Fix the parser bug\nMore details here', ['src/parser.js']);
    assert.equal(msg, 'laia: Fix the parser bug');
  });

  it('truncates long lines', () => {
    const long = 'A'.repeat(200);
    const msg = makeCommitMessage(long, ['file.js']);
    assert.ok(msg.length <= 130); // COMMIT_PREFIX + MAX_MSG_LEN
    assert.ok(msg.endsWith('...'));
  });

  it('falls back to file list when no agent text', () => {
    const msg = makeCommitMessage('', ['src/foo.js', 'src/bar.js']);
    assert.equal(msg, 'laia: update foo.js, bar.js');
  });

  it('falls back to file list when text is too short', () => {
    const msg = makeCommitMessage('ok', ['a.js']);
    assert.equal(msg, 'laia: update a.js');
  });
});

describe('isGitRepo', () => {
  it('returns true for a git repo', () => {
    const dir = makeTestRepo();
    try {
      assert.equal(isGitRepo(dir), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns false for a non-git directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'laia-nogit-'));
    try {
      assert.equal(isGitRepo(dir), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('createAutoCommitter', () => {
  let dir;
  let committer;

  beforeEach(() => {
    dir = makeTestRepo();
    committer = createAutoCommitter({ cwd: dir });
    committer.enabled = true;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts disabled by default', () => {
    const c = createAutoCommitter({ cwd: dir });
    assert.equal(c.enabled, false);
  });

  it('commits tracked files after turn', () => {
    const file = join(dir, 'src', 'new.js');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(file, 'console.log("hello");\n');

    committer.trackFile(file);
    const result = committer.commitIfNeeded('Added new.js with hello world');

    assert.ok(result);
    assert.ok(result.hash);
    assert.ok(result.message.startsWith('laia: '));
    assert.ok(result.files.some(f => f.includes('new.js')));

    // Verify git log
    const log = git(['log', '--oneline', '-1'], dir);
    assert.ok(log.includes('laia: '));
  });

  it('returns null when disabled', () => {
    committer.enabled = false;
    writeFileSync(join(dir, 'x.txt'), 'hi');
    committer.trackFile(join(dir, 'x.txt'));
    assert.equal(committer.commitIfNeeded('test'), null);
  });

  it('returns null when no files tracked', () => {
    assert.equal(committer.commitIfNeeded('test'), null);
  });

  it('returns null when not a git repo', () => {
    const noGit = mkdtempSync(join(tmpdir(), 'laia-nogit-'));
    try {
      const c = createAutoCommitter({ cwd: noGit });
      c.enabled = true;
      writeFileSync(join(noGit, 'file.txt'), 'data');
      c.trackFile(join(noGit, 'file.txt'));
      assert.equal(c.commitIfNeeded('test'), null);
    } finally { rmSync(noGit, { recursive: true, force: true }); }
  });

  it('clears tracked files after commit', () => {
    writeFileSync(join(dir, 'a.txt'), 'a');
    committer.trackFile(join(dir, 'a.txt'));
    committer.commitIfNeeded('first');

    // Second call should have nothing to commit
    assert.equal(committer.commitIfNeeded('second'), null);
  });

  it('handles multiple files in one commit', () => {
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    committer.trackFile(join(dir, 'a.txt'));
    committer.trackFile(join(dir, 'b.txt'));

    const result = committer.commitIfNeeded('Updated both files');
    assert.ok(result.hash);
    assert.equal(result.files.length, 2);
  });

  it('skips commit if tracked files have no actual changes', () => {
    // File already committed, track it again without changing
    const readme = join(dir, 'README.md');
    committer.trackFile(readme);
    const result = committer.commitIfNeeded('no changes');
    assert.equal(result, null);
  });

  it('clear() resets tracked files', () => {
    writeFileSync(join(dir, 'x.txt'), 'data');
    committer.trackFile(join(dir, 'x.txt'));
    committer.clear();
    assert.equal(committer.commitIfNeeded('test'), null);
  });

  it('uses --no-verify to skip hooks', () => {
    // Create a pre-commit hook that would fail
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    writeFileSync(join(dir, 'test.txt'), 'data');
    committer.trackFile(join(dir, 'test.txt'));
    const result = committer.commitIfNeeded('Should bypass hooks');
    assert.ok(result.hash); // Should succeed despite failing hook
  });
});
