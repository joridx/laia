// Stream-JSON mode — NDJSON bidirectional protocol over stdin/stdout
// Compatible with Claude Code's stream-json format for external UI integration.
//
// Protocol:
//   stdin  ← {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
//   stdin  ← {"type":"abort"}
//   stdout → {"type":"assistant","message":{"id":"...","type":"message","role":"assistant","model":"...","content":[...]}}
//   stdout → {"type":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}
//   stdout → {"type":"result","subtype":"success","session_id":"...","usage":{...},"duration_ms":...}
//
// Usage: laia --stream-json [-m model] [--dangerously-skip-permissions]

import { randomBytes } from 'crypto';
import { createInterface } from 'readline';
import { writeSync } from 'node:fs';
import util from 'node:util';
import { createContext } from './context.js';
import { runTurn } from './agent.js';
import { setAutoApprove } from './permissions.js';
import { registerBuiltinTools } from './tools/index.js';
import { startBrain, stopBrain } from './brain/client.js';

// Read version from package.json at startup
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
let PKG_VERSION = '2.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  PKG_VERSION = pkg.version || PKG_VERSION;
} catch {}

let SESSION_ID = randomBytes(16).toString('hex');

// Allow overriding SESSION_ID for resume (set from runStreamJson before any emit)
function setSessionId(id) { SESSION_ID = id; }

// Module-level flag for clean shutdown on EPIPE or abort
let running = true;

// --- NDJSON emitter (stdout via fd 1) ---
// Uses fs.writeSync(1, ...) to bypass process.stdout (which is intercepted as a guard).

function emit(msg) {
  try {
    const line = JSON.stringify(msg) + '\n';
    writeSync(1, line);
  } catch (err) {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
      running = false; // consumer disconnected
      return;
    }
    throw err;
  }
}

// --- Console redirect (protect stdout for NDJSON) ---
// Uses util.format for proper object inspection + try/catch guard (matches mcp-server.js).

function redirectConsoleToStderr() {
  const methods = ['log', 'info', 'debug', 'warn', 'error'];
  for (const m of methods) {
    console[m] = (...args) => {
      try {
        process.stderr.write(`[${m}] ${util.format(...args)}\n`);
      } catch {
        process.stderr.write(`[${m}] (format error)\n`);
      }
    };
  }
}

// --- Stdout guard (prevent rogue writes from corrupting NDJSON stream) ---
// Any non-protocol write to stdout is trapped and redirected to stderr.

function guardStdout() {
  process.stdout.write = (chunk, encoding, cb) => {
    const preview = typeof chunk === 'string'
      ? chunk.slice(0, 200)
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8', 0, Math.min(chunk.length, 200))
        : String(chunk).slice(0, 200);
    process.stderr.write(`[stream-json] trapped non-protocol stdout: ${preview}\n`);
    if (typeof cb === 'function') cb();
    return true;
  };
}

// --- onStep → stream-json translator ---
// Emits Claude Code-compatible messages with content INSIDE message object.

export function createStepEmitter(model, _emit = emit) {
  let pendingText = '';
  let messageIdCounter = 0;
  let tokensSeen = false;

  function nextMsgId() {
    return `msg_${SESSION_ID.slice(0, 8)}_${++messageIdCounter}`;
  }

  function emitAssistant(content, stopReason = null, usage = null) {
    const msg = {
      type: 'assistant',
      message: {
        id: nextMsgId(),
        type: 'message',
        role: 'assistant',
        model: model || 'unknown',
        content,
        stop_reason: stopReason,
      },
      session_id: SESSION_ID,
    };
    // Attach usage at top level (Claude Code UI reads msg.usage)
    if (usage) msg.usage = normalizeUsage(usage);
    _emit(msg);
  }

  function flushText(stopReason = null, usage = null) {
    if (!pendingText) return;
    emitAssistant([{ type: 'text', text: pendingText }], stopReason, usage);
    pendingText = '';
  }

  return {
    onStep(step) {
      switch (step.type) {
        case 'token':
          tokensSeen = true;
          pendingText += step.text;
          // Emit incremental assistant messages for streaming visibility.
          // Flush every ~200 chars to balance granularity vs overhead.
          if (pendingText.length >= 200) flushText();
          break;

        case 'reasoning':
          // Suppress laia:* extension events in stream-json mode (Claude Code UI logs them as 'Unhandled')
          // Reasoning info is still visible via stderr logs for debugging.
          break;

        case 'tool_call':
          // Flush any accumulated text first, then emit tool_use in its own message
          flushText();
          emitAssistant([{
            type: 'tool_use',
            id: step.callId,
            name: step.name,
            input: step.args || {},
          }], 'tool_use');
          break;

        case 'tool_result': {
          // Emit as a user message with tool_result content (matching Claude Code's format)
          const resultContent = typeof step.result === 'string'
            ? step.result
            : JSON.stringify(step.result ?? null);
          const isError = (typeof step.result === 'object' && step.result !== null)
            ? (Boolean(step.result.error) || (step.name === 'bash' && Number(step.result.exitCode) !== 0))
            : false;
          _emit({
            type: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: step.callId,
              content: resultContent,
              is_error: isError,
            }],
            session_id: SESSION_ID,
          });
          break;
        }

        case 'final': {
          // Usage propagated from LLM response via the step
          const usage = step.usage || null;
          // Flush any remaining streamed text (with usage attached)
          flushText('end_turn', usage);
          // If no tokens were streamed (non-streaming provider), emit final text directly
          if (step.text && !tokensSeen) {
            pendingText = step.text;
            flushText('end_turn', usage);
          }
          // If no text at all but usage exists, emit an empty assistant message with usage
          // so the UI can track token consumption even for tool-only turns
          if (!pendingText && !tokensSeen && !step.text && usage) {
            emitAssistant([{ type: 'text', text: '' }], 'end_turn', usage);
          }
          // Reset for next turn
          tokensSeen = false;
          break;
        }

        case 'error':
          flushText();
          // Reset state on error to avoid cross-turn contamination
          tokensSeen = false;
          // Emit as system error (Claude Code compatible) instead of laia:error
          _emit({
            type: 'system',
            subtype: 'error',
            error: step.error,
            session_id: SESSION_ID,
          });
          break;

        case 'request':
          // Suppress laia:request in stream-json (API lifecycle noise)
          break;

        case 'debug':
          // Suppress laia:debug in stream-json
          break;

        default:
          // Unknown step types — suppress in stream-json (no laia:* emission)
          break;
      }
    },

    flush() {
      flushText('end_turn');
    },
  };
}

// --- Result emitter ---

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: raw.input_tokens ?? raw.prompt_tokens ?? 0,
    output_tokens: raw.output_tokens ?? raw.completion_tokens ?? 0,
    cache_creation_input_tokens: raw.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: raw.cache_read_input_tokens ?? 0,
  };
}

function emitResult(result, error = null, durationMs = 0) {
  if (error) {
    emit({
      type: 'result',
      subtype: 'error',
      error: error.message || String(error),
      session_id: SESSION_ID,
      duration_ms: durationMs,
    });
  } else {
    emit({
      type: 'result',
      subtype: 'success',
      session_id: SESSION_ID,
      usage: normalizeUsage(result?.usage),
      duration_ms: durationMs,
    });
  }
}

// --- Stdin reader (NDJSON) ---

export function parseUserMessage(msg) {
  // Accept Claude Code format: {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
  if (msg.type !== 'user') return null;

  const message = msg.message;
  if (!message) return null;

  const content = message.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const textParts = content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text);
    return textParts.join('\n') || null;
  }

  return null;
}

// --- Main loop ---

export async function runStreamJson({ config, logger, mcpConfig, maxTurns, resume, disallowedTools }) {
  // Protect stdout: redirect console, guard process.stdout.write, use fd 1 for protocol
  redirectConsoleToStderr();
  guardStdout();

  // Auto-approve tools (matching Claude Code's --dangerously-skip-permissions behavior)
  setAutoApprove(true);

  // Start brain
  try { await startBrain({ brainPath: config.brainPath }); } catch (err) {
    process.stderr.write(`[stream-json] brain start failed: ${err.message}\n`);
  }

  // Register tools (with optional disallowedTools filter)
  await registerBuiltinTools({ ...config, freeze: false, disallowedTools });

  // Connect to external MCP servers if --mcp-config provided
  let mcpCleanup = null;
  if (mcpConfig) {
    try {
      const { connectMcpServers } = await import('./mcp-client.js');
      mcpCleanup = await connectMcpServers(mcpConfig, config);
    } catch (err) {
      process.stderr.write(`[stream-json] mcp-config load failed: ${err.message}\n`);
    }
  }

  // Resume: restore session ID and context from a previous session
  let resumedData = null;
  if (resume) {
    try {
      const { loadSessionById } = await import('./session.js');
      const saved = loadSessionById(resume);
      if (saved) {
        const testCtx = createContext();
        if (testCtx.deserialize(saved)) {
          resumedData = saved;
          setSessionId(saved.sessionId || resume);  // Use canonical ID from saved data
          process.stderr.write(`[stream-json] resumed session ${SESSION_ID.slice(0, 8)}... (${saved.turns?.length ?? 0} turns)\n`);
        } else {
          process.stderr.write(`[stream-json] session ${resume.slice(0, 8)}... failed to deserialize, starting fresh\n`);
        }
      } else {
        process.stderr.write(`[stream-json] session ${resume.slice(0, 8)}... not found, starting fresh\n`);
      }
    } catch (err) {
      process.stderr.write(`[stream-json] resume failed: ${err.message}, starting fresh\n`);
    }
  }

  // Emit initial system message (includes model for consumer identification)
  emit({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    message: 'LAIA stream-json mode ready',
    version: PKG_VERSION,
    model: config.model,
  });

  // Conversation context (multi-turn)
  const context = createContext();
  if (resumedData) {
    const ok = context.deserialize(resumedData);
    if (!ok) {
      process.stderr.write('[stream-json] warning: context deserialize failed after validation\n');
    }
  }
  let turnCount = 0;

  // Read stdin line by line (NDJSON)
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  // Unified line queue — single handler, mode flag for abort interception
  const lineQueue = [];
  let lineResolve = null;
  let stdinClosed = false;
  let turnAbortController = null;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // During a turn, intercept abort messages
    if (turnAbortController) {
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'abort') {
          turnAbortController.abort();
          return;
        }
      } catch {
        // Not JSON or not abort — queue for later
      }
    }

    if (lineResolve) {
      const r = lineResolve;
      lineResolve = null;
      r(line);
    } else {
      lineQueue.push(line);
    }
  });

  rl.on('close', () => {
    if (stdinClosed) return;
    stdinClosed = true;
    if (lineResolve) {
      const r = lineResolve;
      lineResolve = null;
      r(null); // EOF
    } else {
      lineQueue.push(null); // EOF marker
    }
  });

  function nextLine() {
    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift());
    return new Promise((resolve) => { lineResolve = resolve; });
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;

    const watchdog = setTimeout(() => {
      process.stderr.write('[stream-json] shutdown watchdog fired; forcing exit\n');
      process.exitCode = 1;
      process.exit(1);
    }, 10_000);
    watchdog.unref?.();

    // Persist session for --resume support
    try {
      const { saveSession } = await import('./session.js');
      const serialized = context.serialize();
      saveSession(serialized, {
        sessionId: SESSION_ID,
        model: config.model,
        workspaceRoot: config.workspaceRoot,
      });
      process.stderr.write(`[stream-json] session saved (${SESSION_ID.slice(0, 8)}...)\n`);
    } catch (err) {
      process.stderr.write(`[stream-json] session save failed: ${err.message}\n`);
    }

    rl.close();
    try { await stopBrain(); } catch {}
    try { if (mcpCleanup) await mcpCleanup(); } catch {}

    clearTimeout(watchdog);
    process.exitCode = 0;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Catch unhandled rejections to ensure brain cleanup
  process.on('unhandledRejection', async (err) => {
    process.stderr.write(`[stream-json] unhandled rejection: ${err}\n`);
    await shutdown();
    process.exit(1);
  });

  // Main message loop
  while (running) {
    const line = await nextLine();
    if (line === null) {
      // stdin closed — clean shutdown
      running = false;
      break;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      emit({
        type: 'system',
        subtype: 'error',
        error: 'Invalid JSON on stdin',
        session_id: SESSION_ID,
      });
      continue;
    }

    // Handle ping/pong (liveness check)
    if (msg.type === 'ping') {
      emit({ type: 'pong', session_id: SESSION_ID });
      continue;
    }

    // Handle abort between turns (during turn, handled via rl.on('line') above)
    if (msg.type === 'abort') {
      emit({
        type: 'result',
        subtype: 'error',
        error: 'Aborted by user',
        session_id: SESSION_ID,
      });
      continue;
    }

    // Handle control_request: auto-approve (graceful fallback for Claude Code compat)
    if (msg.type === 'control_request') {
      emit({
        type: 'control_response',
        request_id: msg.request_id || msg.id,
        permission: 'allow',
        session_id: SESSION_ID,
      });
      continue;
    }

    // Parse user message
    const userText = parseUserMessage(msg);
    if (!userText) {
      emit({
        type: 'system',
        subtype: 'error',
        error: `Unrecognized message type or empty content: ${msg.type}`,
        session_id: SESSION_ID,
      });
      continue;
    }

    // Add to context
    context.addUser(userText);

    // Run agent turn with abort support
    const stepEmitter = createStepEmitter(config.model);
    turnAbortController = new AbortController();
    const turnStart = Date.now();

    try {
      logger.startTurn?.();
      const result = await runTurn({
        input: userText,
        config,
        logger,
        onStep: stepEmitter.onStep,
        history: context.getHistory(),
        planMode: config.planMode || false,
        effort: config.effort,
        signal: turnAbortController.signal,
      });

      // Flush any remaining buffered content
      stepEmitter.flush();

      // Record turn in context
      context.addTurn({
        assistantText: result.text,
        turnMessages: result.turnMessages,
      });

      // Compact context if needed to stay within model budget
      if (context.needsCompaction()) {
        context.compact();
      }

      const durationMs = Date.now() - turnStart;
      emitResult(result, null, durationMs);

      // Check max-turns limit
      turnCount++;
      if (maxTurns != null && turnCount >= maxTurns) {
        running = false;
        break;
      }

      // Check if EPIPE happened during emitResult
      if (!running) break;
    } catch (err) {
      stepEmitter.flush();
      const durationMs = Date.now() - turnStart;
      emitResult(null, err, durationMs);
      if (!running) break;
    } finally {
      turnAbortController = null;
    }
  }

  // Cleanup
  await shutdown();
}
