# Bracketed Paste Mode — Design Spec

**Date:** 2026-03-26
**Status:** Approved (v2 — post-Codex review)
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

A `Transform` stream (`src/paste.js`) sits between raw `stdin` and `readline`. It intercepts the markers and replaces newlines inside the paste region with `\uE000` (Private Use Area sentinel) — an invisible placeholder that readline does not treat as a line separator and cannot collide with real user text.

When the user presses Enter, `repl.js` converts `\uE000` back to real `\n` before passing the input to the LLM. The LLM receives the original multi-line content intact.

---

## Architecture

```
stdin (raw TTY)
    │
    ▼
PasteTransform (src/paste.js)
    │  • State machine: NORMAL → PASTING on \x1b[200~
    │  • Replaces \n and \r\n inside paste → \uE000 (PUA sentinel)
    │  • PASTING → NORMAL on \x1b[201~
    │  • Passes all other bytes through unchanged
    │  • Proxies isTTY / isRaw / setRawMode / columns / rows / fd
    ▼
readline.createInterface({ input: pasteStream })
    │
    ▼
repl.js  for await (const line of rl)
    │  • SENTINEL_RE.replace → '\n'  ← restore real newlines
    ▼
LLM (receives original content with real \n)
```

---

## `src/paste.js` — Module Contract

### Export

```js
export function createPasteStream(stdin, stdout)
// Returns: { stream, enable, disable, SENTINEL }
```

| Return value | Description |
|---|---|
| `stream` | A `Transform` that replaces `\n`/`\r\n` inside paste markers with `\uE000`. Pass as `input` to `readline.createInterface`. |
| `enable()` | Writes `\x1b[?2004h` to stdout — enables bracketed paste mode in the terminal. |
| `disable()` | Writes `\x1b[?2004l` to stdout — disables it. **Must** be called on exit. |
| `SENTINEL` | The sentinel char (`'\uE000'`) — exported so repl.js uses the same constant. |

### Non-TTY fallback

If `stdin.isTTY` is false (piped input, `--prompt` mode), returns `{ stream: stdin, enable: () => {}, disable: () => {} }`. Zero behaviour change for non-interactive use.

### TTY proxying

The transform exposes these properties/methods so readline enables full terminal-editing features:

| Property / Method | Behaviour |
|---|---|
| `transform.isTTY` | `true` (copied from stdin) |
| `transform.isRaw` | Tracks current raw mode state |
| `transform.setRawMode(mode)` | Proxies to `stdin.setRawMode(mode)`, updates `isRaw` |
| `transform.columns` | Copied from `stdout.columns` (updated on `resize`) |
| `transform.rows` | Copied from `stdout.rows` (updated on `resize`) |
| `transform.fd` | Proxied from `stdin.fd` (some libs inspect this) |

### State machine

```
NORMAL ──── \x1b[200~ ────► PASTING
  ▲                           │
  └──── \x1b[201~ ◄──────────┘

PASTING state:
  • \r\n → \uE000 (single sentinel)
  • \n   → \uE000
  • all other bytes → pass through
```

### Chunk boundary safety

Markers can be split across multiple stdin chunks (e.g., `\x1b[20` in chunk 1, `0~` in chunk 2, or even across 3+ chunks). A `tail` buffer retains the longest suffix of the current chunk that could be the start of a marker. On the next chunk, the tail is prepended and processed together.

**Malformed sequence safety:** If `\x1b[200~` arrives without a matching `\x1b[201~`, a watchdog timer (500ms) resets state to NORMAL and flushes any buffered tail. This prevents the transform from permanently entering paste mode on a broken terminal.

### CRLF normalisation

Inside paste regions, both `\r\n` and bare `\n` are replaced with a single sentinel. This handles Windows terminals that send `\r\n` on paste.

### Visual feedback

When a paste contains newlines, emits one line to `stderr`:
```
[paste: 3 lines]
```
This confirms to the user that newlines were captured.

---

## `src/repl.js` — Changes

Eight targeted edits, no structural changes:

| # | Location | Change |
|---|---|---|
| 1 | imports | `import { createPasteStream } from './paste.js';` |
| 2 | before `createInterface` | `const { stream: pasteStream, enable: enablePaste, disable: disablePaste, SENTINEL } = createPasteStream(stdin, stdout);` |
| 3 | `createInterface` call | `input: pasteStream` (was `stdin`) |
| 4 | after `rl` creation | Register cleanup: `process.on('exit', disablePaste); rl.on('close', disablePaste); process.on('SIGINT', disablePaste); process.on('SIGTERM', disablePaste);` |
| 5 | before first `rl.prompt()` | `enablePaste();` — **before** prompt, not after (avoids race) |
| 6 | `emitKeypressEvents` call | `emitKeypressEvents(pasteStream, rl)` (was `stdin`) |
| 7 | keypress on/off | `pasteStream.on/off('keypress', onEscKeypress)` (was `stdin`) |
| 8 | REPL loop line 212 | `input = line.trim().replace(SENTINEL_RE, '\n')` where `SENTINEL_RE = new RegExp(SENTINEL, 'g')` |

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Paste without newlines | Passes through unchanged (markers stripped, no sentinel substitution) |
| Terminal doesn't support bracketed paste | `\x1b[?2004h` silently ignored; no markers sent; data passes through unmodified |
| `\uE000` appears in user's own typing | Private Use Area — not on any keyboard. If somehow present, treated as newline. Acceptable. |
| `askYesNo` / `permissions.js` raw reads | Both read directly from `process.stdin` (not `pasteStream`) — unaffected. Note: paste markers may appear in raw reads; first char likely ESC → treated as cancel/no-op. |
| Piped / non-TTY input | `createPasteStream` returns stdin unchanged |
| Very large paste (10MB+) | Transform is streaming — processes chunks progressively, only buffers marker-length tail (~7 bytes max) |
| Paste during LLM streaming | Input queues in readline buffer; processed when next prompt appears |
| Missing end marker | Watchdog timer (500ms) resets to NORMAL state, flushes buffered content |
| CRLF paste (Windows) | `\r\n` → single sentinel (not double) |
| Marker split across 3+ chunks | State machine + tail buffer handles any split granularity |

---

## Files

| File | Action |
|---|---|
| `src/paste.js` | **Create** (~120 lines) |
| `src/repl.js` | **Modify** (8 targeted edits) |
| `tests/paste.test.js` | **Create** (~15 test cases) |

---

## Test Plan

| # | Test | Validates |
|---|---|---|
| 1 | Normal text without markers → passes through | No interference |
| 2 | Paste with newlines → sentinels in output | Core functionality |
| 3 | Paste without newlines → markers stripped, text intact | Edge case |
| 4 | Marker split across 2 chunks | Chunk boundary |
| 5 | Marker split across 3+ chunks | Robust parsing |
| 6 | CRLF inside paste → single sentinel | Windows compat |
| 7 | Mixed CRLF and LF → correct sentinel count | Normalisation |
| 8 | Non-TTY input → stdin passthrough | Fallback |
| 9 | Nested/repeated pastes → each isolated | Multi-paste |
| 10 | Missing end marker → watchdog timeout + flush | Malformed input |
| 11 | Normal typing between pastes → unaffected | Isolation |
| 12 | Sentinel round-trip (replace → restore) | Integration |
| 13 | Large paste (100KB) → streaming, no OOM | Performance |
| 14 | Empty paste (markers only, no content) | Edge case |
| 15 | Disable → enable → re-enable idempotent | Lifecycle |
