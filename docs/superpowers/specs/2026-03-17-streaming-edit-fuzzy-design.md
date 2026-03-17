# Design: Streaming Output + Edit Tool Fuzzy Search

**Date:** 2026-03-17
**Status:** Approved
**Priority:** High

---

## 1. Streaming Output

### Goal

Stream text tokens to the terminal as they are generated, eliminating the blank wait while the model thinks. Users see output immediately instead of waiting 10–30 seconds for a full response.

### Decisions

- **Raw token streaming, no markdown re-render.** Tokens printed as-is via `process.stdout.write`. The model generates readable markdown even without ANSI rendering.
- **`streamingApiCall` used for all LLM calls** (not just final text turns). If the response is a tool-call turn, no text delta events fire and `onChunk` is never called — the caller's `streamed` flag stays false automatically.
- **Claude models (done() trick) do not stream.** Claude's final text is embedded in tool call arguments. Silent fallback to non-streaming; a debug step event is emitted.
- **No user-initiated cancellation in this iteration.** The existing per-call `AbortController` tied to `timeoutMs` is reused.

### Architecture

#### `src/llm.js`

**`parseSSEStream(body)`** — async generator, module-level
- Input: `ReadableStream` from fetch response body; throws immediately if body is null/undefined (`makeError('Stream body is null', { retriable: false })`)
- Uses streaming `TextDecoder` with `{ stream: true }` (handles UTF-8 chunk boundaries)
- Buffers incomplete lines across chunks
- Yields parsed JSON objects from `data: {...}` lines
- Ignores `:` comment lines, empty lines, `event:`, `id:`, `retry:` fields
- Skips malformed JSON payloads (no crash, no yield)
- Terminates on `data: [DONE]`

**`streamingApiCall(endpoint, body, { onChunk })`** — inside `createLLMClient` closure
- Shares `getToken`, `timeoutMs` closure variables from `createLLMClient`
- Does NOT go through `withRetries` — streaming responses cannot be retried mid-stream; errors are non-retriable
- Adds `stream: true` to request body
- For `/chat/completions` also adds `stream_options: { include_usage: true }`
- **Pre-stream HTTP error handling:** check `res.ok` before reading the stream body; if not ok, read `res.text()`, attempt `JSON.parse` (catch silently on invalid JSON, default to `{}`), then call `classifyHttpError(res.status, json)` / `classifyApiError(json.error)` exactly as `apiCall` does (lines 46–52 in current code)
- Reads response via `parseSSEStream`
- Fires `onChunk({ type: 'text_delta', delta })` per text event
- Returns final assembled response (same shape as `apiCall`)
- On mid-stream error: throws `Object.assign(new Error(msg), { partialText: assembledSoFar, retriable: false })`
- `createLLMClient` return value: `{ apiCall, streamingApiCall, model }`

**SSE event schemas**

`/responses` (Codex):
- Text delta: `{ type: "response.output_text.delta", delta: "<text>" }` → `onChunk({ type: 'text_delta', delta: event.delta })`
- Final: `{ type: "response.completed", response: { ...full response... } }` → return `event.response` (authoritative). The `response` field in this event is identical in shape to the non-streaming `/responses` body — same `{ output: [...], usage: {...}, ... }` structure that `parseResponsesOutput` and `runResponsesTurn` expect. No shape adaptation needed.
- **`response.failed` / `response.incomplete`**: treat these terminal events as errors — throw `makeError(event.response?.error?.message ?? 'Response failed', { retriable: false })`. Do not silently ignore.
- **If `response.completed` never arrives** (stream ends without any terminal event): throw `makeError('Stream ended without response.completed', { retriable: false })`.
- Ignore all other event types (they fire for tool calls, reasoning, etc.)

`/chat/completions` (GPT, Claude):
- Text delta: `choices[0].delta.content` → `onChunk({ type: 'text_delta', delta: content })`
- Role: `choices[0].delta.role` — present only in the first chunk; capture it (`role = role || delta.role`); always `'assistant'`
- Tool call deltas: `choices[0].delta.tool_calls[N]` — accumulate by index: concatenate `function.arguments` fragments; capture `id` and `function.name` from first chunk for each index
- Finish reason: `choices[0].finish_reason` — present in the last non-`[DONE]` chunk
- Usage: `usage` field in terminal event (requires `stream_options.include_usage: true`)
- Assemble: `{ choices: [{ message: { role, content, tool_calls }, finish_reason }], usage }`

**`runResponsesTurn`**

Replace both `client.apiCall('/responses', ...)` calls with `client.streamingApiCall`. Pass `onChunk: (chunk) => onStep?.({ type: 'token', text: chunk.delta })`.

**`runChatTurn`**

Define once at the top of the function:
```js
const onChunk = isClaude ? null : (chunk) => onStep?.({ type: 'token', text: chunk.delta });
if (isClaude) onStep?.({ type: 'debug', streaming: false, reason: 'provider_unsupported' });
```

Update `chatCall` to branch explicitly — preserving `{ onStep }` for the `apiCall` path (Claude) and using `{ onChunk }` for the `streamingApiCall` path (GPT):
```js
async function chatCall(overrideToolChoice, chunkCb = onChunk) {
  const tc = overrideToolChoice ?? defaultToolChoice;
  const body = { model, messages, tools: chatTools, ...(chatTools ? { tool_choice: tc } : {}) };
  if (chunkCb) {
    return client.streamingApiCall('/chat/completions', body, { onChunk: chunkCb });
  } else {
    return client.apiCall('/chat/completions', body, { onStep });
  }
}
```

This ensures:
- Claude path (`chunkCb = null`): uses `client.apiCall` with `{ onStep }` unchanged — all `request`-phase and retry step events preserved
- GPT path (`chunkCb = onChunk`): uses `client.streamingApiCall` with `{ onChunk }`. The `request`-phase step event and retry events are intentionally not emitted on this path — `streamingApiCall` bypasses `withRetries` by design and callers do not depend on these events for correctness.

All four `chatCall` invocations keep their existing arguments:
- Initial call (line 187): `chatCall()` → `chunkCb` defaults to `onChunk`
- Empty-done nudge (line 203): `chatCall()` → same
- Force-done (line 249): `chatCall({ type: 'function', function: { name: 'done' } })` → `chunkCb` defaults to `onChunk`
- Regular loop tail (line 254): `chatCall()` → same

#### `src/agent.js`

Add `'token'` case to `printStep`:
```js
case 'token': process.stdout.write(step.text); break;
```

`runOneShot`: preserve the existing `try/finally { await stopBrain() }` wrapper — only the output logic inside the `try` block changes. Replace the `onStep` lambda and the final `console.log(result.text)` call (current lines 63–69) with:
```js
let streamed = false;
const result = await runTurn({
  input: prompt, config, logger,
  onStep: json ? undefined : (step) => {
    if (step.type === 'token') streamed = true;
    printStep(step);
  },
});
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (!streamed) {
  console.log(result.text);
}
// if streamed: tokens already on stdout, nothing more to do
// Note: when json=true, onStep is undefined so streamed stays false; the json branch
// takes priority and the !streamed branch is unreachable in json mode — correct.
```

#### `src/repl.js`

**readline + stdout interaction:** No `rl.pause()` is needed around `runTurn`. The readline prompt is only active (drawn) when `rl.prompt()` is called, which happens after the `try/catch` block completes. During `runTurn`, readline is waiting for the next `for await` iteration — `process.stdout.write` is safe.

**Main turn handler** (inside `for await` loop, inside `try` block) — three targeted changes:

**Change 1:** Insert `let streamed = false;` immediately before the existing `const result = await runTurn({...})` call at line 149. Do not redeclare `result`.

**Change 2:** Replace `onStep: printStep` inside the existing `runTurn({...})` call (line 154) with:
```js
onStep: (step) => {
  if (step.type === 'token') { streamed = true; process.stdout.write(step.text); }
  else printStep(step);
},
```

**Change 3:** Replace the existing `const text = result.text || '';` + `if (text) { ... } else { ⚠ }` block at lines 156–161 with:
```js
const text = result.text || '';
if (streamed) {
  process.stdout.write('\n\n');    // two newlines: visual symmetry with renderMarkdown path
} else if (text) {
  console.log(`\n${renderMarkdown(text)}\n`);
} else {
  stderr.write('\x1b[33m⚠ (empty response — model returned no text)\x1b[0m\n');
}
// context.addTurnMessages, router.recordToolsUsed, context.addAssistant, suggestFollowUps,
// result.usage display — all lines after this block remain unchanged
```

**File commands path** (ONE `runTurn` call site in `handleSlashCommand`, line 231):

Same pattern — replace `onStep: printStep` with a lambda tracking its own `let streamed = false`. Replace the `if (result.text) { console.log(...) }` block at line 232 with the `if (streamed) / else if (text)` pattern. No empty-response warning needed in this path (slash commands are expected to produce output).

### Acceptance Criteria

- [ ] Codex: first token appears within 1–2s of submitting a prompt
- [ ] GPT non-codex: same
- [ ] Claude models: no streaming; `renderMarkdown` path unchanged (no regression)
- [ ] Tool-call indicators (`→`, `✓`) still appear during tool iterations
- [ ] After streamed turn: `rl.prompt()` on new clean line
- [ ] Token count `[N in / N out]` shown after turn (from `result.usage` — unchanged)
- [ ] `runOneShot` non-JSON: no double-print
- [ ] `runOneShot` JSON: `result.text` present in JSON output
- [ ] `context.addAssistant(text)` and `suggestFollowUps(text)` work after streamed turn
- [ ] Empty response warning (`⚠`) preserved when model returns no text (non-streamed path)

---

## 2. Edit Tool Fuzzy Search

### Goal

The edit tool currently fails when `oldText` does not exactly match file content due to trailing whitespace differences. Fix without introducing fragile heuristics.

### Decisions

- **Normalize trailing whitespace + tabs per line, both sides.** `.trimEnd().replace(/\t/g, '  ')` applied to both `oldText` lines and `contentLines` before comparison.
- **CRLF correctness note.** `content.split('\n')` retains `\r` as part of `contentLines[k]` for CRLF files. `trimEnd()` strips it for comparison only. `contentLines.slice(i, i+nOld).join('\n')` re-joins with `'\n'` — but since `\r` is part of each line's content, the re-joined block is byte-identical to the original span in `content`. Offset arithmetic is byte-accurate. No special CRLF handling needed.
- **Empty `oldText` → `null`** (prevents silent `indexOf('')` prepend bug).
- **Undefined/non-string `newText` → `null`** (prevents silent `"undefined"` insertion).
- **`fuzzy_applied` status** returned when fuzzy path used.
- **Partial-edit write** on failure: intentional, matches existing behaviour.
- **Empty `edits` array**: `writeFileSync` with unchanged content — no-op, existing preserved behaviour.
- **Leading whitespace flexibility excluded** (wrong indentation → fail → force re-read).

### Architecture

#### `src/tools/edit.js`

**New `applyEdit(content, oldText, newText)` pure function** (module-level, before `registerEditTool`, not exported — testable via the tool's execute):

```js
function applyEdit(content, oldText, newText) {
  if (!oldText || typeof newText !== 'string') return null;

  // Step 1: exact match
  const idx = content.indexOf(oldText);
  if (idx !== -1) {
    return { result: content.slice(0, idx) + newText + content.slice(idx + oldText.length), fuzzy: false };
  }

  // Step 2: line-by-line fuzzy (both sides normalized)
  const normalize = s => s.trimEnd().replace(/\t/g, '  ');
  const contentLines = content.split('\n');
  const oldLines = oldText.split('\n');
  const nOld = oldLines.length;

  for (let i = 0; i <= contentLines.length - nOld; i++) {
    if (oldLines.every((ol, j) => normalize(contentLines[i + j]) === normalize(ol))) {
      // start: byte offset of line i in content.
      // contentLines[k] retains \r for CRLF files; join('\n') restores original byte span.
      const start = i === 0 ? 0 : contentLines.slice(0, i).join('\n').length + 1;
      const matchedBlock = contentLines.slice(i, i + nOld).join('\n');
      return {
        result: content.slice(0, start) + newText + content.slice(start + matchedBlock.length),
        fuzzy: true,
      };
    }
  }

  return null;
}
```

**Updated `execute` loop:**
```js
for (const { oldText, newText } of edits) {
  const r = applyEdit(content, oldText, newText);
  if (!r) {
    results.push({ oldText: oldText?.substring(0, 60) ?? '', status: 'not_found' });
    continue;
  }
  content = r.result;
  results.push({ oldText: oldText.substring(0, 60), status: r.fuzzy ? 'fuzzy_applied' : 'applied' });
}
```

**Tool schema updates:**
- Top-level `description`: `'Apply search/replace edits to a file. Trailing whitespace and tab/space differences are normalized (status: fuzzy_applied). Exact match returns applied. No match returns not_found.'`
- `oldText` property `description`: `'Text to find. Trailing whitespace and tab/space normalization applied if exact match fails.'`
- `newText` property `description`: `'Replacement text. Used verbatim — not normalized.'`

### Edge Cases

| Case | Behaviour |
|------|-----------|
| CRLF files | `trimEnd()` strips `\r` for comparison; `\r` retained in `contentLines[k]` preserves byte-accurate offsets |
| Empty `oldText` | `applyEdit` returns `null` → `not_found` (no file mutation) |
| Undefined/non-string `newText` | `applyEdit` returns `null` → `not_found` (no file mutation) |
| Empty `edits` array | `writeFileSync` with unchanged content — no-op (existing behaviour preserved) |
| Multiple edits same file | Each operates on already-mutated `content` |
| Single-line `oldText` | 1-element `split('\n')` array — fuzzy works identically |
| Multiple fuzzy matches | First match wins (consistent with `indexOf` semantics) |
| Edit N fails | Edits 1..N-1 written; model re-runs failed edit |

### Acceptance Criteria

- [ ] Exact match: `status: 'applied'` (no regression)
- [ ] `oldText` has trailing spaces: `status: 'fuzzy_applied'`
- [ ] `oldText` uses tabs, file uses spaces (or vice versa): `status: 'fuzzy_applied'`
- [ ] No match after normalization: `status: 'not_found'`, file unchanged
- [ ] Empty `oldText`: `status: 'not_found'`, file unchanged
- [ ] CRLF file: fuzzy match applies correctly; surrounding file content preserved
- [ ] Multiple edits: partial success writes partial result

---

## Out of Scope

- Leading-whitespace-flexible matching — posposat
- Levenshtein/edit-distance matching — over-engineering
- Markdown streaming render — posposat
- Per-turn Ctrl+C cancellation — posposat
- Backpressure (`stdout drain`) — posposat
- Session persistence, vision, rate limiting — separate roadmap items
