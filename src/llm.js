// LLM client for GitHub Copilot Business API
// Dual endpoint: /responses (codex models) + /chat/completions (claude, gpt-5.x)
// Node.js 24+, ESM, global fetch

const BASE_URL = 'https://api.business.githubcopilot.com';
const DEFAULT_MODEL = 'gpt-5.3-codex';
const MAX_TOOL_ITERATIONS = 15;

const COPILOT_HEADERS = {
  'Editor-Version': 'JetBrains-IC/2025.3',
  'Editor-Plugin-Version': 'copilot-intellij/1.5.66',
  'Copilot-Integration-Id': 'vscode-chat',
};

// Model routing: codex → /responses, everything else → /chat/completions
function isResponsesModel(model) {
  return /codex/i.test(model);
}

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

// --- HTTP layer ---

export function createLLMClient({ getToken, model = DEFAULT_MODEL, timeoutMs = 120_000, maxRetries = 3 } = {}) {
  if (typeof getToken !== 'function') throw new Error('getToken is required');

  async function apiCall(endpoint, body, { onStep } = {}) {
    return withRetries(async (attempt) => {
      const token = await getToken({ attempt });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        onStep?.({ type: 'request', phase: 'api_call' });

        const res = await fetch(`${BASE_URL}${endpoint}`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...COPILOT_HEADERS,
          },
          body: JSON.stringify(body),
        });

        const text = await res.text();
        let json;
        try { json = text ? JSON.parse(text) : {}; } catch {
          throw makeError(`Invalid JSON (status ${res.status})`, { status: res.status, retriable: res.status >= 500 });
        }

        if (!res.ok) throw classifyHttpError(res.status, json);
        if (json?.error) throw classifyApiError(json.error);

        return json;
      } finally {
        clearTimeout(timer);
      }
    }, { maxRetries, onStep });
  }

  async function streamingApiCall(endpoint, body, { onChunk } = {}) {
    const token = await getToken({ attempt: 0 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Declare accumulators BEFORE try so the catch block can reference them.
    // CRITICAL: do NOT call res.text() on the success path — that consumes
    // res.body before parseSSEStream can read it.
    let assembled = null;
    let partialText = '';
    let chatContent = '';
    let chatRole = 'assistant';
    let chatToolCalls = [];
    let chatUsage = undefined;
    let chatFinishReason = undefined;

    try {
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...COPILOT_HEADERS,
        },
        body: JSON.stringify({
          ...body,
          stream: true,
          ...(endpoint === '/chat/completions' ? { stream_options: { include_usage: true } } : {}),
        }),
      });

      // Pre-stream HTTP error handling — only read body on the error path
      if (!res.ok) {
        const errText = await res.text();
        let errJson;
        try { errJson = errText ? JSON.parse(errText) : {}; } catch { errJson = {}; }
        throw classifyHttpError(res.status, errJson);
      }

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
              if (!chatToolCalls[idx]) chatToolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) chatToolCalls[idx].id = tc.id;
              // name arrives in one chunk — set, don't concatenate (avoids duplication)
              if (tc.function?.name) chatToolCalls[idx].function.name = tc.function.name;
              if (tc.function?.arguments) chatToolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
          if (event?.choices?.[0]?.finish_reason) chatFinishReason = event.choices[0].finish_reason;
        }
      }

      if (endpoint === '/responses') {
        if (!assembled) throw makeError('Stream ended without response.completed', { retriable: false });
        return assembled;
      }

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
    } catch (err) {
      if (!err.partialText) err.partialText = partialText;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return { apiCall, streamingApiCall, model };
}

// --- Unified agent turn (routes to correct endpoint) ---

export async function runAgentTurn({ client, systemPrompt, userInput, history = [], tools = [], executeTool, onStep, maxIterations = MAX_TOOL_ITERATIONS } = {}) {
  const model = client.model ?? DEFAULT_MODEL;

  if (isResponsesModel(model)) {
    return runResponsesTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, onStep, maxIterations });
  } else {
    return runChatTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, onStep, maxIterations });
  }
}

// --- /responses endpoint (codex models) ---

async function runResponsesTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, onStep, maxIterations }) {
  const transcript = buildResponsesInput(systemPrompt, userInput, history);
  const toolsDef = tools.length ? tools : undefined;
  // Canonical chat-format turn messages collected for context storage
  const turnChat = [{ role: 'user', content: userInput }];

  let response = await client.streamingApiCall('/responses', {
    model, input: transcript, tools: toolsDef,
    ...(tools.length ? { tool_choice: 'auto' } : {}),
  }, { onChunk: (chunk) => onStep?.({ type: 'token', text: chunk.delta }) });

  for (let i = 0; i <= maxIterations; i++) {
    const parsed = parseResponsesOutput(response);
    for (const r of parsed.reasoning) onStep?.({ type: 'reasoning', summary: r });

    if (parsed.text) {
      onStep?.({ type: 'final', text: parsed.text });
      turnChat.push({ role: 'assistant', content: parsed.text });
      return { text: parsed.text, usage: response.usage, turnMessages: turnChat };
    }
    if (!parsed.toolCalls.length) {
      onStep?.({ type: 'final', text: '' });
      return { text: '', usage: response.usage, turnMessages: turnChat };
    }
    if (i === maxIterations) throw makeError(`Max tool iterations (${maxIterations}) reached`);

    // Append function_calls to transcript and collect in canonical chat format
    const assistantToolCalls = parsed.toolCalls.map(tc => ({
      id: tc.callId, type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    turnChat.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });

    for (const tc of parsed.toolCalls) {
      transcript.push({ type: 'function_call', call_id: tc.callId, name: tc.name, arguments: JSON.stringify(tc.args) });
    }
    for (const tc of parsed.toolCalls) {
      onStep?.({ type: 'tool_call', name: tc.name, callId: tc.callId, args: tc.args });
      let result;
      try { result = await executeTool(tc.name, tc.args, tc.callId); }
      catch (err) { result = { error: true, message: err?.message ?? String(err) }; }
      onStep?.({ type: 'tool_result', name: tc.name, callId: tc.callId, result });
      const output = serialize(result);
      transcript.push({ type: 'function_call_output', call_id: tc.callId, output });
      turnChat.push({ role: 'tool', tool_call_id: tc.callId, content: output });
    }

    response = await client.streamingApiCall('/responses', {
      model, input: transcript, tools: toolsDef,
      ...(tools.length ? { tool_choice: 'auto' } : {}),
    }, { onChunk: (chunk) => onStep?.({ type: 'token', text: chunk.delta }) });
  }
}

// --- /chat/completions endpoint (claude, gpt-5.x non-codex) ---

// Virtual "done" tool: Claude via Copilot proxy breaks tool_choice "auto" (always drops tool_calls).
// Workaround: always use "required" + give Claude a "done" tool to signal task completion.
const DONE_TOOL = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Present your FINAL answer ONLY after you have COMPLETED the task. NEVER call done() to say "I will do X" — actually DO X first using the appropriate tools (bash, read, write, etc), THEN call done() with the results. Call done() when: (1) you executed the task and have results to show, (2) the task needs no tool calls (pure question/answer), or (3) after 2-3 failed attempts — report what you tried.',
    parameters: {
      type: 'object',
      properties: { answer: { type: 'string', minLength: 1, description: 'Your complete final response with results (supports markdown). MUST be non-empty.' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
};

async function runChatTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, onStep, maxIterations }) {
  const messages = buildChatMessages(systemPrompt, userInput, history);
  // Track where the current turn starts (after system + history, at the user message)
  const turnStartIdx = messages.length - 1;
  const isClaude = /claude/i.test(model);
  const onChunk = isClaude ? null : (chunk) => onStep?.({ type: 'token', text: chunk.delta });
  if (isClaude) onStep?.({ type: 'debug', streaming: false, reason: 'provider_unsupported' });

  let chatTools;
  if (tools.length) {
    chatTools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    // Claude needs "done" tool because we always use tool_choice "required"
    if (isClaude) chatTools.push(DONE_TOOL);
  }

  // Claude: always "required" (proxy breaks "auto"). Others: "auto".
  const defaultToolChoice = isClaude && chatTools ? 'required' : 'auto';

  async function chatCall(overrideToolChoice, chunkCb = onChunk) {
    const tc = overrideToolChoice ?? defaultToolChoice;
    const body = { model, messages, tools: chatTools, ...(chatTools ? { tool_choice: tc } : {}) };
    if (chunkCb) {
      return client.streamingApiCall('/chat/completions', body, { onChunk: chunkCb });
    } else {
      return client.apiCall('/chat/completions', body, { onStep });
    }
  }

  // Build turnMessages: everything from turnStartIdx, ending with a clean assistant text message
  function buildTurnMessages(finalText) {
    const turn = messages.slice(turnStartIdx);
    // Remove any nudge system messages we injected (not useful for history)
    const cleaned = turn.filter(m => !(m.role === 'system' && m.content?.includes('Summarize your findings')));
    // Ensure last message is a clean assistant reply
    const last = cleaned[cleaned.length - 1];
    if (!last || last.role !== 'assistant' || last.tool_calls) {
      cleaned.push({ role: 'assistant', content: finalText });
    }
    return cleaned;
  }

  let response = await chatCall();

  for (let i = 0; i <= maxIterations; i++) {
    const parsed = parseChatOutput(response);

    // Check for "done" tool call — Claude's way to signal completion
    const doneTc = parsed.toolCalls.find(tc => tc.name === 'done');
    if (doneTc) {
      const finalText = (doneTc.args?.answer || '').trim() || parsed.text || '';
      if (!finalText) {
        // Claude called done() with empty answer — nudge and continue
        messages.push({
          role: 'assistant', content: null,
          tool_calls: [{ id: doneTc.callId, type: 'function', function: { name: 'done', arguments: JSON.stringify(doneTc.args) } }],
        });
        messages.push({ role: 'tool', tool_call_id: doneTc.callId, content: '{"error":"answer must not be empty. Call done() again with your full response."}' });
        response = await chatCall();
        continue;
      }
      onStep?.({ type: 'final', text: finalText });
      return { text: finalText, usage: response.usage, turnMessages: buildTurnMessages(finalText) };
    }

    if (parsed.text && !parsed.toolCalls.length) {
      onStep?.({ type: 'final', text: parsed.text });
      // Append the final assistant message so it's captured in turnMessages
      messages.push({ role: 'assistant', content: parsed.text });
      return { text: parsed.text, usage: response.usage, turnMessages: buildTurnMessages(parsed.text) };
    }
    if (!parsed.toolCalls.length) {
      onStep?.({ type: 'final', text: parsed.text || '' });
      return { text: parsed.text || '', usage: response.usage, turnMessages: buildTurnMessages(parsed.text || '') };
    }
    if (i === maxIterations) throw makeError(`Max tool iterations (${maxIterations}) reached`);

    // Append assistant message with tool_calls
    messages.push({
      role: 'assistant',
      content: parsed.text || null,
      tool_calls: parsed.toolCalls.map(tc => ({
        id: tc.callId,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });

    // Execute real tools (skip "done" — handled above)
    for (const tc of parsed.toolCalls) {
      onStep?.({ type: 'tool_call', name: tc.name, callId: tc.callId, args: tc.args });
      let result;
      try { result = await executeTool(tc.name, tc.args, tc.callId); }
      catch (err) { result = { error: true, message: err?.message ?? String(err) }; }
      onStep?.({ type: 'tool_result', name: tc.name, callId: tc.callId, result });
      messages.push({ role: 'tool', tool_call_id: tc.callId, content: serialize(result) });
    }

    // Claude: nudge towards done when approaching the limit, force done on last iteration
    if (isClaude && chatTools) {
      if (i >= maxIterations - 2) {
        messages.push({ role: 'system', content: 'You have used many tool calls. Summarize your findings and call done() with your final answer now.' });
      }
      if (i === maxIterations - 1) {
        response = await chatCall({ type: 'function', function: { name: 'done' } });
        continue;
      }
    }

    response = await chatCall();
  }
}

// --- /responses parsers ---

// Convert canonical chat-format history to /responses input items
function chatMessagesToResponsesItems(history) {
  const items = [];
  for (const msg of history) {
    if (msg.role === 'user') {
      items.push({ role: 'user', content: [{ type: 'input_text', text: msg.content ?? '' }] });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls?.length) {
        // Each tool call becomes a function_call item
        for (const tc of msg.tool_calls) {
          items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
        }
      } else if (msg.content) {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text: msg.content }] });
      }
    } else if (msg.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: msg.content ?? '' });
    }
  }
  return items;
}

function buildResponsesInput(systemPrompt, userInput, history = []) {
  const input = [];
  if (systemPrompt) input.push({ role: 'system', content: [{ type: 'input_text', text: systemPrompt }] });
  // Convert full canonical turn history to responses format
  input.push(...chatMessagesToResponsesItems(history));
  input.push({ role: 'user', content: [{ type: 'input_text', text: userInput }] });
  return input;
}

function parseResponsesOutput(resp) {
  const output = Array.isArray(resp?.output) ? resp.output : [];
  const toolCalls = [], reasoning = [];
  let text = '';

  for (const item of output) {
    if (!item) continue;
    if (item.type === 'function_call') {
      toolCalls.push({ id: item.id, callId: item.call_id, name: item.name, args: safeJson(item.arguments) });
    } else if (item.type === 'reasoning') {
      const summary = (item.summary ?? []).filter(s => s?.type === 'summary_text').map(s => s.text).join('\n').trim();
      if (summary) reasoning.push(summary);
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) { if (c?.type === 'output_text') text += c.text ?? ''; }
    }
  }
  return { toolCalls, text: text.trim(), reasoning };
}

// --- /chat/completions parsers ---

function buildChatMessages(systemPrompt, userInput, history = []) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  // Append full turn history (user, assistant with tool_calls, tool results, assistant reply)
  for (const msg of history) {
    const { ts, ...m } = msg; // strip internal timestamp field
    messages.push(m);
  }
  messages.push({ role: 'user', content: userInput });
  return messages;
}

function parseChatOutput(resp) {
  const choice = resp?.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map(tc => ({
    id: tc.id,
    callId: tc.id,
    name: tc.function?.name,
    args: safeJson(tc.function?.arguments),
  }));
  return { toolCalls, text: (msg.content ?? '').trim(), reasoning: [], finishReason: choice?.finish_reason };
}

// --- Shared utilities ---

function classifyHttpError(status, json) {
  const msg = json?.error?.message || `HTTP ${status}`;
  const code = json?.error?.code;
  if (status === 401) return makeError(`Unauthorized: ${msg}`, { status, retriable: true, reauth: true });
  if (status === 429) return makeError(`Rate limited: ${msg}`, { status, retriable: true, retryAfterMs: parseRetryAfter(json) });
  if (code === 'context_length_exceeded') return makeError(`Context too long: ${msg}`, { status, retriable: false, contextExceeded: true });
  return makeError(msg, { status, retriable: status >= 500 });
}

function classifyApiError(err) {
  if (err?.code === 'context_length_exceeded') return makeError(err.message, { retriable: false, contextExceeded: true });
  return makeError(err?.message ?? 'API error', { retriable: false });
}

async function withRetries(fn, { maxRetries, onStep }) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(attempt); }
    catch (err) {
      if (!err?.retriable || attempt >= maxRetries) {
        onStep?.({ type: 'error', error: err.message, status: err.status, retriable: false });
        throw err;
      }
      const delay = err.retryAfterMs ?? Math.min(500 * 2 ** attempt + Math.random() * 250, 10000);
      onStep?.({ type: 'error', error: err.message, retriable: true, retryInMs: delay });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function parseRetryAfter(json) {
  const ra = json?.error?.retry_after ?? json?.retry_after;
  return typeof ra === 'number' ? (ra < 1000 ? ra * 1000 : ra) : undefined;
}

function makeError(message, props = {}) {
  return Object.assign(new Error(message), props);
}

function safeJson(s) {
  try { return JSON.parse(s ?? '{}'); } catch { return {}; }
}

function serialize(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v ?? null); } catch { return '{"error":"non-serializable"}'; }
}
