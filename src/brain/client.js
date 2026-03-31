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

// --- Path discovery (unchanged) ---

function findBrainServerPath() {
  if (process.env.BRAIN_SERVER_PATH) return process.env.BRAIN_SERVER_PATH;
  const monorepo = join(__dirname, '..', '..', 'packages', 'brain', 'index.js');
  if (existsSync(monorepo)) return monorepo;
  const global = join(homedir(), 'laia', 'packages', 'brain', 'index.js');
  if (existsSync(global)) return global;
  return monorepo;
}

function findBrainDataPath() {
  if (process.env.LAIA_BRAIN_PATH) return process.env.LAIA_BRAIN_PATH;
  const homeDefault = join(homedir(), 'laia-data');
  return homeDefault;
}

// --- Brain connection factory ---

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
  let healthy = true;
  let reconnectAttempts = 0;

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

    // Track child process health
    const childProcess = transport._process || transport.process;
    if (childProcess?.on) {
      childProcess.on('exit', (code) => {
        healthy = false;
        if (verbose) process.stderr.write(`[brain] Process exited with code ${code}\n`);
      });
    }

    await client.connect(transport);
    healthy = true;
    reconnectAttempts = 0;
    if (verbose) process.stderr.write('[brain] MCP server connected\n');
  }

  async function ensureConnected() {
    if (client && healthy) return;

    // Cleanup dead connection
    if (client) {
      try { await client.close(); } catch {}
      client = null;
      transport = null;
    }

    // Reconnect with backoff
    while (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      try {
        if (verbose) process.stderr.write(`[brain] Reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...\n`);
        await connect();
        return;
      } catch (err) {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          throw new Error(`Brain reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, RECONNECT_DELAY * reconnectAttempts));
      }
    }
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

    const callPromise = client.callTool({ name, arguments: args });
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Brain tool '${name}' timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.(); // Don't prevent process exit
    });

    const result = await Promise.race([callPromise, timeoutPromise]);
    const text = result?.content?.map(c => c.text ?? '').join('') ?? '';
    return text;
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
    /** Start the brain connection */
    start: connect,
    /** Stop the brain connection */
    stop: disconnect,
    /** Call a brain tool (auto-reconnects, with timeout) */
    call,
    /** Check if brain is connected and healthy */
    get healthy() { return healthy && client !== null; },
    /** Get data path */
    get dataPath() { return dataPath; },
    /** Get server path */
    get serverPath() { return serverPath; },
  };
}

// --- Module-level singleton for backward compatibility ---
// This will be removed when all callers migrate to createBrainConnection.

let _defaultConnection = null;

export async function startBrain(opts = {}) {
  if (_defaultConnection?.healthy) return _defaultConnection;
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

/**
 * Get the current default connection (for health checks, etc).
 * @returns {BrainConnection|null}
 */
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
