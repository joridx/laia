// Stream-JSON mode — NDJSON bidirectional protocol over stdin/stdout
// Compatible with Claude Code's stream-json format for external UI integration.
//
// Protocol:
//   stdin  ← {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
//   stdout → {"type":"assistant","content":[{"type":"text","text":"..."}]}
//   stdout → {"type":"assistant","content":[{"type":"tool_use","id":"...","name":"...","input":{...}}]}
//   stdout → {"type":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}
//   stdout → {"type":"result","subtype":"success","session_id":"...","usage":{...}}
//
// Usage: laia --stream-json [-m model] [--mcp-config path] [--dangerously-skip-permissions]

import { randomBytes } from 'crypto';
import { createInterface } from 'readline';
import { writeSync } from 'node:fs';
import util from 'node:util';
import { createContext } from './context.js';
import { runTurn } from './agent.js';
import { setAutoApprove } from './permissions.js';
import { registerBuiltinTools } from './tools/index.js';
import { startBrain, stopBrain } from './brain/client.js';

const SESSION_ID = randomBytes(16).toString('hex');

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

function createStepEmitter() {
  let pendingText = '';
  let messageIdCounter = 0;
  let tokensSeen = false;

  function nextMsgId() {
    return `msg_${SESSION_ID.slice(0, 8)}_${++messageIdCounter}`;
  }

  function flushText() {
    if (!pendingText) return;
    emit({
      type: 'assistant',
      message: { id: nextMsgId(), role: 'assistant' },
      content: [{ type: 'text', text: pendingText }],
      session_id: SESSION_ID,
    });
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
          // Emit as a LAIA extension (consumers can ignore)
          flushText();
          emit({
            type: 'laia:reasoning',
            content: step.summary,
            session_id: SESSION_ID,
          });
          break;

        case 'tool_call':
          // Flush any accumulated text first, then emit tool_use in its own message
          flushText();
          emit({
            type: 'assistant',
            message: { id: nextMsgId(), role: 'assistant' },
            content: [{
              type: 'tool_use',
              id: step.callId,
              name: step.name,
              input: step.args || {},
            }],
            session_id: SESSION_ID,
          });
          break;

        case 'tool_result': {
          // Emit as a user message with tool_result content (matching Claude Code's format)
          const resultContent = typeof step.result === 'string'
            ? step.result
            : JSON.stringify(step.result ?? null);
          const isError = (typeof step.result === 'object' && step.result !== null)
            ? (Boolean(step.result.error) || (step.name === 'bash' && Number(step.result.exitCode) !== 0))
            : false;
          emit({
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

        case 'final':
          // Flush any remaining streamed text
          flushText();
          // If no tokens were streamed (non-streaming provider), emit final text directly
          if (step.text && !tokensSeen) {
            pendingText = step.text;
            flushText();
          }
          break;

        case 'error':
          flushText();
          emit({
            type: 'laia:error',
            error: step.error,
            retriable: step.retriable ?? false,
            session_id: SESSION_ID,
          });
          break;

        case 'request':
          // API call lifecycle — emit as extension
          emit({
            type: 'laia:request',
            phase: step.phase,
            session_id: SESSION_ID,
          });
          break;

        case 'debug':
          emit({
            type: 'laia:debug',
            content: step,
            session_id: SESSION_ID,
          });
          break;

        default:
          // Unknown step type — emit as LAIA extension for debugging
          emit({
            type: `laia:${step.type}`,
            content: step,
            session_id: SESSION_ID,
          });
          break;
      }
    },

    flush() {
      flushText();
    },

    resetTokensSeen() {
      tokensSeen = false;
    },
  };
}

// --- Result emitter ---

function emitResult(result, error = null) {
  if (error) {
    emit({
      type: 'result',
      subtype: 'error',
      error: error.message || String(error),
      session_id: SESSION_ID,
    });
  } else {
    emit({
      type: 'result',
      subtype: 'success',
      session_id: SESSION_ID,
      usage: result?.usage ?? {},
      ...(result?.turnMessages ? { laia_turn_messages: result.turnMessages.length } : {}),
    });
  }
}

// --- Stdin reader (NDJSON) ---

function parseUserMessage(msg) {
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

export async function runStreamJson({ config, logger }) {
  // Protect stdout: redirect console, guard process.stdout.write, use fd 1 for protocol
  redirectConsoleToStderr();
  guardStdout();

  // Auto-approve tools (matching Claude Code's --dangerously-skip-permissions behavior)
  setAutoApprove(true);

  // Start brain
  try { await startBrain({ brainPath: config.brainPath }); } catch (err) {
    process.stderr.write(`[stream-json] brain start failed: ${err.message}\n`);
  }

  // Register tools
  await registerBuiltinTools(config);

  // Emit initial system message
  emit({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    message: 'LAIA stream-json mode ready',
    version: '2.0.0',
  });

  // Conversation context (multi-turn)
  const context = createContext();

  // Read stdin line by line (NDJSON)
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  const lineQueue = [];
  let lineResolve = null;

  rl.on('line', (line) => {
    if (lineResolve) {
      const r = lineResolve;
      lineResolve = null;
      r(line);
    } else {
      lineQueue.push(line);
    }
  });

  rl.on('close', () => {
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

    rl.close();
    try { await stopBrain(); } catch {}

    clearTimeout(watchdog);
    process.exitCode = 0;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

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

    // Handle abort signal
    // NOTE: abort during a running turn is a known limitation — it's only
    // processed between turns. For mid-turn abort, the consumer should send
    // SIGTERM to the process. TODO: concurrent stdin reader with AbortController.
    if (msg.type === 'abort') {
      emit({
        type: 'result',
        subtype: 'error',
        error: 'Aborted by user',
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

    // Run agent turn
    const stepEmitter = createStepEmitter();
    try {
      logger.startTurn?.();
      const result = await runTurn({
        input: userText,
        config,
        logger,
        onStep: stepEmitter.onStep,
        history: context.getHistory(),
        planMode: config.planMode || false,
      });

      // Flush any remaining buffered content
      stepEmitter.flush();

      // Record turn in context
      context.addTurn({
        assistantText: result.text,
        turnMessages: result.turnMessages,
      });

      // Emit result (turn complete, ready for next input)
      emitResult(result);

      // Reset for next turn
      stepEmitter.resetTokensSeen();
    } catch (err) {
      stepEmitter.flush();
      emitResult(null, err);
    }
  }

  // Cleanup
  await shutdown();
}
