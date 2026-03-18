// Minimal unified diff generator for edit/write preview
// Zero dependencies — compares old/new text and generates colored hunks

/**
 * Generate a unified diff between two strings.
 * Returns empty string if no differences.
 */
export function unifiedDiff(oldText, newText, { path = '', context: ctx = 3 } = {}) {
  if (oldText === newText) return '';

  // Normalize path to POSIX for diff headers
  const posixPath = path.split('\\').join('/');

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Simple LCS-based diff
  const changes = diffLines(oldLines, newLines);
  if (!changes.length) return '';

  // Group changes into hunks with context
  const hunks = buildHunks(changes, oldLines, newLines, ctx);
  if (!hunks.length) return '';

  const header = `--- a/${posixPath}\n+++ b/${posixPath}`;
  return header + '\n' + hunks.join('\n') + '\n';
}

/**
 * Colorize a unified diff for terminal display.
 */
export function colorDiff(diffText) {
  if (!diffText) return '';
  return diffText.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return `\x1b[1m${line}\x1b[0m`;   // bold
    if (line.startsWith('+')) return `\x1b[32m${line}\x1b[0m`;  // green
    if (line.startsWith('-')) return `\x1b[31m${line}\x1b[0m`;  // red
    if (line.startsWith('@@')) return `\x1b[36m${line}\x1b[0m`; // cyan
    return line;
  }).join('\n');
}

/**
 * Find changed regions between two arrays of lines.
 * Returns array of { type: 'equal'|'delete'|'insert', oldStart, oldEnd, newStart, newEnd }
 */
function diffLines(oldLines, newLines) {
  // Build a map of matching lines using patience-like approach
  // For simplicity, use greedy LCS via dynamic programming on small inputs,
  // and fall back to line-by-line compare for large inputs
  const n = oldLines.length;
  const m = newLines.length;

  // For very large files, do a simpler comparison
  if (n + m > 10000) {
    return simpleDiff(oldLines, newLines);
  }

  // Build LCS table (memory-efficient: only need 2 rows)
  const prev = new Uint32Array(m + 1);
  const curr = new Uint32Array(m + 1);
  const directions = [];

  for (let i = 0; i <= n; i++) {
    directions.push(new Uint8Array(m + 1)); // 0=none, 1=diag, 2=up, 3=left
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        directions[i][j] = 1; // diagonal
      } else if (prev[j] >= curr[j - 1]) {
        curr[j] = prev[j];
        directions[i][j] = 2; // up
      } else {
        curr[j] = curr[j - 1];
        directions[i][j] = 3; // left
      }
    }
    prev.set(curr);
    curr.fill(0);
  }

  // Backtrack to find the diff (push + reverse for O(n) instead of unshift O(n²))
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && directions[i][j] === 1) {
      ops.push({ type: 'equal', line: i - 1 });
      i--; j--;
    } else if (i > 0 && (j === 0 || directions[i][j] === 2)) {
      ops.push({ type: 'delete', oldLine: i - 1 });
      i--;
    } else {
      ops.push({ type: 'insert', newLine: j - 1 });
      j--;
    }
  }
  ops.reverse();

  return ops;
}

/**
 * Simple fallback diff for large files.
 */
function simpleDiff(oldLines, newLines) {
  const ops = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0, ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      ops.push({ type: 'equal', line: oi });
      oi++; ni++;
    } else if (oi < oldLines.length) {
      ops.push({ type: 'delete', oldLine: oi });
      oi++;
    } else {
      ops.push({ type: 'insert', newLine: ni });
      ni++;
    }
  }
  return ops;
}

/**
 * Build unified diff hunks from a list of operations.
 */
function buildHunks(ops, oldLines, newLines, contextLines) {
  // Collect change ranges (consecutive non-equal ops)
  const ranges = [];
  let rangeStart = -1;

  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'equal') {
      if (rangeStart === -1) rangeStart = i;
    } else if (rangeStart !== -1) {
      ranges.push([rangeStart, i - 1]);
      rangeStart = -1;
    }
  }
  if (rangeStart !== -1) ranges.push([rangeStart, ops.length - 1]);

  if (!ranges.length) return [];

  // Merge ranges that are close together (within 2*context lines)
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    if (ranges[i][0] - prev[1] <= contextLines * 2) {
      prev[1] = ranges[i][1];
    } else {
      merged.push(ranges[i]);
    }
  }

  // Build hunk strings
  const hunks = [];
  for (const [start, end] of merged) {
    const ctxStart = Math.max(0, start - contextLines);
    const ctxEnd = Math.min(ops.length - 1, end + contextLines);

    let oldStart = 1, newStart = 1;
    let oldCount = 0, newCount = 0;
    const lines = [];

    // Calculate starting line numbers
    let oLine = 0, nLine = 0;
    for (let i = 0; i < ctxStart; i++) {
      if (ops[i].type === 'equal' || ops[i].type === 'delete') oLine++;
      if (ops[i].type === 'equal' || ops[i].type === 'insert') nLine++;
    }
    oldStart = oLine + 1;
    newStart = nLine + 1;

    for (let i = ctxStart; i <= ctxEnd; i++) {
      const op = ops[i];
      if (op.type === 'equal') {
        lines.push(` ${oldLines[op.line]}`);
        oldCount++; newCount++;
      } else if (op.type === 'delete') {
        lines.push(`-${oldLines[op.oldLine]}`);
        oldCount++;
      } else if (op.type === 'insert') {
        lines.push(`+${newLines[op.newLine]}`);
        newCount++;
      }
    }

    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    hunks.push(header + '\n' + lines.join('\n'));
  }

  return hunks;
}
