// Bracketed Paste Transform for Claudia REPL
//
// Intercepts VT100 bracketed paste markers (\x1b[200~ / \x1b[201~)
// and replaces newlines inside paste regions with a PUA sentinel,
// so readline doesn't split pasted text into multiple line events.
//
// See: docs/superpowers/specs/2026-03-26-bracketed-paste-design.md

import { Transform } from 'stream';

// Private Use Area sentinel — cannot appear from keyboard input
export const SENTINEL = '\uE000';
export const SENTINEL_RE = new RegExp(SENTINEL, 'g');

const START_MARKER = '\x1b[200~';
const END_MARKER = '\x1b[201~';
const ENABLE_SEQ = '\x1b[?2004h';
const DISABLE_SEQ = '\x1b[?2004l';

// Longest marker is 6 chars — we need to buffer up to 5 chars
// (the longest proper prefix of either marker)
const MAX_MARKER_LEN = Math.max(START_MARKER.length, END_MARKER.length);

const NORMAL = 0;
const PASTING = 1;

// Watchdog timeout: if we enter PASTING but never see END_MARKER,
// reset after this many ms to prevent getting stuck
const WATCHDOG_MS = 500;

/**
 * Create a paste-aware transform stream.
 *
 * @param {import('stream').Readable} stdinStream - raw stdin (typically process.stdin)
 * @param {import('stream').Writable} stdoutStream - stdout for writing escape sequences
 * @returns {{ stream: Transform, enable: () => void, disable: () => void, SENTINEL: string }}
 */
export function createPasteStream(stdinStream, stdoutStream) {
  // Non-TTY fallback: zero behaviour change
  if (!stdinStream.isTTY) {
    return {
      stream: stdinStream,
      enable: () => {},
      disable: () => {},
      SENTINEL,
    };
  }

  let state = NORMAL;
  let tail = '';           // buffered suffix that could be start of a marker
  let nlCount = 0;         // newline counter for visual feedback
  let watchdog = null;

  function clearWatchdog() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  function startWatchdog() {
    clearWatchdog();
    watchdog = setTimeout(() => {
      // Malformed: got START but no END — flush tail and reset
      if (state === PASTING) {
        state = NORMAL;
        if (tail) {
          transform.push(tail);
          tail = '';
        }
        nlCount = 0;
      }
    }, WATCHDOG_MS);
    // Don't prevent Node from exiting
    if (watchdog.unref) watchdog.unref();
  }

  const transform = new Transform({
    // Work with strings, not buffers
    decodeStrings: false,
    encoding: 'utf8',

    transform(chunk, _encoding, callback) {
      // Ensure we work with strings (stdin may deliver Buffers)
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Prepend any buffered tail from previous chunk
      let data = tail + str;
      tail = '';

      let i = 0;
      while (i < data.length) {
        // Check if we might be at the start of a marker
        const remaining = data.slice(i);

        if (state === NORMAL) {
          // Look for START_MARKER
          if (remaining.startsWith(START_MARKER)) {
            // Enter paste mode
            state = PASTING;
            nlCount = 0;
            i += START_MARKER.length;
            startWatchdog();
            continue;
          }
          // Check if remaining could be a prefix of START_MARKER
          if (couldBePrefix(remaining, START_MARKER)) {
            tail = remaining;
            break;
          }
          // Regular char — pass through
          this.push(data[i]);
          i++;

        } else {
          // PASTING state
          // Look for END_MARKER
          if (remaining.startsWith(END_MARKER)) {
            state = NORMAL;
            clearWatchdog();
            i += END_MARKER.length;
            // Visual feedback
            if (nlCount > 0) {
              stdoutStream.write(`\r\x1b[K[paste: ${nlCount + 1} lines]\n`);
            }
            nlCount = 0;
            continue;
          }
          // Check if remaining could be a prefix of END_MARKER
          if (couldBePrefix(remaining, END_MARKER)) {
            tail = remaining;
            break;
          }
          // CRLF normalisation: \r\n → single sentinel
          if (data[i] === '\r' && i + 1 < data.length && data[i + 1] === '\n') {
            this.push(SENTINEL);
            nlCount++;
            i += 2;
            continue;
          }
          // Bare \r at end of chunk — could be start of \r\n split across chunks
          if (data[i] === '\r' && i + 1 >= data.length) {
            tail = '\r';
            break;
          }
          // Bare \n → sentinel
          if (data[i] === '\n') {
            this.push(SENTINEL);
            nlCount++;
            i++;
            continue;
          }
          // Regular char in paste — pass through
          this.push(data[i]);
          i++;
        }
      }

      callback();
    },

    flush(callback) {
      // Stream ending — flush any remaining tail
      if (tail) {
        this.push(tail);
        tail = '';
      }
      clearWatchdog();
      state = NORMAL;
      callback();
    },
  });

  // --- TTY proxying ---
  transform.isTTY = true;
  transform.isRaw = stdinStream.isRaw || false;

  transform.setRawMode = function (mode) {
    if (stdinStream.setRawMode) {
      stdinStream.setRawMode(mode);
    }
    transform.isRaw = mode;
    return transform;
  };

  // File descriptor (some libs inspect this)
  if (stdinStream.fd !== undefined) {
    Object.defineProperty(transform, 'fd', {
      get: () => stdinStream.fd,
    });
  }

  // Terminal dimensions
  transform.columns = stdoutStream.columns;
  transform.rows = stdoutStream.rows;
  const onResize = () => {
    transform.columns = stdoutStream.columns;
    transform.rows = stdoutStream.rows;
    transform.emit('resize');
  };
  stdoutStream.on('resize', onResize);
  // Clean up resize listener when transform is destroyed
  transform.on('close', () => stdoutStream.off('resize', onResize));

  // Connect stdin → transform
  stdinStream.pipe(transform);

  let pasteModeEnabled = false;

  // --- Enable/disable ---
  function enable() {
    if (!pasteModeEnabled) {
      stdoutStream.write(ENABLE_SEQ);
      pasteModeEnabled = true;
    }
  }

  function disable() {
    if (pasteModeEnabled) {
      stdoutStream.write(DISABLE_SEQ);
      pasteModeEnabled = false;
      clearWatchdog();
    }
  }

  return { stream: transform, enable, disable, SENTINEL };
}

/**
 * Check if `str` is a proper prefix of `marker` (shorter, and matches).
 * Returns true only if str.length < marker.length and marker starts with str.
 */
function couldBePrefix(str, marker) {
  if (str.length >= marker.length) return false;
  return marker.startsWith(str);
}
