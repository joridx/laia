// Tests for undo.js — undo stack for file modifications
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createUndoStack } from '../src/undo.js';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'claudia-undo-test-'));
}

describe('createUndoStack', () => {
  let dir;
  let undo;

  beforeEach(() => {
    dir = makeTmpDir();
    undo = createUndoStack();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with depth 0', () => {
    assert.equal(undo.depth, 0);
  });

  it('undo returns null when nothing to undo', () => {
    assert.equal(undo.undo(), null);
  });

  it('restores a modified file', () => {
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'original');

    undo.startTurn();
    undo.trackFile(file);
    // Simulate agent writing
    writeFileSync(file, 'modified');
    undo.commitTurn();

    assert.equal(undo.depth, 1);
    assert.equal(readFileSync(file, 'utf8'), 'modified');

    const result = undo.undo();
    assert.equal(result.restored.length, 1);
    assert.equal(result.deleted.length, 0);
    assert.equal(readFileSync(file, 'utf8'), 'original');
    assert.equal(undo.depth, 0);
  });

  it('deletes a file that was created by agent', () => {
    const file = join(dir, 'new-file.txt');

    undo.startTurn();
    undo.trackFile(file); // file doesn't exist yet → content=null
    writeFileSync(file, 'created by agent');
    undo.commitTurn();

    assert.equal(existsSync(file), true);

    const result = undo.undo();
    assert.equal(result.deleted.length, 1);
    assert.equal(existsSync(file), false);
  });

  it('handles multiple files in one turn', () => {
    const file1 = join(dir, 'a.txt');
    const file2 = join(dir, 'b.txt');
    writeFileSync(file1, 'aaa');
    writeFileSync(file2, 'bbb');

    undo.startTurn();
    undo.trackFile(file1);
    undo.trackFile(file2);
    writeFileSync(file1, 'AAA');
    writeFileSync(file2, 'BBB');
    undo.commitTurn();

    undo.undo();
    assert.equal(readFileSync(file1, 'utf8'), 'aaa');
    assert.equal(readFileSync(file2, 'utf8'), 'bbb');
  });

  it('only captures first snapshot per file per turn', () => {
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'v1');

    undo.startTurn();
    undo.trackFile(file); // captures 'v1'
    writeFileSync(file, 'v2');
    undo.trackFile(file); // should NOT re-capture (would capture 'v2')
    writeFileSync(file, 'v3');
    undo.commitTurn();

    undo.undo();
    assert.equal(readFileSync(file, 'utf8'), 'v1'); // restores to original, not v2
  });

  it('supports multiple turns (LIFO)', () => {
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'v1');

    // Turn 1: v1 → v2
    undo.startTurn();
    undo.trackFile(file);
    writeFileSync(file, 'v2');
    undo.commitTurn();

    // Turn 2: v2 → v3
    undo.startTurn();
    undo.trackFile(file);
    writeFileSync(file, 'v3');
    undo.commitTurn();

    assert.equal(undo.depth, 2);

    // First undo: v3 → v2
    undo.undo();
    assert.equal(readFileSync(file, 'utf8'), 'v2');
    assert.equal(undo.depth, 1);

    // Second undo: v2 → v1
    undo.undo();
    assert.equal(readFileSync(file, 'utf8'), 'v1');
    assert.equal(undo.depth, 0);
  });

  it('does not push empty turns', () => {
    undo.startTurn();
    // No trackFile calls
    undo.commitTurn();
    assert.equal(undo.depth, 0);
  });

  it('handles commitTurn without startTurn', () => {
    undo.commitTurn(); // should not throw
    assert.equal(undo.depth, 0);
  });

  it('handles trackFile without startTurn', () => {
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'original');
    undo.trackFile(file); // should not throw
    assert.equal(undo.depth, 0);
  });

  it('respects MAX_TURNS limit (10)', () => {
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'v0');

    for (let i = 1; i <= 15; i++) {
      undo.startTurn();
      undo.trackFile(file);
      writeFileSync(file, `v${i}`);
      undo.commitTurn();
    }

    // Only last 10 turns kept
    assert.equal(undo.depth, 10);

    // Undo all 10
    for (let i = 0; i < 10; i++) undo.undo();
    assert.equal(undo.depth, 0);

    // File should be at v5 (v15 - 10 undos = v5)
    assert.equal(readFileSync(file, 'utf8'), 'v5');
  });

  it('peek returns files for next undo', () => {
    const file1 = join(dir, 'a.txt');
    const file2 = join(dir, 'b.txt');
    writeFileSync(file1, 'aaa');
    writeFileSync(file2, 'bbb');

    undo.startTurn();
    undo.trackFile(file1);
    undo.trackFile(file2);
    writeFileSync(file1, 'AAA');
    writeFileSync(file2, 'BBB');
    undo.commitTurn();

    const peeked = undo.peek();
    assert.equal(peeked.length, 2);
    assert.ok(peeked.includes(file1));
    assert.ok(peeked.includes(file2));
  });

  it('peek returns null when nothing to undo', () => {
    assert.equal(undo.peek(), null);
  });
});
