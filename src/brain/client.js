// MCP stdio client for laia-brain server
// Spawns the brain MCP server as a child process and communicates via JSON-RPC/stdio
//
// V2: Factory function (no module-level singletons), auto-reconnect, timeout, health tracking.
// Refactor #2 from Codex architecture review.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CALL_TIMEOUT = 30_000;  // 30s per tool call
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 500; // ms

// --- Path discovery ---

function findBrainServerPath() {
  if (process.env.BRAIN_SERVER_PATH) return process.env.BRAIN_SERVER_PATH;
  const monorepo = join(__dirname, '..', '..', 'packages', 'brain', 'index.js');
  if (existsSync(monorepo)) return monorepo;
  const global = join(homedir(), 'laia', 'packages', 'brain', 'index.js');
  if (existsSync(global)) return global;
  throw new Error(`Brain server not found at ${monorepo} or ${global}. Set BRAIN_SERVER_PATH env var.`);
}

function findBrainDataPath() {
  if (process.env.LAIA_BRAIN_PATH) return process.env.LAIA_BRAIN_PATH;
  return join(homedir(), 'laia-data');
}

// --- Timeout helper ---

async function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// --- Brain connection factory ---

/**
 * @typedef {Object} BrainConnection
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(name: string, args?: object, opts?: {timeoutMs?: number}) => Promise<string>} call
 * @property {boolean} healthy
 * @property {string} dataPath
 * @property {string} serverPath
 */

/**
 * Create a brain connection instance. Not a singleton — caller manages lifecycle.
 * @param {object} opts
 * @param {string} [opts.brainPath] - Brain data directory
 * @param {string} [opts.brainServerPath] - Path to brain MCP server entry point
 * @param {boolean} [opts.verbose] - Forward brain stderr to terminal
 * @returns {BrainConnection}
 */
export function createBrainConnection({ brainPath, brainServerPath, verbose } = {}) {
  const serverPath = brainServerPath || findBrainServerPath();
  const dataPath = brainPath || findBrainDataPath();

  let client = null;
  let transport = null;
  let healthy = false;
  let connectingPromise = null;  // Concurrency guard (#2 fix)

  const env = {
    ...process.env,
    LAIA_BRAIN_PATH: dataPath,
    BRAIN_LLM_FALLBACK: process.env.BRAIN_LLM_FALLBACK || 'bedrock:haiku',
    BRAIN_LLM_FALLBACK_DISTILL: process.env.BRAIN_LLM_FALLBACK_DISTILL || 'bedrock:haiku',
    BRAIN_QUIET: '1',
  };

  async function connect() {
    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env,
      stderr: 'pipe',
    });

    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => {
        if (verbose) process.stderr.write(`[brain:stderr] ${chunk}`);
      });
    }

    client = new Client({ name: 'laia', version: '2.0.0' }, {});

    await client.connect(transport);

    // Track child process health (best-effort — _process is private but standard in StdioClientTransport)
    const childProcess = transport._process || transport.process;
    if (childProcess?.on) {
      childProcess.on('exit', (code) => {
        healthy = false;
        if (verbose) process.stderr.write(`[brain] Process exited with code ${code}\n`);
      });
    }

    healthy = true;
    if (verbose) process.stderr.write('[brain] MCP server connected\n');
  }

  async function ensureConnected() {
    if (client && healthy) return;

    // Concurrency guard: if already reconnecting, wait for that attempt (#2 fix)
    if (connectingPromise) return connectingPromise;

    connectingPromise = (async () => {
      try {
        // Cleanup dead connection
        if (client) {
          try { await client.close(); } catch {}
          client = null;
          transport = null;
        }

        // Reconnect with backoff
        let attempts = 0;  // Local counter — reset per ensureConnected call (#3 fix)
        while (attempts < MAX_RECONNECT_ATTEMPTS) {
          attempts++;
          try {
            if (verbose) process.stderr.write(`[brain] Reconnecting (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})...\n`);
            await connect();
            return;
          } catch (err) {
            if (attempts >= MAX_RECONNECT_ATTEMPTS) {
              throw new Error(`Brain reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, RECONNECT_DELAY * attempts));
          }
        }
        // Should not reach here, but safety net (#3 fix)
        throw new Error('Brain reconnect exhausted');
      } finally {
        connectingPromise = null;
      }
    })();

    return connectingPromise;
  }

  /**
   * Call a brain MCP tool with timeout and auto-reconnect.
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] - Call timeout (default: 30s)
   * @returns {Promise<string>}
   */
  async function call(name, args = {}, { timeoutMs = DEFAULT_CALL_TIMEOUT } = {}) {
    await ensureConnected();

    try {
      const result = await withTimeout(
        client.callTool({ name, arguments: args }),
        timeoutMs,
        `Brain tool '${name}'`
      );
      const text = result?.content?.map(c => c.text ?? '').join('') ?? '';
      return text;
    } catch (err) {
      // Mark unhealthy on transport errors so next call triggers reconnect (#5 fix)
      if (err.code === 'EPIPE' || err.code === 'ERR_IPC_CHANNEL_CLOSED' ||
          err.message?.includes('timed out') || err.message?.includes('closed') ||
          err.message?.includes('EPIPE')) {
        healthy = false;
      }
      throw err;
    }
  }

  async function disconnect() {
    if (client) {
      try { await client.close(); } catch {}
      client = null;
      transport = null;
      healthy = false;
    }
  }

  return {
    start: connect,
    stop: disconnect,
    call,
    get healthy() { return healthy && client !== null; },
    get dataPath() { return dataPath; },
    get serverPath() { return serverPath; },
  };
}

// --- Module-level singleton for backward compatibility ---

let _defaultConnection = null;

export async function startBrain(opts = {}) {
  if (_defaultConnection?.healthy) return _defaultConnection;
  // If a dead connection exists, clean it up first (#6 TOCTOU fix)
  if (_defaultConnection && !_defaultConnection.healthy) {
    await _defaultConnection.stop();
    _defaultConnection = null;
  }
  _defaultConnection = createBrainConnection(opts);
  await _defaultConnection.start();
  return _defaultConnection;
}

export async function stopBrain() {
  if (_defaultConnection) {
    await _defaultConnection.stop();
    _defaultConnection = null;
  }
}

export async function callBrainTool(name, args = {}) {
  if (!_defaultConnection) throw new Error('Brain not started. Call startBrain() first.');
  return _defaultConnection.call(name, args);
}

export function getDefaultConnection() {
  return _defaultConnection;
}

// --- Convenience wrappers ---

export async function brainSearch(query, opts = {}) {
  return callBrainTool('brain_search', { query, ...opts });
}

export async function brainRemember(learnings) {
  if (Array.isArray(learnings)) {
    return callBrainTool('brain_remember', { learnings });
  }
  return callBrainTool('brain_remember', learnings);
}

export async function brainGetContext(opts = {}) {
  return callBrainTool('brain_get_context', opts);
}

export async function brainLogSession(summary, tags) {
  return callBrainTool('brain_log_session', { summary, tags });
}

export async function brainFeedback(args) {
  return callBrainTool('brain_feedback', args);
}
