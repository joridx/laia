# Streaming Output + Edit Tool Fuzzy Search — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time token streaming to the REPL and fix the edit tool's exact-match failure on trailing-whitespace/tab differences.

**Architecture:** Two independent features. Edit fuzzy: new pure `applyEdit()` function in `src/tools/edit.js` with line-by-line normalized matching. Streaming: new `parseSSEStream()` generator + `streamingApiCall()` in `src/llm.js`, wired into `runResponsesTurn`, `runChatTurn`, `agent.js`, and `repl.js` via an `onStep({type:'token'})` event.

**Tech Stack:** Node.js 24+ ESM, `node:test` (built-in, no extra deps), `node:assert/strict`

**Spec:** `docs/superpowers/specs/2026-03-17-streaming-edit-fuzzy-design.md`

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `package.json` | Modify | Add `test` script |
| `tests/unit/edit.test.js` | Create | Unit tests for `applyEdit` |
| `src/tools/edit.js` | Modify | Add `applyEdit` (exported for tests), update execute loop + schema |
| `tests/unit/sse.test.js` | Create | Unit tests for `parseSSEStream` |
| `src/llm.js` | Modify | Add `parseSSEStream`, `streamingApiCall`; update `runResponsesTurn`, `runChatTurn`/`chatCall`; update `createLLMClient` return |
| `src/agent.js` | Modify | Add `'token'` case to `printStep`; update `runOneShot` |
| `src/repl.js` | Modify | Update main turn handler + slash-command handler |

---

## PART A — Edit Tool Fuzzy Search

### Task 1: Test infrastructure + `applyEdit` failing tests

**Files:**
- Modify: `package.json`
- Create: `tests/unit/edit.test.js`

- [ ] **Step 1.1 — Add test script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test": "node --test 'tests/**/*.test.js'"
```

- [ ] **Step 1.2 — Create `tests/unit/edit.test.js` with failing tests**

```js
// tests/unit/edit.test.js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyEdit } from '../../src/tools/edit.js';

describe('applyEdit — exact match', () => {
  it('replaces an exact match', () => {
    const r = applyEdit('foo\nbar\nbaz', 'bar', 'qux');
    assert.deepEqual(r, { result: 'foo\nqux\nbaz', fuzzy: false });
  });

  it('returns null when not found', () => {
    assert.equal(applyEdit('foo\nbar', 'xyz', 'q'), null);
  });

  it('returns null for empty oldText', () => {
    assert.equal(applyEdit('foo', '', 'bar'), null);
  });

  it('returns null for non-string newText', () => {
    assert.equal(applyEdit('foo', 'foo', undefined), null);
  });
});

describe('applyEdit — fuzzy match (trailing whitespace)', () => {
  it('matches when oldText has trailing spaces that content does not', () => {
    const r = applyEdit('foo\nbar\nbaz', 'bar  ', 'qux');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'foo\nqux\nbaz');
  });

  it('matches when content has trailing spaces that oldText does not', () => {
    const r = applyEdit('foo\nbar  \nbaz', 'bar', 'qux');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'foo\nqux\nbaz');
  });

  it('matches multi-line block with trailing whitespace on one line', () => {
    const content = 'a\nb  \nc\nd';
    const r = applyEdit(content, 'b\nc', 'X');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'a\nX\nd');
  });

  it('returns null when no match even after normalization', () => {
    assert.equal(applyEdit('foo\nbar', 'baz', 'x'), null);
  });
});

describe('applyEdit — fuzzy match (tabs vs spaces)', () => {
  it('matches when oldText uses tabs and content uses spaces', () => {
    const r = applyEdit('  foo', '\tfoo', 'bar');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'bar');
  });

  it('matches when content uses tabs and oldText uses spaces', () => {
    const r = applyEdit('\tfoo', '  foo', 'bar');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    assert.equal(r.result, 'bar');
  });
});

describe('applyEdit — CRLF files', () => {
  it('fuzzy matches in a CRLF file without corrupting content', () => {
    const content = 'line1\r\nline2  \r\nline3\r\n';
    const r = applyEdit(content, 'line2', 'X');
    assert.ok(r !== null);
    assert.equal(r.fuzzy, true);
    // surrounding CRLF lines must be preserved
    assert.ok(r.result.startsWith('line1\r\n'), `starts with: ${JSON.stringify(r.result)}`);
    assert.ok(r.result.includes('X'), `contains X: ${JSON.stringify(r.result)}`);
    assert.ok(r.result.endsWith('line3\r\n'), `ends with: ${JSON.stringify(r.result)}`);
  });
});

describe('applyEdit — edge cases', () => {
  it('exact match at beginning of file', () => {
    const r = applyEdit('foo\nbar', 'foo', 'X');
    assert.deepEqual(r, { result: 'X\nbar', fuzzy: false });
  });

  it('exact match at end of file (no trailing newline)', () => {
    const r = applyEdit('foo\nbar', 'bar', 'X');
    assert.deepEqual(r, { result: 'foo\nX', fuzzy: false });
  });

  it('single-line file exact match', () => {
    const r = applyEdit('hello', 'hello', 'world');
    assert.deepEqual(r, { result: 'world', fuzzy: false });
  });
});
```

- [ ] **Step 1.3 — Run tests and confirm they fail**

```bash
cd C:/claude/claudia && node --test tests/unit/edit.test.js
```

Expected: errors like `SyntaxError: The requested module '../../src/tools/edit.js' does not provide an export named 'applyEdit'`

---

### Task 2: Implement `applyEdit` in `src/tools/edit.js`

**Files:**
- Modify: `src/tools/edit.js`

- [ ] **Step 2.1 — Export `applyEdit` as a new function above `registerEditTool`**

> **Note:** The spec's parenthetical says "not exported", but we intentionally export it here for unit testability. The tests in Task 1 depend on this export.

In `src/tools/edit.js`, insert before the `export function registerEditTool` line:

```js
export function applyEdit(content, oldText, newText) {
  if (!oldText || typeof newText !== 'string') return null;

  // Step 1: exact match
  const idx = content.indexOf(oldText);
  if (idx !== -1) {
    return { result: content.slice(0, idx) + newText + content.slice(idx + oldText.length), fuzzy: false };
  }

  // Step 2: line-by-line fuzzy (both sides normalized for trailing whitespace + tabs)
  // Note: split('\n') retains \r in each line for CRLF files; join('\n') reconstructs
  // the exact byte span because \r is part of each line element.
  const normalize = s => s.trimEnd().replace(/\t/g, '  ');
  const contentLines = content.split('\n');
  const oldLines = oldText.split('\n');
  const nOld = oldLines.length;

  for (let i = 0; i <= contentLines.length - nOld; i++) {
    if (oldLines.every((ol, j) => normalize(contentLines[i + j]) === normalize(ol))) {
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

- [ ] **Step 2.2 — Run tests and confirm they pass**

```bash
node --test tests/unit/edit.test.js
```

Expected: all tests pass (green)

---

### Task 3: Update `execute` loop and tool schema

**Files:**
- Modify: `src/tools/edit.js`

- [ ] **Step 3.1 — Replace the `execute` for-loop body**

In `registerEditTool`, replace the existing `for (const { oldText, newText } of edits)` loop body with:

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

- [ ] **Step 3.2 — Update tool schema descriptions**

Replace the `description` field of the tool (top-level) from:
`'Apply search/replace edits to a file. Each edit replaces an exact text match.'`
to:
`'Apply search/replace edits to a file. Trailing whitespace and tab/space differences are normalized automatically (status: fuzzy_applied). Exact match returns applied. No match returns not_found.'`

Replace the `oldText` property `description` from `'Exact text to find'` to:
`'Text to find. Trailing whitespace and tab/space normalization applied automatically if exact match fails.'`

Add `description` to `newText` property: `'Replacement text. Used verbatim — not normalized.'`

- [ ] **Step 3.3 — Re-run tests to confirm no regression**

```bash
node --test tests/unit/edit.test.js
```

Expected: all tests still pass

- [ ] **Step 3.4 — Commit**

```bash
cd C:/claude/claudia && git add package.json tests/unit/edit.test.js src/tools/edit.js && git commit -m "feat(edit): fuzzy search with trailing-whitespace and tab normalization"
```

---

## PART B — Streaming Output

### Task 4: `parseSSEStream` with tests

**Files:**
- Create: `tests/unit/sse.test.js`
- Modify: `src/llm.js`

- [ ] **Step 4.1 — Create failing tests for `parseSSEStream`**

```js
// tests/unit/sse.test.js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSSEStream } from '../../src/llm.js';

// Helper: turn an array of strings into a ReadableStream
function makeStream(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

describe('parseSSEStream', () => {
  it('yields parsed JSON from data lines', async () => {
    const stream = makeStream(['data: {"type":"hello"}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ type: 'hello' }]);
  });

  it('handles multiple events in one chunk', async () => {
    const stream = makeStream(['data: {"a":1}\n\ndata: {"b":2}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ a: 1 }, { b: 2 }]);
  });

  it('handles events split across chunks', async () => {
    const stream = makeStream(['data: {"a"', ':1}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ a: 1 }]);
  });

  it('ignores comment lines starting with :', async () => {
    const stream = makeStream([': ping\ndata: {"ok":true}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ ok: true }]);
  });

  it('terminates on [DONE]', async () => {
    const stream = makeStream(['data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ a: 1 }]);
  });

  it('skips malformed JSON without crashing', async () => {
    const stream = makeStream(['data: not-json\n\ndata: {"ok":true}\n\n']);
    const results = [];
    for await (const ev of parseSSEStream(stream)) results.push(ev);
    assert.deepEqual(results, [{ ok: true }]);
  });

  it('throws immediately for null body', async () => {
    await assert.rejects(
      async () => { for await (const _ of parseSSEStream(null)) {} },
      /Stream body is null/
    );
  });
});
```

- [ ] **Step 4.2 — Run tests and confirm they fail**

```bash
node --test tests/unit/sse.test.js
```

Expected: import error — `parseSSEStream` not exported

- [ ] **Step 4.3 — Implement `parseSSEStream` in `src/llm.js`**

Add at the top of `src/llm.js`, after the constants block (after line 18):

```js
// --- SSE stream parser ---

export async function* parseSSEStream(body) {
  if (!body || typeof body.getReader !== 'function') {
    throw makeError('Stream body is null or not a ReadableStream', { retriable: false });
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline (SSE event boundary)
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith(':') || !line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') return;
          try { yield JSON.parse(raw); } catch { /* skip malformed */ }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 4.4 — Run tests and confirm they pass**

```bash
node --test tests/unit/sse.test.js
```

Expected: all 7 tests pass

- [ ] **Step 4.5 — Run all tests**

```bash
node --test 'tests/**/*.test.js'
```

Expected: all tests pass (edit + sse)

- [ ] **Step 4.6 — Commit**

```bash
git add tests/unit/sse.test.js src/llm.js && git commit -m "feat(llm): add parseSSEStream SSE parser with full test coverage"
```

---

### Task 5: `streamingApiCall` for `/responses` endpoint (Codex)

**Files:**
- Modify: `src/llm.js`

- [ ] **Step 5.1 — Add `streamingApiCall` inside `createLLMClient`**

In `createLLMClient`, after the `apiCall` function definition and before the `return` statement (before line 61), add:

```js
  async function streamingApiCall(endpoint, body, { onChunk } = {}) {
    const token = await getToken({ attempt: 0 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Declare accumulators BEFORE try so the catch block can reference them.
    // CRITICAL: do NOT call res.text() on the success path — that would consume
    // res.body before parseSSEStream can read it.
    let assembled = null;
    let partialText = '';

    try {
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...COPILOT_HEADERS,
        },
        body: JSON.stringify({ ...body, stream: true }),
      });

      // Pre-stream HTTP error handling — only read body on the ERROR path
      if (!res.ok) {
        const errText = await res.text();
        let errJson;
        try { errJson = errText ? JSON.parse(errText) : {}; } catch { errJson = {}; }
        throw classifyHttpError(res.status, errJson);
      }

      // Stream the body via parseSSEStream (res.body is a ReadableStream)
      for await (const event of parseSSEStream(res.body)) {
        if (endpoint === '/responses') {
          if (event.type === 'response.output_text.delta') {
            partialText += event.delta ?? '';
            onChunk?.({ type: 'text_delta', delta: event.delta ?? '' });
          } else if (event.type === 'response.completed') {
            assembled = event.response;
          } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
            throw makeError(event.response?.error?.message ?? 'Response failed', { retriable: false });
          }
        }
        // /chat/completions assembly added in Task 6
      }

      if (endpoint === '/responses') {
        if (!assembled) throw makeError('Stream ended without response.completed', { retriable: false });
        return assembled;
      }

      // /chat/completions: assembled in Task 6 (throws for now)
      throw makeError('streamingApiCall: /chat/completions not yet implemented', { retriable: false });
    } catch (err) {
      if (!err.partialText) err.partialText = partialText; // in scope: declared before try
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
```

Update the `return` statement at line 61 to include `streamingApiCall`:
```js
  return { apiCall, streamingApiCall, model };
```

Also add `stream_options` injection for `/chat/completions` — handled in Task 6.

- [ ] **Step 5.2 — Smoke-test that the function is importable**

```bash
node -e "import('./src/llm.js').then(m => console.log(typeof m.parseSSEStream, typeof m.createLLMClient))"
```

Expected: `function function`

- [ ] **Step 5.3 — Commit**

```bash
git add src/llm.js && git commit -m "feat(llm): add streamingApiCall skeleton with /responses SSE assembly"
```

---

### Task 6: `streamingApiCall` — `/chat/completions` assembly

**Files:**
- Modify: `src/llm.js`

- [ ] **Step 6.1 — Complete `streamingApiCall` with `/chat/completions` assembly**

Make the following changes to `streamingApiCall` in `src/llm.js`:

**6.1a — Add chat accumulator variables** alongside the existing `assembled`/`partialText` declarations that are BEFORE the `try` block:
```js
    // (existing)
    let assembled = null;
    let partialText = '';
    // add these:
    let chatContent = '';
    let chatRole = 'assistant';
    let chatToolCalls = [];
    let chatUsage = undefined;
    let chatFinishReason = undefined;
```

**6.1b — Add `stream_options` to the fetch body** (replace the existing `body: JSON.stringify({ ...body, stream: true })`):
```js
        body: JSON.stringify({
          ...body,
          stream: true,
          ...(endpoint === '/chat/completions' ? { stream_options: { include_usage: true } } : {}),
        }),
```

**6.1c — Add `/chat/completions` branch inside the SSE loop** (after the existing `/responses` block, before the closing `}`):
```js
        } else if (endpoint === '/chat/completions') {
          const delta = event?.choices?.[0]?.delta;
          if (!delta) {
            if (event?.usage) chatUsage = event.usage;
            if (event?.choices?.[0]?.finish_reason) chatFinishReason = event.choices[0].finish_reason;
            continue;
          }
          if (!chatRole && delta.role) chatRole = delta.role;
          if (delta.content) {
            chatContent += delta.content;
            onChunk?.({ type: 'text_delta', delta: delta.content });
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!chatToolCalls[idx]) chatToolCalls[idx] = { id: '', function: { name: '', arguments: '' } };
              if (tc.id) chatToolCalls[idx].id = tc.id;
              if (tc.function?.name) chatToolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) chatToolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
          if (event?.choices?.[0]?.finish_reason) chatFinishReason = event.choices[0].finish_reason;
        }
```

**6.1d — Replace the stub throw** (`throw makeError('streamingApiCall: /chat/completions not yet implemented', ...)`) after the loop with:
```js
      if (endpoint === '/chat/completions') {
        return {
          choices: [{
            message: {
              role: chatRole,
              content: chatContent || null,
              tool_calls: chatToolCalls.length ? chatToolCalls : undefined,
            },
            finish_reason: chatFinishReason,
          }],
          usage: chatUsage,
        };
      }
```

Final structure of `streamingApiCall` after this task:
1. Token + AbortController + fetch
2. `assembled`, `partialText`, `chatContent`, `chatRole`, `chatToolCalls`, `chatUsage`, `chatFinishReason` — all declared BEFORE `try`
3. Inside `try`: fetch → pre-stream error check (error path only reads body) → SSE loop → post-loop return for each endpoint

- [ ] **Step 6.2 — Smoke-test: check that the function can be called without crashing on import**

```bash
node -e "import('./src/llm.js').then(m => { const c = m.createLLMClient({ getToken: async () => 't' }); console.log(typeof c.streamingApiCall); })"
```

Expected: `function`

- [ ] **Step 6.3 — Commit**

```bash
git add src/llm.js && git commit -m "feat(llm): complete streamingApiCall with /chat/completions delta assembly"
```

---

### Task 7: Wire streaming into `runResponsesTurn` and `runChatTurn`

**Files:**
- Modify: `src/llm.js`

- [ ] **Step 7.1 — Update `runResponsesTurn` to use `streamingApiCall`**

In `runResponsesTurn`, replace both `client.apiCall('/responses', ...)` calls (at lines 84 and 125) with `client.streamingApiCall`, adding the `onChunk` callback:

For both calls, the pattern is:
```js
response = await client.streamingApiCall('/responses', {
  model, input: transcript, tools: toolsDef,
  ...(tools.length ? { tool_choice: 'auto' } : {}),
}, { onChunk: (chunk) => onStep?.({ type: 'token', text: chunk.delta }) });
```

(The initial assignment at line 84 uses `let response =`, the loop one at line 125 uses `response =`.)

- [ ] **Step 7.2 — Update `runChatTurn` to use `streamingApiCall` via updated `chatCall`**

In `runChatTurn`, add these two lines immediately after the `const isClaude = ...` line and before `let chatTools`:

```js
  const onChunk = isClaude ? null : (chunk) => onStep?.({ type: 'token', text: chunk.delta });
  if (isClaude) onStep?.({ type: 'debug', streaming: false, reason: 'provider_unsupported' });
```

Then replace the `chatCall` inner function definition with:

```js
  async function chatCall(overrideToolChoice, chunkCb = onChunk) {
    const tc = overrideToolChoice ?? defaultToolChoice;
    const body = {
      model, messages, tools: chatTools,
      ...(chatTools ? { tool_choice: tc } : {}),
    };
    if (chunkCb) {
      return client.streamingApiCall('/chat/completions', body, { onChunk: chunkCb });
    } else {
      return client.apiCall('/chat/completions', body, { onStep });
    }
  }
```

All four existing `chatCall()` call sites keep their existing arguments unchanged — they will use `chunkCb = onChunk` from the default parameter.

- [ ] **Step 7.3 — Run all existing tests to confirm no regression**

```bash
node --test 'tests/**/*.test.js'
```

Expected: all pass

- [ ] **Step 7.4 — Commit**

```bash
git add src/llm.js && git commit -m "feat(llm): wire streamingApiCall into runResponsesTurn and runChatTurn"
```

---

### Task 8: Update `agent.js`

**Files:**
- Modify: `src/agent.js`

- [ ] **Step 8.1 — Add `'token'` case to `printStep`**

In `printStep`, add before the closing `}` of the switch:
```js
    case 'token':
      process.stdout.write(step.text);
      break;
```

- [ ] **Step 8.2 — Update `runOneShot` to suppress double-print on streaming turns**

In `runOneShot`, the existing `try` block (lines ~58–73) currently has:
```js
    const result = await runTurn({
      input: prompt,
      config,
      logger,
      onStep: json ? undefined : (step) => printStep(step),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.text);
    }
```

Replace the `runTurn` call and output logic (keep the `try/finally { await stopBrain() }` wrapper unchanged) with:

```js
    let streamed = false;
    const result = await runTurn({
      input: prompt,
      config,
      logger,
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
    // if streamed: tokens already written to stdout via printStep's 'token' case
```

- [ ] **Step 8.3 — Commit**

```bash
git add src/agent.js && git commit -m "feat(agent): handle token streaming in printStep and runOneShot"
```

---

### Task 9: Update `repl.js`

**Files:**
- Modify: `src/repl.js`

- [ ] **Step 9.1 — Update main turn handler (three targeted changes)**

**Change 1:** Insert `let streamed = false;` immediately before the existing `const result = await runTurn({` at line 149.

**Change 2:** Replace `onStep: printStep,` (line 154) with:
```js
      onStep: (step) => {
        if (step.type === 'token') { streamed = true; process.stdout.write(step.text); }
        else printStep(step);
      },
```

**Change 3:** Replace lines 156–161 (`const text = result.text || '';` + the `if (text) { ... } else { ⚠ }` block) with:
```js
      const text = result.text || '';
      if (streamed) {
        process.stdout.write('\n\n');
      } else if (text) {
        console.log(`\n${renderMarkdown(text)}\n`);
      } else {
        stderr.write('\x1b[33m⚠ (empty response — model returned no text)\x1b[0m\n');
      }
```

Note: `rl.pause()` is NOT needed — the readline prompt is not active while `runTurn` awaits (prompt is only drawn when `rl.prompt()` is called, which happens after the `try/catch` completes).

- [ ] **Step 9.2 — Update slash-command path in `handleSlashCommand`**

In the `default:` branch of `handleSlashCommand` (around line 228–241), make the same pattern. The `runTurn` call is at line 231.

Add `let streamed = false;` before the `runTurn` call, replace `onStep: printStep` with the same lambda (using a local `streamed`), and replace `if (result.text) { console.log(...) }` at line 232 with:
```js
        if (streamed) {
          process.stdout.write('\n\n');
        } else if (result.text) {
          console.log(`\n${renderMarkdown(result.text)}\n`);
        }
```

- [ ] **Step 9.3 — Commit**

```bash
git add src/repl.js && git commit -m "feat(repl): stream tokens to stdout, skip renderMarkdown on streamed turns"
```

---

### Task 10: Manual smoke test

**No files to modify.**

- [ ] **Step 10.1 — Run all unit tests**

```bash
node --test 'tests/**/*.test.js'
```

Expected: all pass

- [ ] **Step 10.2 — Smoke test edit fuzzy in one-shot mode**

Create a temp file and test the edit tool:
```bash
echo "hello world  " > /tmp/test_edit.txt
node bin/claudia.js -p "Edit the file /tmp/test_edit.txt: replace 'hello world' with 'goodbye world'" 2>&1 | head -20
```

Expected: model uses the edit tool, response shows `fuzzy_applied` or `applied` status.

- [ ] **Step 10.3 — Smoke test streaming in one-shot mode**

```bash
node bin/claudia.js -p "Say hello in one sentence" 2>&1
```

Expected: text appears token by token (not all at once), no double-print.

- [ ] **Step 10.4 — Final commit**

```bash
git add -A && git status
# verify nothing unexpected staged
git commit -m "chore: finalize streaming + edit fuzzy implementation" --allow-empty-message || true
# (only if there are unstaged changes)
```

---

## Done

All tasks complete when:
- [ ] `node --test 'tests/**/*.test.js'` passes (all green)
- [ ] Streaming: first token visible within ~1–2s for Codex and GPT models
- [ ] Claude models: full response renders via `renderMarkdown` unchanged
- [ ] Edit tool: `fuzzy_applied` status returned for trailing-whitespace mismatches
- [ ] Empty `oldText`: returns `not_found` without modifying file
