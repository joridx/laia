// GenAI Lab LLM client adapter
// Wraps genai_lab_chat.py as a compatible LLM client for Claudia's agent loop.
// Each "turn" serializes the full messages array into a single prompt,
// calls the Python script via stdin, and parses the response back into
// chat/completions format.

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SCRIPT_PATH = process.env.GENAILAB_SCRIPT
  || join(homedir(), '.claude', 'genai_lab_chat.py');
const PYTHON = process.env.BRAIN_GENAILAB_PYTHON || 'python3';
const TIMEOUT_MS = 90_000;

// GenAI Lab agent aliases (validated on creation)
const GENAI_AGENTS = new Set([
  'claude', 'opus', 'sonnet',
  'gpt-5', 'gpt-5.1',
  'o3', 'o3-mini', 'o3-mini-low', 'o3-mini-medium', 'o3-mini-high',
  'o4-mini', 'o4-mini-low', 'o4-mini-medium', 'o4-mini-high',
  'gpt-4.1', 'claude-37',
]);

/**
 * Create a GenAI Lab LLM client compatible with Claudia's agent loop.
 * Implements the same interface as createLLMClient: { apiCall, streamingApiCall, model, providerId, provider }
 *
 * @param {object} options
 * @param {string} [options.agent='sonnet'] - GenAI Lab agent alias
 * @param {number} [options.timeoutMs=90000] - Subprocess timeout
 * @returns {object} LLM client
 */
export function createGenAIClient({ agent = 'sonnet', timeoutMs = TIMEOUT_MS } = {}) {
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(`GenAI Lab script not found: ${SCRIPT_PATH}`);
  }
  if (!GENAI_AGENTS.has(agent)) {
    // Allow UUIDs (agent IDs passed directly) — validate format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent)) {
      const known = [...GENAI_AGENTS].join(', ');
      throw new Error(`Unknown GenAI agent: "${agent}". Known agents: ${known}`);
    }
  }

  // Provider descriptor (no quirks — GenAI Lab models handle tool_choice:auto natively)
  const provider = {
    id: 'genailab',
    auth: 'none',
    supports: { chat: true, responses: false, listModels: false },
    extraHeaders: {},
    quirks: {},
  };

  /**
   * Call genai_lab_chat.py via stdin to avoid OS ARG_MAX limits on long prompts.
   * Falls back to argv if stdin mode is not supported by the script.
   */
  function callGenAI(prompt) {
    // Strategy: pass prompt as argv (script's current interface).
    // For very long prompts (>100KB), warn — future: add stdin support to Python script.
    if (prompt.length > 100_000) {
      process.stderr.write(`\x1b[33m[genai] Warning: prompt is ${(prompt.length / 1024).toFixed(0)}KB — may hit OS arg limits\x1b[0m\n`);
    }

    const proc = spawnSync(PYTHON, [SCRIPT_PATH, prompt, agent], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    if (proc.error) {
      if (proc.error.code === 'ETIMEDOUT' || proc.error.killed) {
        throw Object.assign(new Error(`GenAI Lab timeout after ${timeoutMs}ms`), { retriable: false });
      }
      throw Object.assign(new Error(`GenAI Lab subprocess error: ${proc.error.message}`), { retriable: false });
    }

    if (proc.status !== 0) {
      const stderr = (proc.stderr || '').toLowerCase();
      if (/not authenticated|authentication|login required|sso|unauthorized/.test(stderr)) {
        throw Object.assign(
          new Error('GenAI Lab: SSO authentication expired — open GenAI Lab in Edge to refresh'),
          { retriable: false }
        );
      }
      throw Object.assign(
        new Error(`GenAI Lab exited with code ${proc.status}: ${(proc.stderr || proc.stdout || 'unknown error').slice(0, 500)}`),
        { retriable: false }
      );
    }

    const output = (proc.stdout || '').trim();
    if (!output) {
      throw Object.assign(new Error('GenAI Lab returned empty response'), { retriable: false });
    }
    return output;
  }

  /**
   * Serialize a messages array + tools into a single prompt string for GenAI Lab.
   * Preserves system prompt, conversation history, tool calls & results.
   */
  function serializeMessages(body) {
    const messages = body.messages || [];
    const tools = body.tools || [];
    const parts = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        parts.push(stringify(msg.content));
      } else if (msg.role === 'user') {
        parts.push(`[User]: ${stringify(msg.content)}`);
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls?.length) {
          const tcFormatted = msg.tool_calls.map(tc => ({
            id: tc.id,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
          parts.push(`[Assistant tool_calls]: ${JSON.stringify(tcFormatted)}`);
        }
        if (msg.content) {
          parts.push(`[Assistant]: ${stringify(msg.content)}`);
        }
      } else if (msg.role === 'tool') {
        parts.push(`[Tool result ${msg.tool_call_id}]: ${stringify(msg.content)}`);
      }
    }

    // Append tool definitions so the model knows what tools are available
    if (tools.length) {
      const toolDefs = tools.map(t => {
        const f = t.function || t;
        return `- ${f.name}: ${f.description || ''}. Parameters: ${JSON.stringify(f.parameters || {})}`;
      }).join('\n');
      parts.push(
        `\n[Available tools]:\n${toolDefs}\n\n` +
        `[IMPORTANT]: To call a tool, respond with ONLY a JSON block like:\n` +
        '```json\n{"tool_calls":[{"id":"call_1","function":{"name":"tool_name","arguments":{"arg1":"value"}}}]}\n```\n' +
        `To give a final answer without tools, respond normally with text.\n` +
        `Do NOT mix tool calls and text in the same response. Either call tools OR respond with text.`
      );
    }

    return parts.join('\n\n');
  }

  /**
   * Parse GenAI Lab's text response into chat/completions format.
   * Detects JSON tool_call blocks and converts them.
   */
  function parseResponse(text) {
    const trimmed = (text || '').trim();

    // Try to extract JSON tool_calls — check all fenced blocks
    const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
    let match;
    while ((match = fenceRegex.exec(trimmed)) !== null) {
      const toolCalls = tryParseToolCalls(match[1]);
      if (toolCalls) return buildToolCallResponse(toolCalls);
    }

    // Also try unfenced JSON (model may skip fences)
    const jsonBlockRegex = /\{[\s\S]*?"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g;
    while ((match = jsonBlockRegex.exec(trimmed)) !== null) {
      const toolCalls = tryParseToolCalls(match[0]);
      if (toolCalls) return buildToolCallResponse(toolCalls);
    }

    // Plain text response
    return {
      choices: [{
        message: { role: 'assistant', content: trimmed },
        finish_reason: 'stop',
      }],
      usage: null,
    };
  }

  /**
   * Try to parse a string as a tool_calls JSON structure.
   * Returns normalized tool_calls array or null if invalid.
   */
  function tryParseToolCalls(raw) {
    try {
      const parsed = JSON.parse(raw);
      const calls = parsed.tool_calls;
      if (!Array.isArray(calls) || calls.length === 0) return null;

      // Validate each call has the required shape
      return calls.map((tc, i) => {
        const name = tc.function?.name || tc.name;
        if (!name) return null;
        const args = tc.function?.arguments ?? tc.arguments ?? {};
        return {
          id: tc.id || `call_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          },
        };
      }).filter(Boolean);
    } catch {
      return null;
    }
  }

  function buildToolCallResponse(toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return null;
    return {
      choices: [{
        message: { role: 'assistant', content: null, tool_calls: toolCalls },
        finish_reason: 'tool_calls',
      }],
      usage: null,
    };
  }

  // Non-streaming API call
  async function apiCall(endpoint, body, { onStep, signal } = {}) {
    onStep?.({ type: 'request', phase: 'api_call' });
    const prompt = serializeMessages(body);
    const raw = callGenAI(prompt);
    return parseResponse(raw);
  }

  // "Streaming" call — emits the full text as a single chunk then returns assembled response.
  // Non-streaming underneath, but compatible with the agent loop.
  async function streamingApiCall(endpoint, body, { onChunk, signal } = {}) {
    const prompt = serializeMessages(body);
    const raw = callGenAI(prompt);
    const response = parseResponse(raw);

    // Emit text as a "stream" chunk for live display
    const text = response.choices?.[0]?.message?.content;
    if (text && onChunk) {
      onChunk({ type: 'text_delta', delta: text });
    }

    return response;
  }

  return {
    apiCall,
    streamingApiCall,
    model: `genailab:${agent}`,
    providerId: 'genailab',
    provider,
  };
}

// --- Helpers ---

/** Safely convert any content (string, array blocks, object) to string. */
function stringify(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text' || c.type === 'input_text' || c.type === 'output_text')
      .map(c => c.text || '')
      .join('\n') || JSON.stringify(content);
  }
  if (content == null) return '';
  return JSON.stringify(content);
}
