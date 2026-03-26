// Tests for src/paste.js — Bracketed Paste Transform
//
// Tests the PasteTransform stream that intercepts VT100 bracketed paste
// markers and replaces newlines with PUA sentinels.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { createPasteStream, SENTINEL, SENTINEL_RE } from '../src/paste.js';

const START = '\x1b[200~';
const END = '\x1b[201~';

// Helper: create a mock TTY stdin + stdout, push data, collect output
function createTestEnv() {
  const mockStdin = new PassThrough({ encoding: 'utf8' });
  mockStdin.isTTY = true;
  mockStdin.isRaw = false;
  mockStdin.setRawMode = (mode) => { mockStdin.isRaw = mode; };
  mockStdin.fd = 0;

  const mockStdout = new PassThrough({ encoding: 'utf8' });
  mockStdout.columns = 80;
  mockStdout.rows = 24;

  return { mockStdin, mockStdout };
}

// Helper: feed chunks and collect all output
function collectOutput(stream) {
  return new Promise((resolve) => {
    let out = '';
    stream.on('data', (chunk) => { out += chunk; });
    stream.on('end', () => resolve(out));
  });
}

// Helper: feed a single string in one chunk and get output
async function feedAndCollect(data, opts = {}) {
  const { mockStdin, mockStdout } = createTestEnv();
  const { stream } = createPasteStream(mockStdin, mockStdout);
  const outputPromise = collectOutput(stream);

  if (opts.chunks) {
    // Feed as multiple chunks
    for (const chunk of opts.chunks) {
      mockStdin.write(chunk);
    }
  } else {
    mockStdin.write(data);
  }

  // Small delay to let transform process
  await new Promise(r => setTimeout(r, 20));
  mockStdin.end();
  return outputPromise;
}

describe('paste.js — PasteTransform', () => {

  // --- Test 1: Normal text without markers ---
  it('passes normal text through unchanged', async () => {
    const result = await feedAndCollect('hello world');
    assert.equal(result, 'hello world');
  });

  // --- Test 2: Paste with newlines → sentinels ---
  it('replaces newlines inside paste markers with sentinel', async () => {
    const result = await feedAndCollect(`${START}line1\nline2\nline3${END}`);
    assert.equal(result, `line1${SENTINEL}line2${SENTINEL}line3`);
  });

  // --- Test 3: Paste without newlines → markers stripped ---
  it('strips markers when paste has no newlines', async () => {
    const result = await feedAndCollect(`${START}just text${END}`);
    assert.equal(result, 'just text');
  });

  // --- Test 4: Marker split across 2 chunks ---
  it('handles start marker split across two chunks', async () => {
    const result = await feedAndCollect(null, {
      chunks: ['\x1b[200', `~line1\nline2${END}`],
    });
    assert.equal(result, `line1${SENTINEL}line2`);
  });

  // --- Test 5: Marker split across 3+ chunks ---
  it('handles start marker split across three chunks', async () => {
    const result = await feedAndCollect(null, {
      chunks: ['\x1b[', '200', `~line1\nline2${END}`],
    });
    assert.equal(result, `line1${SENTINEL}line2`);
  });

  it('handles end marker split across two chunks', async () => {
    const result = await feedAndCollect(null, {
      chunks: [`${START}a\nb\x1b[201`, '~after'],
    });
    assert.equal(result, `a${SENTINEL}bafter`);
  });

  // --- Test 6: CRLF inside paste → single sentinel ---
  it('replaces CRLF inside paste with single sentinel', async () => {
    const result = await feedAndCollect(`${START}line1\r\nline2${END}`);
    assert.equal(result, `line1${SENTINEL}line2`);
  });

  // --- Test 7: Mixed CRLF and LF ---
  it('handles mixed CRLF and LF correctly', async () => {
    const result = await feedAndCollect(`${START}a\r\nb\nc\r\nd${END}`);
    assert.equal(result, `a${SENTINEL}b${SENTINEL}c${SENTINEL}d`);
  });

  // --- Test 8: Non-TTY passthrough ---
  it('returns stdin unchanged for non-TTY', () => {
    const mockStdin = new PassThrough({ encoding: 'utf8' });
    mockStdin.isTTY = false;
    const mockStdout = new PassThrough({ encoding: 'utf8' });

    const { stream, enable, disable } = createPasteStream(mockStdin, mockStdout);
    assert.equal(stream, mockStdin, 'should return stdin directly');
    // enable/disable should be no-ops
    enable();
    disable();
  });

  // --- Test 9: Multiple pastes ---
  it('handles consecutive pastes independently', async () => {
    const result = await feedAndCollect(
      `${START}a\nb${END} middle ${START}c\nd${END}`
    );
    assert.equal(result, `a${SENTINEL}b middle c${SENTINEL}d`);
  });

  // --- Test 10: Missing end marker → watchdog timeout ---
  it('resets on missing end marker after watchdog timeout', async () => {
    const { mockStdin, mockStdout } = createTestEnv();
    const { stream } = createPasteStream(mockStdin, mockStdout);
    const outputPromise = collectOutput(stream);

    mockStdin.write(`${START}stuck\ntext`);

    // Wait for watchdog (500ms) + margin
    await new Promise(r => setTimeout(r, 700));

    // After watchdog, normal input should work
    mockStdin.write('normal');
    await new Promise(r => setTimeout(r, 20));
    mockStdin.end();

    const result = await outputPromise;
    // The stuck content should have been flushed, normal text appended
    assert.ok(result.includes('normal'), 'normal text should pass through after watchdog');
  });

  // --- Test 11: Normal typing between pastes ---
  it('does not affect normal typing between pastes', async () => {
    const result = await feedAndCollect(
      `before${START}pasted\ntext${END}after`
    );
    assert.equal(result, `beforepasted${SENTINEL}textafter`);
  });

  // --- Test 12: Sentinel round-trip (replace → restore) ---
  it('sentinel round-trip: paste → sentinel → restore newlines', async () => {
    const result = await feedAndCollect(`${START}line1\nline2\nline3${END}`);
    // Simulate what repl.js does
    const restored = result.replace(SENTINEL_RE, '\n');
    assert.equal(restored, 'line1\nline2\nline3');
  });

  // --- Test 13: Large paste ---
  it('handles large paste (100KB) without issues', async () => {
    const bigLine = 'x'.repeat(1000);
    const lines = Array(100).fill(bigLine);
    const content = lines.join('\n');
    const result = await feedAndCollect(`${START}${content}${END}`);
    const restored = result.replace(SENTINEL_RE, '\n');
    assert.equal(restored, content);
  });

  // --- Test 14: Empty paste ---
  it('handles empty paste (markers only, no content)', async () => {
    const result = await feedAndCollect(`${START}${END}`);
    assert.equal(result, '');
  });

  // --- Test 15: enable/disable idempotent + re-enable ---
  it('enable/disable are idempotent and support re-enable', () => {
    const { mockStdin, mockStdout } = createTestEnv();
    const { enable, disable } = createPasteStream(mockStdin, mockStdout);

    let written = '';
    const origWrite = mockStdout.write.bind(mockStdout);
    mockStdout.write = (data) => { written += data; return origWrite(data); };

    enable();
    enable(); // second call is no-op (already enabled)
    disable();
    disable(); // second call is no-op (already disabled)
    enable(); // re-enable works after disable

    const enableCount = written.split('\x1b[?2004h').length - 1;
    const disableCount = written.split('\x1b[?2004l').length - 1;
    assert.equal(enableCount, 2, 'enable written twice (initial + re-enable)');
    assert.equal(disableCount, 1, 'disable written once');
  });

  // --- TTY proxying ---
  it('proxies isTTY, setRawMode, fd, columns, rows', () => {
    const { mockStdin, mockStdout } = createTestEnv();
    const { stream } = createPasteStream(mockStdin, mockStdout);

    assert.equal(stream.isTTY, true);
    assert.equal(stream.isRaw, false);
    stream.setRawMode(true);
    assert.equal(stream.isRaw, true);
    assert.equal(mockStdin.isRaw, true);
    assert.equal(stream.fd, 0);
    assert.equal(stream.columns, 80);
    assert.equal(stream.rows, 24);
  });

  // --- Resize event ---
  it('propagates resize events from stdout', () => {
    const { mockStdin, mockStdout } = createTestEnv();
    const { stream } = createPasteStream(mockStdin, mockStdout);

    let resized = false;
    stream.on('resize', () => { resized = true; });

    mockStdout.columns = 120;
    mockStdout.rows = 40;
    mockStdout.emit('resize');

    assert.equal(stream.columns, 120);
    assert.equal(stream.rows, 40);
    assert.ok(resized, 'resize event should propagate');
  });

  // --- CRLF split across chunks ---
  it('handles \\r at end of chunk followed by \\n in next chunk', async () => {
    const result = await feedAndCollect(null, {
      chunks: [`${START}line1\r`, `\nline2${END}`],
    });
    assert.equal(result, `line1${SENTINEL}line2`);
  });
});
