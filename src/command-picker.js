// Interactive command picker for Claudia CLI
// Shows a navigable dropdown when user types "/" and presses Tab
// Uses raw mode stdin with ANSI escapes — no external dependencies
//
// Design: renders below the current prompt line, captures arrow keys + Enter,
// then returns the selected command string to the caller.

const ESC = '\x1b[';
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const CYAN = `${ESC}36m`;
const RESET = `${ESC}0m`;
const INVERSE = `${ESC}7m`;
const CLEAR_LINE = `${ESC}2K`;

const MAX_VISIBLE = 12;  // max rows visible at once

/**
 * Show an interactive command picker.
 *
 * @param {object} options
 * @param {Array<{name: string, desc: string, cat?: string}>} options.items - all commands
 * @param {string} options.filter - initial filter text (e.g. "" or partial command)
 * @param {import('readline').Interface} options.rl - readline instance to pause/resume
 * @param {import('stream').Readable} options.stdin - process.stdin
 * @param {import('stream').Writable} options.stderr - process.stderr
 * @returns {Promise<string|null>} selected command name (e.g. "/help") or null if cancelled
 */
export function showCommandPicker({ items, filter = '', rl, stdin, stderr }) {
  return new Promise((resolve) => {
    if (!stdin.isTTY) return resolve(null);

    // State
    let query = filter;
    let selected = 0;
    let scrollOffset = 0;
    let printedLines = 0;

    // Pause readline so it doesn't consume our input
    if (rl) rl.pause();
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    function getFiltered() {
      if (!query) return items;
      const q = query.toLowerCase();
      // Score: startsWith > includes > no match
      return items
        .map(item => {
          const n = item.name.toLowerCase();
          if (n.startsWith('/' + q)) return { ...item, score: 2 };
          if (n.includes(q)) return { ...item, score: 1 };
          return null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    }

    function render() {
      const filtered = getFiltered();
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);

      // Ensure selected is visible
      if (selected < scrollOffset) scrollOffset = selected;
      if (selected >= scrollOffset + MAX_VISIBLE) scrollOffset = selected - MAX_VISIBLE + 1;

      const visible = filtered.slice(scrollOffset, scrollOffset + MAX_VISIBLE);
      const lines = [];

      // Header with search field
      const searchLine = query ? `/${query}` : '/';
      const boxWidth = Math.min(55, (stderr.columns || 80) - 4);  // adapt to terminal width
      lines.push(`${DIM}┌─ ${RESET}${BOLD}${searchLine}${RESET}${DIM}${'─'.repeat(Math.max(1, boxWidth - searchLine.length - 3))}┐${RESET}`);

      if (filtered.length === 0) {
        lines.push(`${DIM}│${RESET}  ${DIM}No matching commands${RESET}`);
      } else {
        // Scroll up indicator
        if (scrollOffset > 0) {
          lines.push(`${DIM}│  ▲ ${scrollOffset} more${RESET}`);
        }

        const maxName = Math.max(14, ...visible.map(v => v.name.length));
        for (let i = 0; i < visible.length; i++) {
          const item = visible[i];
          const isSelected = (scrollOffset + i) === selected;
          const name = item.name.padEnd(maxName);
          const desc = (item.desc || '').slice(0, Math.max(10, boxWidth - maxName - 8));

          if (isSelected) {
            lines.push(`${DIM}│${RESET} ${INVERSE}${CYAN} ${name} ${RESET} ${DIM}${desc}${RESET}`);
          } else {
            lines.push(`${DIM}│${RESET}  ${BOLD}${name}${RESET} ${DIM}${desc}${RESET}`);
          }
        }

        // Scroll down indicator
        const remaining = filtered.length - scrollOffset - MAX_VISIBLE;
        if (remaining > 0) {
          lines.push(`${DIM}│  ▼ ${remaining} more${RESET}`);
        }
      }

      lines.push(`${DIM}└─ ↑↓ navigate · Enter select · Esc cancel${RESET}`);

      // Write: move to start of picker area, clear and rewrite
      const totalLines = lines.length;

      // First render: just print
      // Subsequent renders: move up and overwrite
      if (printedLines) {
        stderr.write(`${ESC}${printedLines}A`);  // move up
      }
      for (const line of lines) {
        stderr.write(`${CLEAR_LINE}${line}\n`);
      }
      printedLines = totalLines;
    }

    function cleanup() {
      // Clear the picker from screen
      try {
        if (printedLines) {
          stderr.write(`${ESC}${printedLines}A`);
          for (let i = 0; i < printedLines; i++) {
            stderr.write(`${CLEAR_LINE}\n`);
          }
          stderr.write(`${ESC}${printedLines}A`);
        }
      } catch { /* ignore render errors during cleanup */ }
      try {
        if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
      } catch { /* ignore */ }
      if (rl) rl.resume();
      stdin.removeListener('data', onKey);
    }

    function onKey(data) {
      const s = data.toString();
      const filtered = getFiltered();

      // Escape → cancel
      if (s === '\x1b' || s === '\x03') {  // Esc or Ctrl-C
        cleanup();
        return resolve(null);
      }

      // Enter → select
      if (s === '\r' || s === '\n') {
        const item = filtered[selected];
        cleanup();
        return resolve(item ? item.name : null);
      }

      // Arrow up
      if (s === '\x1b[A' || s === '\x1bOA') {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }

      // Arrow down
      if (s === '\x1b[B' || s === '\x1bOB') {
        selected = Math.min(filtered.length - 1, selected + 1);
        render();
        return;
      }

      // Tab → select (like Enter)
      if (s === '\t') {
        const item = filtered[selected];
        cleanup();
        return resolve(item ? item.name : null);
      }

      // Backspace
      if (s === '\x7f' || s === '\b') {
        if (query.length > 0) {
          query = query.slice(0, -1);
          selected = 0;
          scrollOffset = 0;
          render();
        } else {
          // Backspace on empty → cancel
          cleanup();
          return resolve(null);
        }
        return;
      }

      // Printable character → update filter
      if (s.length === 1 && s >= ' ' && s <= '~') {
        query += s;
        selected = 0;
        scrollOffset = 0;
        render();
        return;
      }
    }

    stdin.on('data', onKey);

    // Initial render
    render();
  });
}
