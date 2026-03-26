# Bracketed Paste Mode — Design Spec

**Date:** 2026-03-26
**Status:** Approved
**Area:** REPL input handling (`src/repl.js`, new `src/paste.js`)

---

## Problem

When pasting long text containing newlines into the claudia REPL prompt, Node.js `readline` fires a separate `line` event for each `\n`. The `for await (const line of rl)` loop in `repl.js` treats every line as an independent prompt submission.

Root cause: `readline.createInterface` has no concept of "paste" vs "Enter key". Every `\n` or `\r\n` in the input stream is treated identically.

---

## Solution

Enable **VT100 bracketed paste mode** (`\x1b[?2004h`). When active, the terminal wraps any paste with:
- Start marker: `\x1b[200~`
- End marker:   `\x1b[201~`

A `Transform` stream (`src/paste.js`) sits between raw `stdin` and `readline`. It intercepts the markers and replaces newlines inside the paste region with `↵` (U+21B5) — a visible placeholder that readline does not treat as a line separator.

When the user presses Enter, `repl.js` converts `↵` back to real `\n` before passing the input to the LLM. The LLM receives the original multi-line content intact.

---

## Architecture

```
stdin (raw TTY)
    │
    ▼
PasteTransform (src/paste.js)
    │  • Detects \x1b[200~...\x1b[201~ markers
    │  • Replaces \n inside paste → ↵ (U+21B5)
    │  • Passes all other bytes through unchanged
    │  • Proxies isTTY / isRaw / setRawMode / columns / rows
    ▼
readline.createInterface({ input: pasteStream })
    │
    ▼
repl.js  for await (const line of rl)
    │  • line.replace(/↵/g, '\n')  ← restore real newlines
    ▼
LLM (receives original content with real \n)
```

---

## `src/paste.js` — Module Contract

### Export

```js
export function createPasteStream(stdin, stdout)
// Returns: { stream, enable, disable }
```

| Return value | Description |
|---|---|
| `stream` | A `Transform` that replaces `\n` inside paste markers with `↵`. Pass this as `input` to `readline.createInterface`. |
| `enable()` | Writes `\x1b[?2004h` to stdout — enables bracketed paste mode in the terminal. |
| `disable()` | Writes `\x1b[?2004l` to stdout — disables it on exit. |

### Non-TTY fallback

If `stdin.isTTY` is false (piped input, `--prompt` mode), returns `{ stream: stdin, enable: () => {}, disable: () => {} }`. Zero behaviour change for non-interactive use.

### TTY proxying

The transform exposes these properties/methods so readline enables full terminal-editing features:

| Property / Method | Behaviour |
|---|---|
| `transform.isTTY` | `true` (copied from stdin) |
| `transform.isRaw` | Tracks current raw mode state |
| `transform.setRawMode(mode)` | Proxies to `stdin.setRawMode(mode)` |
| `transform.columns` | Copied from `stdout.columns` (updated on `resize`) |
| `transform.rows` | Copied from `stdout.rows` (updated on `resize`) |

### Chunk boundary safety

Markers can be split across two stdin chunks (e.g., `\x1b[200` in chunk 1, `~` in chunk 2). A `tail` buffer retains the longest suffix of the current chunk that could be the start of a marker, and prepends it to the next chunk.

### Visual feedback

When a paste contains newlines, emits one line to `stderr`:
```
[paste: 3 lines]
```
This confirms to the user that newlines were captured and replaced with `↵`.

---

## `src/repl.js` — Changes

Seven targeted edits, no structural changes:

| # | Line | Change |
|---|---|---|
| 1 | top | `import { createPasteStream } from './paste.js';` |
| 2 | before `readline.createInterface` | `const { stream: pasteStream, enable: enablePaste, disable: disablePaste } = createPasteStream(stdin, stdout);` |
| 3 | `createInterface` call | `input: pasteStream` (was `stdin`) |
| 4 | after `rl` creation | `process.on('exit', disablePaste);` |
| 5 | `emitKeypressEvents` call | `emitKeypressEvents(pasteStream, rl)` (was `stdin`) |
| 6 | keypress on/off | `pasteStream.on/off('keypress', onEscKeypress)` (was `stdin`) |
| 7 | before `readline.createInterface` | `enablePaste()` after `rl.prompt()` first call |
| 8 | REPL loop line 212 | `input = line.trim().replace(/↵/g, '\n')` |

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Paste without newlines | Passes through unchanged (markers stripped, no `↵` substitution) |
| Terminal doesn't support bracketed paste | `\x1b[?2004h` is silently ignored; no markers sent; data passes through unmodified |
| `↵` appears literally in user's own typing | Extremely unlikely; sent to LLM as `\n`. Acceptable trade-off. |
| `askYesNo` / `permissions.js` raw reads | Both read directly from `process.stdin` (not `pasteStream`) — unaffected |
| Piped / non-TTY input | `createPasteStream` returns stdin unchanged |

---

## Files

| File | Action |
|---|---|
| `src/paste.js` | **Create** (~80 lines) |
| `src/repl.js` | **Modify** (8 small edits) |
