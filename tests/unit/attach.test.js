// tests/unit/attach.test.js
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { createAttachManager, isBinary, MAX_FILE_SIZE, MAX_IMAGE_SIZE, MAX_TOTAL_SIZE, MAX_FILES, TOKENS_PER_IMAGE, IMAGE_MIME } from '../../src/attach.js';

// Create a temp workspace for tests
const WORKSPACE = join(tmpdir(), `laia_attach_test_${randomBytes(4).toString('hex')}`);

// Minimal valid PNG (1x1 transparent pixel)
const VALID_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c626000000002000198e195280000000049454e44ae426082',
  'hex'
);
// Minimal valid JPEG
const VALID_JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc40000ffd9', 'hex');

function setup() {
  mkdirSync(join(WORKSPACE, 'sub'), { recursive: true });
  writeFileSync(join(WORKSPACE, 'hello.js'), 'const x = 1;\nconsole.log(x);\n');
  writeFileSync(join(WORKSPACE, 'readme.md'), '# Hello\nThis is a test.\n');
  writeFileSync(join(WORKSPACE, 'data.json'), '{"key": "value"}\n');
  writeFileSync(join(WORKSPACE, 'sub', 'nested.ts'), 'export const y = 2;\n');
  writeFileSync(join(WORKSPACE, 'screenshot.png'), VALID_PNG);
  writeFileSync(join(WORKSPACE, 'photo.jpg'), VALID_JPG);
  writeFileSync(join(WORKSPACE, 'fake.png'), Buffer.from('this is not a real png'));
}

function cleanup() {
  try { rmSync(WORKSPACE, { recursive: true, force: true }); } catch {}
}

// Setup once
setup();
// Register cleanup
process.on('exit', cleanup);

// --- isBinary ---

describe('isBinary', () => {
  it('returns false for text', () => {
    assert.equal(isBinary(Buffer.from('hello world')), false);
  });

  it('returns true for buffer with null bytes', () => {
    assert.equal(isBinary(Buffer.from([0x48, 0x00, 0x65, 0x6c])), true);
  });

  it('returns false for empty buffer', () => {
    assert.equal(isBinary(Buffer.alloc(0)), false);
  });
});

// --- createAttachManager ---

describe('attach single file', () => {
  it('attaches an existing file', () => {
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('hello.js');
    assert.equal(results.length, 1);
    assert.ok(results[0].ok);
    assert.equal(results[0].name, 'hello.js');
    assert.equal(am.count(), 1);
  });

  it('returns error for non-existent file', () => {
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('nope.js');
    assert.equal(results.length, 1);
    assert.equal(results[0].error, 'file not found');
    assert.equal(am.count(), 0);
  });

  it('re-attaching same file updates content (no duplicate)', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    am.attach('hello.js');
    assert.equal(am.count(), 1);
  });
});

describe('attach glob pattern', () => {
  it('attaches multiple files via glob', () => {
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('*.js');
    assert.ok(results.length >= 1);
    assert.ok(results.every(r => r.ok));
  });

  it('attaches nested files via recursive glob', () => {
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('**/*.ts');
    assert.equal(results.length, 1);
    assert.ok(results[0].ok);
    assert.equal(results[0].name, 'nested.ts');
  });

  it('returns error for glob with no matches', () => {
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('*.xyz');
    assert.equal(results.length, 1);
    assert.ok(results[0].error.includes('no files matched'));
  });
});

describe('attach binary detection', () => {
  it('rejects binary files', () => {
    const binPath = join(WORKSPACE, 'binary.dat');
    writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A]));
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('binary.dat');
    assert.equal(results[0].error, 'binary file (not text)');
    assert.equal(am.count(), 0);
  });
});

describe('attach size limits', () => {
  it('rejects file larger than MAX_FILE_SIZE', () => {
    const bigPath = join(WORKSPACE, 'big.txt');
    writeFileSync(bigPath, 'x'.repeat(MAX_FILE_SIZE + 1));
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('big.txt');
    assert.ok(results[0].error.includes('too large'));
    assert.equal(am.count(), 0);
    rmSync(bigPath);
  });

  it('enforces max files limit', () => {
    const am = createAttachManager(WORKSPACE);
    // Attach MAX_FILES files
    for (let i = 0; i < MAX_FILES; i++) {
      const p = join(WORKSPACE, `temp_${i}.txt`);
      writeFileSync(p, `file ${i}`);
      am.attach(`temp_${i}.txt`);
    }
    assert.equal(am.count(), MAX_FILES);

    // Next attach should fail
    const p = join(WORKSPACE, 'overflow.txt');
    writeFileSync(p, 'overflow');
    const results = am.attach('overflow.txt');
    assert.ok(results[0].error.includes('max files'));

    // Cleanup
    for (let i = 0; i < MAX_FILES; i++) rmSync(join(WORKSPACE, `temp_${i}.txt`));
    rmSync(p);
  });
});

// --- detach ---

describe('detach', () => {
  it('detaches by basename', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    assert.equal(am.count(), 1);
    assert.equal(am.detach('hello.js'), true);
    assert.equal(am.count(), 0);
  });

  it('detaches by 1-based index', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    am.attach('readme.md');
    assert.equal(am.count(), 2);
    assert.equal(am.detach('1'), true);
    assert.equal(am.count(), 1);
  });

  it('detaches all', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    am.attach('readme.md');
    assert.equal(am.detach('all'), true);
    assert.equal(am.count(), 0);
  });

  it('returns false for non-existent', () => {
    const am = createAttachManager(WORKSPACE);
    assert.equal(am.detach('nope.js'), false);
  });

  it('returns ambiguous when multiple files share basename', () => {
    // Create two files with same name in different dirs
    mkdirSync(join(WORKSPACE, 'dir_a'), { recursive: true });
    mkdirSync(join(WORKSPACE, 'dir_b'), { recursive: true });
    writeFileSync(join(WORKSPACE, 'dir_a', 'same.txt'), 'a');
    writeFileSync(join(WORKSPACE, 'dir_b', 'same.txt'), 'b');

    const am = createAttachManager(WORKSPACE);
    am.attach(join(WORKSPACE, 'dir_a', 'same.txt'));
    am.attach(join(WORKSPACE, 'dir_b', 'same.txt'));
    assert.equal(am.count(), 2);
    assert.equal(am.detach('same.txt'), 'ambiguous');
    assert.equal(am.count(), 2); // nothing removed

    // Cleanup
    rmSync(join(WORKSPACE, 'dir_a'), { recursive: true });
    rmSync(join(WORKSPACE, 'dir_b'), { recursive: true });
  });
});

// --- buildContext ---

describe('buildContext', () => {
  it('returns null when no files attached', () => {
    const am = createAttachManager(WORKSPACE);
    assert.equal(am.buildContext(), null);
  });

  it('wraps text files in XML-like tags with header', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    const ctx = am.buildContext();
    assert.ok(ctx !== null);
    assert.ok(ctx.text.includes('[Attached files'));
    assert.ok(ctx.text.includes('<file path='));
    assert.ok(ctx.text.includes('lang="js"'));
    assert.ok(ctx.text.includes('const x = 1;'));
    assert.ok(ctx.text.includes('</file>'));
    assert.ok(ctx.text.includes('[/Attached files]'));
    assert.deepEqual(ctx.images, []);
  });

  it('includes multiple text files', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    am.attach('readme.md');
    const ctx = am.buildContext();
    const fileCount = (ctx.text.match(/<file /g) || []).length;
    assert.equal(fileCount, 2);
    assert.deepEqual(ctx.images, []);
  });

  it('returns images in images array, not in text', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('screenshot.png');
    const ctx = am.buildContext();
    assert.equal(ctx.text, '');
    assert.equal(ctx.images.length, 1);
    assert.equal(ctx.images[0].mimeType, 'image/png');
    assert.equal(ctx.images[0].name, 'screenshot.png');
    assert.ok(ctx.images[0].base64.length > 0);
  });

  it('returns mixed text and images', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    am.attach('screenshot.png');
    const ctx = am.buildContext();
    assert.ok(ctx.text.includes('const x = 1;'));
    assert.equal(ctx.images.length, 1);
    assert.equal(ctx.images[0].mimeType, 'image/png');
  });
});

// --- list & estimateTokens ---

describe('list and estimateTokens', () => {
  it('list returns correct structure for text files', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    const files = am.list();
    assert.equal(files.length, 1);
    assert.equal(files[0].index, 1);
    assert.equal(files[0].name, 'hello.js');
    assert.equal(files[0].image, false);
    assert.ok(files[0].size > 0);
    assert.ok(files[0].tokens > 0);
  });

  it('list returns image flag for images', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('screenshot.png');
    const files = am.list();
    assert.equal(files.length, 1);
    assert.equal(files[0].image, true);
    assert.equal(files[0].tokens, TOKENS_PER_IMAGE);
  });

  it('estimateTokens returns positive number', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    assert.ok(am.estimateTokens() > 0);
  });

  it('estimateTokens uses TOKENS_PER_IMAGE for images', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('screenshot.png');
    assert.equal(am.estimateTokens(), TOKENS_PER_IMAGE);
  });

  it('totalSize sums file sizes', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    am.attach('readme.md');
    assert.ok(am.totalSize() > 0);
  });
});

// --- Image support ---

describe('image attachment', () => {
  it('attaches valid PNG', () => {
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('screenshot.png');
    assert.equal(results.length, 1);
    assert.ok(results[0].ok);
    assert.ok(results[0].image);
    assert.equal(am.count(), 1);
    assert.ok(am.hasImages());
  });

  it('attaches valid JPG', () => {
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('photo.jpg');
    assert.equal(results.length, 1);
    assert.ok(results[0].ok);
    assert.ok(results[0].image);
  });

  it('rejects fake PNG (wrong magic bytes)', () => {
    const am = createAttachManager(WORKSPACE);
    const results = am.attach('fake.png');
    assert.equal(results.length, 1);
    assert.ok(results[0].error);
    assert.ok(results[0].error.includes('magic bytes'));
    assert.equal(am.count(), 0);
  });

  it('hasImages returns false when no images', () => {
    const am = createAttachManager(WORKSPACE);
    am.attach('hello.js');
    assert.equal(am.hasImages(), false);
  });
});
