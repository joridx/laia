// LLM client — multi-provider support via @laia/providers
// Dual endpoint: /responses (codex models) + /chat/completions (claude, gpt-5.x)
// Node.js 24+, ESM, global fetch

import {
  PROVIDERS, getProvider, detectProvider, getBaseUrl,
  buildAuthHeaders, resolveUrl,
} from '@laia/providers';

const DEFAULT_MODEL = 'gpt-5.3-codex';
const MAX_TOOL_ITERATIONS = 100;

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
          try { yield JSON.parse(raw); } catch (e) { console.debug('[parseSSEStream] Malformed SSE data:', raw, e); }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// --- HTTP layer ---

export function createLLMClient({ getToken, model = DEFAULT_MODEL, timeoutMs = 300_000, maxRetries = 3, providerId } = {}) {
  if (typeof getToken !== 'function') throw new Error('getToken is required');

  // Resolve provider from model if not explicitly passed
  const resolved = providerId ? { providerId, model } : detectProvider(model);
  const provider = getProvider(resolved.providerId);

  async function apiCall(endpoint, body, { onStep, signal: externalSignal } = {}) {
    return withRetries(async (attempt) => {
      const token = await getToken({ attempt });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;

      try {
        onStep?.({ type: 'request', phase: 'api_call' });

        const url = resolveUrl(provider, endpoint);
        const authHeaders = buildAuthHeaders(provider, token);
        const res = await fetch(url, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
            ...provider.extraHeaders,
          },
          body: JSON.stringify(body),
        });

        const text = await res.text();
        let json;
        try { json = text ? JSON.parse(text) : {}; } catch {
          if (!res.ok) throw classifyHttpError(res.status, {});
          throw makeError(`Invalid JSON (status ${res.status})`, { status: res.status, retriable: false });
        }

        if (!res.ok) throw classifyHttpError(res.status, json);
        if (json?.error) throw classifyApiError(json.error);

        return json;
      } finally {
        clearTimeout(timer);
      }
    }, { maxRetries, onStep });
  }

  async function streamingApiCall(endpoint, body, { onChunk, signal: externalSignal } = {}) {
    return withRetries(async (attempt) => {
      const token = await getToken({ attempt });
      const controller = new AbortController();
      // Reset timer on each SSE chunk (keep-alive). This prevents abort during
      // long-running streaming responses where chunks arrive steadily.
      let timer = setTimeout(() => controller.abort(), timeoutMs);
      const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeoutMs); };
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;

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
        const url = resolveUrl(provider, endpoint);
        const authHeaders = buildAuthHeaders(provider, token);

        const res = await fetch(url, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
            ...provider.extraHeaders,
          },
          body: JSON.stringify({
            ...body,
            stream: true,
            ...(endpoint === '/chat/completions' || endpoint === 'chat/completions'
              ? { stream_options: { include_usage: true } } : {}),
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
          resetTimer();  // keep-alive: reset abort timer on each SSE chunk
          if (endpoint === '/responses' || endpoint === 'responses') {
            if (event.type === 'response.output_text.delta') {
              partialText += event.delta ?? '';
              onChunk?.({ type: 'text_delta', delta: event.delta ?? '' });
            } else if (event.type === 'response.completed') {
              assembled = event.response;
            } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
              throw makeError(event.response?.error?.message ?? 'Response failed', { retriable: false });
            }
          } else {
            // chat/completions SSE parsing
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

        if (endpoint === '/responses' || endpoint === 'responses') {
          if (!assembled) throw makeError('Stream ended without response.completed', { retriable: false });
          return assembled;
        }

        // chat/completions assembled response
        return {
          choices: [{
            message: {
              role: chatRole,
              content: chatContent || null,
              tool_calls: chatToolCalls.length ? chatToolCalls.filter(Boolean) : undefined,
            },
            finish_reason: chatFinishReason,
          }],
          usage: chatUsage,
        };
      } catch (err) {
        if (!err.partialText) err.partialText = partialText;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }, { maxRetries });
  }

  return { apiCall, streamingApiCall, model, providerId: resolved.providerId, provider };
}

// --- Unified agent turn (routes to correct endpoint) ---

export async function runAgentTurn({ client, systemPrompt, userInput, history = [], tools = [], executeTool, executeToolBatch, onStep, maxIterations = MAX_TOOL_ITERATIONS, signal, effort } = {}) {
  const model = client.model ?? DEFAULT_MODEL;

  if (isResponsesModel(model)) {
    return runResponsesTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, executeToolBatch, onStep, maxIterations, signal, effort });
  } else {
    return runChatTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, executeToolBatch, onStep, maxIterations, signal, effort });
  }
}

// --- Tool execution helpers ---

// Sequential tool execution (default)
async function runToolsSequential(toolCalls, executeTool, onStep) {
  const results = [];
  for (const tc of toolCalls) {
    onStep?.({ type: 'tool_call', name: tc.name, callId: tc.callId, args: tc.args });
    let result;
    try { result = await executeTool(tc.name, tc.args, tc.callId); }
    catch (err) { result = { error: true, message: err?.message ?? String(err) }; }
    onStep?.({ type: 'tool_result', name: tc.name, callId: tc.callId, result });
    results.push({ tc, result });
  }
  return results;
}

// Batch tool execution (swarm mode — parallel agent calls)
async function runToolsBatch(toolCalls, executeToolBatch, onStep) {
  for (const tc of toolCalls) onStep?.({ type: 'tool_call', name: tc.name, callId: tc.callId, args: tc.args });
  const batchResults = await executeToolBatch(toolCalls);
  return toolCalls.map((tc, i) => {
    const result = (batchResults && batchResults[i] && batchResults[i].result !== undefined)
      ? batchResults[i].result
      : { error: true, message: 'no result from batch' };
    onStep?.({ type: 'tool_result', name: tc.name, callId: tc.callId, result });
    return { tc, result };
  });
}

// --- /responses endpoint (codex models) ---

async function runResponsesTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, executeToolBatch, onStep, maxIterations, signal, effort }) {
  const transcript = buildResponsesInput(systemPrompt, userInput, history);
  const toolsDef = tools.length ? tools : undefined;
  // Canonical chat-format turn messages collected for context storage
  const turnChat = [{ role: 'user', content: userInputText(userInput) }];

  // V2: Effort param for /responses → reasoning.effort
  const effortParam = effort ? { reasoning: { effort } } : {};

  let response = await client.streamingApiCall('/responses', {
    model, input: transcript, tools: toolsDef,
    ...(tools.length ? { tool_choice: 'auto' } : {}),
    ...effortParam,
  }, { onChunk: (chunk) => onStep?.({ type: 'token', text: chunk.delta }), signal });

  for (let i = 0; i <= maxIterations; i++) {
    const parsed = parseResponsesOutput(response);
    for (const r of parsed.reasoning) onStep?.({ type: 'reasoning', summary: r });

    if (parsed.text) {
      onStep?.({ type: 'final', text: parsed.text, usage: response.usage });
      turnChat.push({ role: 'assistant', content: parsed.text });
      return { text: parsed.text, usage: response.usage, turnMessages: turnChat };
    }
    if (!parsed.toolCalls.length) {
      onStep?.({ type: 'final', text: '', usage: response.usage });
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

    const TOOL_TIMEOUT_MS = 60000;
async function withTimeout(promise, ms, name, callId) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool call timed out (${name}, callId ${callId}) after ${ms}ms`)), ms))
  ]);
}
const toolResults = executeToolBatch
      ? await runToolsBatch(parsed.toolCalls, async (toolCalls) => Promise.all(toolCalls.map(tc => withTimeout(executeToolBatch([tc]), TOOL_TIMEOUT_MS, tc.name, tc.callId))), onStep)
      : await runToolsSequential(parsed.toolCalls, (name, args, callId) => withTimeout(executeTool(name, args, callId), TOOL_TIMEOUT_MS, name, callId), onStep);

    for (const { tc, result } of toolResults) {
      const output = serialize(result);
      transcript.push({ type: 'function_call_output', call_id: tc.callId, output });
      turnChat.push({ role: 'tool', tool_call_id: tc.callId, content: output });
    }

    response = await client.streamingApiCall('/responses', {
      model, input: transcript, tools: toolsDef,
      ...(tools.length ? { tool_choice: 'auto' } : {}),
    }, { onChunk: (chunk) => onStep?.({ type: 'token', text: chunk.delta }), signal });
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

async function runChatTurn({ client, model, systemPrompt, userInput, history, tools, executeTool, executeToolBatch, onStep, maxIterations, signal, effort }) {
  const messages = buildChatMessages(systemPrompt, userInput, history);
  // Track where the current turn starts (after system + history, at the user message)
  const turnStartIdx = messages.length - 1;

  // Provider-aware quirks: use provider.quirks instead of model-name heuristic
  const quirks = client.provider?.quirks || {};
  const needsDoneTool = quirks.forceToolChoiceRequired || false;
  const disableStreaming = quirks.disableStreamingForClaude && /claude/i.test(model);

  const onChunk = disableStreaming ? null : (chunk) => onStep?.({ type: 'token', text: chunk.delta });
  if (disableStreaming) onStep?.({ type: 'debug', streaming: false, reason: 'provider_unsupported' });

  let chatTools;
  if (tools.length) {
    chatTools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    // Add "done" tool when provider requires tool_choice "required" (Copilot proxy quirk)
    if (needsDoneTool) chatTools.push(DONE_TOOL);
  }

  // Provider quirk: "required" when proxy breaks "auto". Others: "auto".
  const defaultToolChoice = needsDoneTool && chatTools ? 'required' : 'auto';

  async function chatCall(overrideToolChoice, chunkCb = onChunk) {
    const tc = overrideToolChoice ?? defaultToolChoice;
    const body = { model, messages, tools: chatTools, ...(chatTools ? { tool_choice: tc } : {}), ...(effort ? { reasoning_effort: effort } : {}) };
    if (chunkCb) {
      return client.streamingApiCall('/chat/completions', body, { onChunk: chunkCb, signal });
    } else {
      return client.apiCall('/chat/completions', body, { onStep, signal });
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
      onStep?.({ type: 'final', text: finalText, usage: response.usage });
      return { text: finalText, usage: response.usage, turnMessages: buildTurnMessages(finalText) };
    }

    if (parsed.text && !parsed.toolCalls.length) {
      onStep?.({ type: 'final', text: parsed.text, usage: response.usage });
      // Append the final assistant message so it's captured in turnMessages
      messages.push({ role: 'assistant', content: parsed.text });
      return { text: parsed.text, usage: response.usage, turnMessages: buildTurnMessages(parsed.text) };
    }
    if (!parsed.toolCalls.length) {
      onStep?.({ type: 'final', text: parsed.text || '', usage: response.usage });
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
    const toolResults = executeToolBatch
      ? await runToolsBatch(parsed.toolCalls, executeToolBatch, onStep)
      : await runToolsSequential(parsed.toolCalls, executeTool, onStep);

    for (const { tc, result } of toolResults) {
      messages.push({ role: 'tool', tool_call_id: tc.callId, content: serialize(result) });
    }

    // Nudge towards done when approaching the limit (only with done tool)
    if (needsDoneTool && chatTools) {
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

// --- Multimodal content helpers ---

function toUserContentChat(userInput) {
  if (typeof userInput === 'string') return userInput;
  const text = userInput?.text ?? '';
  const images = Array.isArray(userInput?.images) ? userInput.images : [];
  if (!images.length) return text;
  const parts = [];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
  }
  parts.push({ type: 'text', text });
  return parts;
}

function toUserContentResponses(userInput) {
  if (typeof userInput === 'string') return [{ type: 'input_text', text: userInput }];
  const text = userInput?.text ?? '';
  const images = Array.isArray(userInput?.images) ? userInput.images : [];
  const parts = [];
  for (const img of images) {
    parts.push({ type: 'input_image', image_url: `data:${img.mimeType};base64,${img.base64}` });
  }
  parts.push({ type: 'input_text', text });
  return parts;
}

function userInputText(userInput) {
  return typeof userInput === 'string' ? userInput : (userInput?.text ?? '');
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
  input.push({ role: 'user', content: toUserContentResponses(userInput) });
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
  messages.push({ role: 'user', content: toUserContentChat(userInput) });
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
  if (status === 429) {
    // Distinguish daily quota exhaustion (no point retrying) from per-minute rate limits
    const isDailyQuota = /PerDay|daily/i.test(msg);
    if (isDailyQuota) return makeError(`Daily quota exhausted for this model. Try another model with /model`, { status, retriable: false });
    // "Request too large" means the request itself exceeds TPM — no retry will help, fallback needed
    const tooLarge = /request too large|Requested \d+/i.test(msg) && !/retry/i.test(msg);
    if (tooLarge) return makeError(`Rate limited: ${msg}`, { status, retriable: true, retryAfterMs: undefined });
    return makeError(`Rate limited: ${msg}`, { status, retriable: true, retryAfterMs: parseRetryAfter(json) });
  }
  if (status === 413) return makeError(`Request too large: ${msg}`, { status, retriable: false });
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
      // For 429 rate limits: only retry if the retry-after delay is short (< 30s).
      // If the API says "wait 10s" it's a per-minute reset — worth retrying.
      // If there's no retry-after or it's a TPM issue with big requests, bubble up
      // immediately so the fallback chain in agent.js can try another model.
      const is429 = err?.status === 429;
      const retryDelay = err?.retryAfterMs;
      const worthRetrying = is429 && retryDelay && retryDelay < 30_000;
      const effectiveMax = worthRetrying ? Math.max(maxRetries, 3) : maxRetries;

      if (!err?.retriable || attempt >= effectiveMax) {
        onStep?.({ type: 'error', error: err.message, status: err.status, retriable: false });
        throw err;
      }
      const delay = retryDelay ?? Math.min(500 * 2 ** attempt + Math.random() * 250, 10000);
      const secs = (delay / 1000).toFixed(1);
      onStep?.({ type: 'error', error: `Rate limited — retry ${attempt + 1}/${effectiveMax} in ${secs}s...`, retriable: true, retryInMs: delay });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function parseRetryAfter(json) {
  // Explicit field (OpenAI, Groq)
  const ra = json?.error?.retry_after ?? json?.retry_after;
  if (typeof ra === 'number') return ra < 1000 ? ra * 1000 : ra;
  // Google embeds "Please retry in 10.2s" in the error message
  const msg = json?.error?.message ?? json?.message ?? '';
  const match = msg.match(/retry in ([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  return undefined;
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
