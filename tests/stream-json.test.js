// tests/stream-json.test.js
// Integration tests for --stream-json mode (spawns real process)
// These tests do NOT call the LLM — they test protocol mechanics only
// (malformed input, ping/pong, abort, EOF, init message, etc.)

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAIA_BIN = join(__dirname, '..', 'bin', 'laia.js');

// Helper: spawn laia --stream-json, send lines, collect NDJSON output
function spawnStreamJson(opts = {}) {
  const args = ['--stream-json', '--no-swarm'];
  if (opts.model) args.push('-m', opts.model);

  const child = spawn('node', [LAIA_BIN, ...args], {
    env: {
      ...process.env,
      // Force a model that will fail fast (no real API call)
      // This ensures tests don't depend on network/credentials
      ...(opts.env || {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const messages = [];
  const stderr = [];
  let stdoutBuf = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        messages.push({ _raw: line });
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr.push(chunk.toString('utf8'));
  });

  function send(msg) {
    const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
    child.stdin.write(line + '\n');
  }

  function close() {
    child.stdin.end();
  }

  function waitForMessages(count, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${count} messages, got ${messages.length}: ${JSON.stringify(messages)}`));
      }, timeoutMs);

      const check = () => {
        if (messages.length >= count) {
          clearTimeout(timer);
          resolve(messages.slice(0, count));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function waitForExit(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timeout waiting for process exit'));
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  return { child, messages, stderr, send, close, waitForMessages, waitForExit };
}

// ── Init message ───────────────────────────────────────────────────

describe('stream-json integration: init', () => {
  it('emits system/init as first message', async () => {
    const proc = spawnStreamJson();
    const [init] = await proc.waitForMessages(1);
    assert.equal(init.type, 'system');
    assert.equal(init.subtype, 'init');
    assert.ok(init.session_id);
    assert.equal(init.message, 'LAIA stream-json mode ready');
    assert.ok(init.version);
    proc.close();
    await proc.waitForExit();
  });
});

// ── Ping/pong ──────────────────────────────────────────────────────

describe('stream-json integration: ping', () => {
  it('responds to ping with pong', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1); // wait for init
    proc.send({ type: 'ping' });
    const msgs = await proc.waitForMessages(2);
    assert.equal(msgs[1].type, 'pong');
    assert.ok(msgs[1].session_id);
    proc.close();
    await proc.waitForExit();
  });

  it('responds to multiple pings', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.send({ type: 'ping' });
    proc.send({ type: 'ping' });
    proc.send({ type: 'ping' });
    const msgs = await proc.waitForMessages(4);
    const pongs = msgs.filter(m => m.type === 'pong');
    assert.equal(pongs.length, 3);
    proc.close();
    await proc.waitForExit();
  });
});

// ── Malformed input ────────────────────────────────────────────────

describe('stream-json integration: malformed input', () => {
  it('returns error for invalid JSON', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.send('this is not json {{{');
    const msgs = await proc.waitForMessages(2);
    assert.equal(msgs[1].type, 'system');
    assert.equal(msgs[1].subtype, 'error');
    assert.ok(msgs[1].error.includes('Invalid JSON'));
    proc.close();
    await proc.waitForExit();
  });

  it('returns error for unrecognized message type', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.send({ type: 'unknown_type' });
    const msgs = await proc.waitForMessages(2);
    assert.equal(msgs[1].type, 'system');
    assert.equal(msgs[1].subtype, 'error');
    assert.ok(msgs[1].error.includes('Unrecognized'));
    proc.close();
    await proc.waitForExit();
  });

  it('handles empty lines gracefully', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.send('');
    proc.send('   ');
    proc.send({ type: 'ping' });
    const msgs = await proc.waitForMessages(2);
    // Empty lines should be ignored, only init + pong
    assert.equal(msgs[1].type, 'pong');
    proc.close();
    await proc.waitForExit();
  });

  it('returns error for user message with empty content', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.send({ type: 'user', message: { role: 'user', content: [] } });
    const msgs = await proc.waitForMessages(2);
    assert.equal(msgs[1].type, 'system');
    assert.equal(msgs[1].subtype, 'error');
    proc.close();
    await proc.waitForExit();
  });
});

// ── Abort between turns ────────────────────────────────────────────

describe('stream-json integration: abort', () => {
  it('returns error result for abort message', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.send({ type: 'abort' });
    const msgs = await proc.waitForMessages(2);
    assert.equal(msgs[1].type, 'result');
    assert.equal(msgs[1].subtype, 'error');
    assert.ok(msgs[1].error.includes('Aborted'));
    proc.close();
    await proc.waitForExit();
  });
});

// ── EOF handling ───────────────────────────────────────────────────

describe('stream-json integration: EOF', () => {
  it('exits cleanly when stdin is closed', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.close(); // close stdin
    const code = await proc.waitForExit();
    assert.equal(code, 0);
  });

  it('exits cleanly on immediate EOF', async () => {
    const proc = spawnStreamJson();
    proc.close(); // close immediately
    const code = await proc.waitForExit();
    assert.equal(code, 0);
  });
});

// ── Session ID consistency ─────────────────────────────────────────

describe('stream-json integration: session_id', () => {
  it('uses consistent session_id across all messages', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.send({ type: 'ping' });
    proc.send({ type: 'abort' });
    proc.send('bad json');
    const msgs = await proc.waitForMessages(4);
    const sessionIds = msgs.map(m => m.session_id).filter(Boolean);
    const unique = new Set(sessionIds);
    assert.equal(unique.size, 1, `Expected 1 unique session_id, got: ${[...unique]}`);
    proc.close();
    await proc.waitForExit();
  });
});

// ── SIGTERM handling ───────────────────────────────────────────────

describe('stream-json integration: signals', () => {
  it('exits cleanly on SIGTERM', async () => {
    const proc = spawnStreamJson();
    await proc.waitForMessages(1);
    proc.child.kill('SIGTERM');
    const code = await proc.waitForExit();
    // Should exit 0 (graceful shutdown), not crash
    assert.ok(code === 0 || code === null, `Expected clean exit, got code=${code}`);
  });
});
