// tests/unit/diff.test.js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { unifiedDiff, colorDiff } from '../../src/diff.js';

describe('unifiedDiff', () => {
  it('returns empty string for identical text', () => {
    assert.equal(unifiedDiff('hello\nworld', 'hello\nworld'), '');
  });

  it('shows single line change', () => {
    const diff = unifiedDiff('foo\nbar\nbaz', 'foo\nqux\nbaz', { path: 'test.js' });
    assert.ok(diff.includes('--- a/test.js'));
    assert.ok(diff.includes('+++ b/test.js'));
    assert.ok(diff.includes('-bar'));
    assert.ok(diff.includes('+qux'));
    assert.ok(diff.includes('@@'));
  });

  it('shows added lines', () => {
    const diff = unifiedDiff('a\nb', 'a\nb\nc\nd', { path: 'f.txt' });
    assert.ok(diff.includes('+c'));
    assert.ok(diff.includes('+d'));
    assert.ok(!diff.includes('-c'));
  });

  it('shows deleted lines', () => {
    const diff = unifiedDiff('a\nb\nc\nd', 'a\nb', { path: 'f.txt' });
    assert.ok(diff.includes('-c'));
    assert.ok(diff.includes('-d'));
    assert.ok(!diff.includes('+c'));
  });

  it('handles new file (empty old)', () => {
    const diff = unifiedDiff('', 'hello\nworld', { path: 'new.js' });
    assert.ok(diff.includes('+hello'));
    assert.ok(diff.includes('+world'));
  });

  it('handles file deletion (empty new)', () => {
    const diff = unifiedDiff('hello\nworld', '', { path: 'del.js' });
    assert.ok(diff.includes('-hello'));
    assert.ok(diff.includes('-world'));
  });

  it('shows context lines around changes', () => {
    const old = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8';
    const neu = 'line1\nline2\nline3\nCHANGED\nline5\nline6\nline7\nline8';
    const diff = unifiedDiff(old, neu, { path: 'ctx.txt', context: 2 });
    // Should have context: line2, line3 before; line5, line6 after
    assert.ok(diff.includes(' line2') || diff.includes(' line3'));
    assert.ok(diff.includes('-line4'));
    assert.ok(diff.includes('+CHANGED'));
  });

  it('handles multiple separate changes', () => {
    const old = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';
    const neu = 'a\nB\nc\nd\ne\nf\ng\nH\ni\nj';
    const diff = unifiedDiff(old, neu, { path: 'multi.txt', context: 1 });
    assert.ok(diff.includes('-b'));
    assert.ok(diff.includes('+B'));
    assert.ok(diff.includes('-h'));
    assert.ok(diff.includes('+H'));
  });

  it('includes @@ hunk headers with line numbers', () => {
    const diff = unifiedDiff('a\nb\nc', 'a\nX\nc', { path: 't.txt' });
    const match = diff.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    assert.ok(match, 'Should have hunk header');
  });
});

describe('colorDiff', () => {
  it('returns empty string for empty input', () => {
    assert.equal(colorDiff(''), '');
  });

  it('colors added lines green', () => {
    const colored = colorDiff('+added line');
    assert.ok(colored.includes('\x1b[32m'));
    assert.ok(colored.includes('+added line'));
  });

  it('colors removed lines red', () => {
    const colored = colorDiff('-removed line');
    assert.ok(colored.includes('\x1b[31m'));
    assert.ok(colored.includes('-removed line'));
  });

  it('colors hunk headers cyan', () => {
    const colored = colorDiff('@@ -1,3 +1,3 @@');
    assert.ok(colored.includes('\x1b[36m'));
  });

  it('colors file headers bold', () => {
    const colored = colorDiff('--- a/file.js\n+++ b/file.js');
    assert.ok(colored.includes('\x1b[1m'));
  });

  it('leaves context lines uncolored', () => {
    const colored = colorDiff(' context line');
    assert.ok(!colored.includes('\x1b['));
  });
});

describe('diff integration with edit tool', () => {
  it('unifiedDiff produces valid output for typical edit', () => {
    const original = 'import { foo } from "bar";\n\nconst x = 1;\nconst y = 2;\n\nexport { x, y };\n';
    const edited  = 'import { foo } from "bar";\n\nconst x = 42;\nconst y = 2;\n\nexport { x, y };\n';
    const diff = unifiedDiff(original, edited, { path: 'src/foo.js' });
    assert.ok(diff.includes('--- a/src/foo.js'));
    assert.ok(diff.includes('+++ b/src/foo.js'));
    assert.ok(diff.includes('-const x = 1;'));
    assert.ok(diff.includes('+const x = 42;'));
    // Context should include surrounding unchanged lines
    assert.ok(diff.includes(' const y = 2;'));
  });
});
