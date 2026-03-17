import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyEdit } from '../../src/tools/edit.js';

describe('applyEdit — exact match', () => {
  it('replaces an exact match', () => {
    const r = applyEdit('foo\nbar\nbaz', 'bar', 'qux');
    assert.deepEqual(r, { result: 'foo\nqux\nbaz', fuzzy: false });
  });

  it('returns null when not found', () => {
    assert.equal(applyEdit('foo\nbar', 'xyz', 'q'), null);
  });

  it('returns null for empty oldText', () => {
    assert.equal(applyEdit('foo', '', 'bar'), null);
  });

  it('returns null for non-string newText', () => {
    assert.equal(applyEdit('foo', 'foo', undefined), null);
  });
});

describe('applyEdit — fuzzy match (trailing whitespace)', () => {
  it('matches when oldText has trailing spaces that content does not', () => {
    const r = applyEdit('foo\nbar\nbaz', 'bar  ', 'qux');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'foo\nqux\nbaz');
  });

  it('matches when content has trailing spaces that oldText does not', () => {
    const r = applyEdit('foo\nbar  \nbaz', 'bar', 'qux');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'foo\nqux\nbaz');
  });

  it('matches multi-line block with trailing whitespace on one line', () => {
    const content = 'a\nb  \nc\nd';
    const r = applyEdit(content, 'b\nc', 'X');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'a\nX\nd');
  });

  it('returns null when no match even after normalization', () => {
    assert.equal(applyEdit('foo\nbar', 'baz', 'x'), null);
  });
});

describe('applyEdit — fuzzy match (tabs vs spaces)', () => {
  it('matches when oldText uses tabs and content uses spaces', () => {
    const r = applyEdit('  foo', '\tfoo', 'bar');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'bar');
  });

  it('matches when content uses tabs and oldText uses spaces', () => {
    const r = applyEdit('\tfoo', '  foo', 'bar');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'bar');
  });
});

describe('applyEdit — CRLF files', () => {
  it('fuzzy matches in a CRLF file without corrupting content', () => {
    const content = 'line1\r\nline2  \r\nline3\r\n';
    const r = applyEdit(content, 'line2', 'X');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.ok(r.result.startsWith('line1\r\n'), `starts with: ${JSON.stringify(r.result)}`);
    assert.ok(r.result.includes('X'), `contains X: ${JSON.stringify(r.result)}`);
    assert.ok(r.result.endsWith('line3\r\n'), `ends with: ${JSON.stringify(r.result)}`);
  });
});

describe('applyEdit — edge cases', () => {
  it('exact match at beginning of file', () => {
    const r = applyEdit('foo\nbar', 'foo', 'X');
    assert.deepEqual(r, { result: 'X\nbar', fuzzy: false });
  });

  it('exact match at end of file (no trailing newline)', () => {
    const r = applyEdit('foo\nbar', 'bar', 'X');
    assert.deepEqual(r, { result: 'foo\nX', fuzzy: false });
  });

  it('single-line file exact match', () => {
    const r = applyEdit('hello', 'hello', 'world');
    assert.deepEqual(r, { result: 'world', fuzzy: false });
  });
});
