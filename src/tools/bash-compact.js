// Bash output compaction: smart truncation with lossless fallback
// When stdout exceeds THRESHOLD, persist full output to temp file
// and return a compact version: first N lines + error/warn lines + last M lines

import { writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// Configuration
const THRESHOLD_BYTES = 10 * 1024;  // 10 KB — below this, pass through unchanged
const HEAD_LINES = 100;             // first N lines always kept
const TAIL_LINES = 50;              // last M lines always kept
const MAX_ERROR_LINES = 50;         // cap error lines to prevent unbounded output
const MAX_COMPACT_BYTES = 20 * 1024; // secondary hard cap on compacted result
const ERROR_PATTERN = /\b(?:error|fail(?:ed|ure)?|warn(?:ing)?|exception|panic|fatal|segfault|abort(?:ed)?)\b|ENOENT|EACCES|denied|refused|Cannot find|not found|undefined is not|TypeError|SyntaxError|RangeError|ReferenceError/i;

// Directory for raw output persistence
const RAW_DIR = join(tmpdir(), 'laia-bash-raw');

// Cleanup: remove files older than 24 hours on first use
let cleanupDone = false;
function cleanupOldFiles() {
  if (cleanupDone) return;
  cleanupDone = true;
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const files = readdirSync(RAW_DIR);
    for (const f of files) {
      try {
        const fp = join(RAW_DIR, f);
        const st = statSync(fp);
        if (st.mtimeMs < cutoff) unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

/**
 * Compact bash output if it exceeds threshold.
 * Returns { stdout, stderr, rawFile?, compacted, notice? }
 */
export function compactBashOutput(stdout, stderr = '') {
  // Below threshold: pass through
  if ((!stdout || stdout.length < THRESHOLD_BYTES) && (!stderr || stderr.length < THRESHOLD_BYTES)) {
    return { stdout, stderr, compacted: false };
  }

  // Ensure raw directory exists + cleanup old files
  try { mkdirSync(RAW_DIR, { recursive: true }); } catch {}
  cleanupOldFiles();

  // Generate unique filename
  const id = randomBytes(4).toString('hex');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawFile = join(RAW_DIR, `bash-${ts}-${id}.log`);

  // Persist full raw output
  let writeSucceeded = false;
  try {
    const fullContent = stderr
      ? `=== STDOUT ===\n${stdout}\n=== STDERR ===\n${stderr}`
      : stdout;
    writeFileSync(rawFile, fullContent, 'utf8');
    writeSucceeded = true;
  } catch {}

  // Compact stdout
  const compactStdout = stdout && stdout.length >= THRESHOLD_BYTES
    ? compactText(stdout, 'stdout')
    : stdout;

  // Compact stderr
  const compactStderr = stderr && stderr.length >= THRESHOLD_BYTES
    ? compactText(stderr, 'stderr')
    : stderr;

  // Build truncation notice
  let notice;
  if (writeSucceeded) {
    const rawFilePosix = rawFile.replace(/\\/g, '/');
    notice = `\n⚠️ Output truncated. Full raw output: ${rawFilePosix}\n   Use read("${rawFilePosix}") to inspect full content.`;
  } else {
    notice = '\n⚠️ Output truncated. Raw file persistence FAILED — truncated content is all that remains.';
  }

  // Attach notice to whichever stream was compacted
  let finalStdout = compactStdout;
  let finalStderr = compactStderr;
  if (stdout && stdout.length >= THRESHOLD_BYTES && finalStdout) {
    finalStdout = finalStdout + notice;
  } else if (stderr && stderr.length >= THRESHOLD_BYTES && finalStderr) {
    finalStderr = finalStderr + notice;
  }

  return {
    stdout: finalStdout,
    stderr: finalStderr || '',
    ...(writeSucceeded && { rawFile }),
    compacted: true,
  };
}

/**
 * Compact a text block: head + error lines + tail
 */
function compactText(text, label) {
  const lines = text.split('\n');
  const totalLines = lines.length;

  // If lines fit in head+tail, no truncation needed
  if (totalLines <= HEAD_LINES + TAIL_LINES) {
    return text;
  }

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);

  // Find error/warning lines in the middle (not in head or tail)
  const middleStart = HEAD_LINES;
  const middleEnd = totalLines - TAIL_LINES;
  const errorLines = [];
  for (let i = middleStart; i < middleEnd; i++) {
    if (ERROR_PATTERN.test(lines[i])) {
      errorLines.push({ lineNum: i + 1, text: lines[i] });
      if (errorLines.length >= MAX_ERROR_LINES) break;
    }
  }

  // Build compact output
  const parts = [];
  parts.push(...head);

  const middleTotal = middleEnd - middleStart;
  const truncatedCount = middleTotal - Math.min(errorLines.length, middleTotal);

  if (errorLines.length > 0) {
    parts.push(`--- ${truncatedCount} lines omitted (${label}) | ${errorLines.length} error/warning lines preserved${errorLines.length >= MAX_ERROR_LINES ? ` (capped at ${MAX_ERROR_LINES})` : ''} ---`);
    for (const el of errorLines) {
      parts.push(`  L${el.lineNum}: ${el.text}`);
    }
    parts.push('--- end error/warning lines ---');
  } else {
    parts.push(`--- ${truncatedCount} lines omitted (${label}) | no errors/warnings found in omitted section ---`);
  }

  parts.push(...tail);

  let result = parts.join('\n');

  // Secondary hard cap
  if (result.length > MAX_COMPACT_BYTES) {
    result = result.substring(0, MAX_COMPACT_BYTES) + '\n--- compacted output itself truncated at 20KB ---';
  }

  return result;
}
