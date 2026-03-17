// Lightweight markdown-to-ANSI renderer for terminal output
// No external dependencies. Handles: headers, bold, italic, code, tables, links, lists.

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;

export function renderMarkdown(text) {
  if (!text) return '';

  const lines = text.split('\n');
  const out = [];
  let inCodeBlock = false;
  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        out.push(`${DIM}  ${'─'.repeat(50)}${RESET}`);
      } else {
        inCodeBlock = true;
        const lang = line.trimStart().slice(3).trim();
        out.push(`${DIM}  ${'─'.repeat(50)}${lang ? ` ${lang}` : ''}${RESET}`);
      }
      continue;
    }

    // Inside code block — dim + indented
    if (inCodeBlock) {
      out.push(`${DIM}  ${line}${RESET}`);
      continue;
    }

    // Table row — collect and render as a batch
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      tableRows.push(line);
      // Check if next line is NOT a table row → flush
      if (i + 1 >= lines.length || !lines[i + 1].trim().startsWith('|')) {
        out.push(...renderTable(tableRows));
        tableRows = [];
      }
      continue;
    }

    // Flush any pending table rows (shouldn't happen, but safety)
    if (tableRows.length) {
      out.push(...renderTable(tableRows));
      tableRows = [];
    }

    // Headers
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const text = renderInline(headerMatch[2]);
      if (level === 1) out.push(`\n${BOLD}${CYAN}${text}${RESET}\n`);
      else if (level === 2) out.push(`\n${BOLD}${GREEN}${text}${RESET}\n`);
      else out.push(`${BOLD}${text}${RESET}`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line.trim())) {
      out.push(`${DIM}${'─'.repeat(60)}${RESET}`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (ulMatch) {
      const indent = ulMatch[1];
      out.push(`${indent}  ${DIM}•${RESET} ${renderInline(ulMatch[2])}`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (olMatch) {
      const indent = olMatch[1];
      out.push(`${indent}  ${DIM}${olMatch[2]}.${RESET} ${renderInline(olMatch[3])}`);
      continue;
    }

    // Regular line — apply inline formatting
    out.push(renderInline(line));
  }

  return out.join('\n');
}

// Inline formatting: bold, italic, code, links
function renderInline(text) {
  return text
    // Inline code (before bold/italic to avoid conflicts)
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`)
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`)
    // Bold
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
    // Italic
    .replace(/\*(.+?)\*/g, `${ITALIC}$1${RESET}`)
    // Links [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}$1${RESET} ${DIM}($2)${RESET}`);
}

// Render markdown table with aligned columns
function renderTable(rows) {
  if (!rows.length) return [];

  // Parse cells
  const parsed = rows
    .map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
    .filter(cells => !cells.every(c => /^[-:]+$/.test(c))); // skip separator rows

  if (!parsed.length) return [];

  // Calculate column widths (strip ANSI for measuring)
  const colCount = Math.max(...parsed.map(r => r.length));
  const widths = Array(colCount).fill(0);
  for (const row of parsed) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? '';
      widths[c] = Math.max(widths[c], stripAnsi(renderInline(cell)).length);
    }
  }

  const out = [];
  const sep = `${DIM}  ${'┼'.padStart(1)}${widths.map(w => '─'.repeat(w + 2)).join('┼')}┼${RESET}`;

  for (let r = 0; r < parsed.length; r++) {
    const cells = parsed[r];
    const formatted = cells.map((cell, c) => {
      const rendered = renderInline(cell);
      const pad = widths[c] - stripAnsi(rendered).length;
      return ` ${rendered}${' '.repeat(Math.max(0, pad))} `;
    });

    if (r === 0) {
      // Header row: bold
      out.push(`  ${DIM}│${RESET}${formatted.map(f => `${BOLD}${f}${RESET}`).join(`${DIM}│${RESET}`)}${DIM}│${RESET}`);
      out.push(sep);
    } else {
      out.push(`  ${DIM}│${RESET}${formatted.join(`${DIM}│${RESET}`)}${DIM}│${RESET}`);
    }
  }

  return out;
}

// Strip ANSI escape codes for length calculation
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
