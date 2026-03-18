#!/usr/bin/env node
// Test client for claudia MCP server
// Sends: initialize → notifications/initialized → tools/list → tools/call (agent)
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const server = spawn('node', ['bin/claudia.js', '--mcp', '--mcp-stdout-policy', 'redirect'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
});

const rl = createInterface({ input: server.stdout });
const pending = new Map();
let msgId = 1;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id != null && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  } else {
    // notification or server-initiated
    process.stderr.write(`[notification] ${line}\n`);
  }
});

function send(method, params) {
  return new Promise((resolve) => {
    const id = msgId++;
    pending.set(id, { resolve });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    process.stderr.write(`→ ${msg}\n`);
    server.stdin.write(msg + '\n');
  });
}

async function run() {
  // 1. initialize
  const initRes = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  });
  console.log('[initialize]', JSON.stringify(initRes.result, null, 2));

  // 2. notifications/initialized (no response expected)
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  // 3. tools/list
  const listRes = await send('tools/list', {});
  console.log('[tools/list]', JSON.stringify(listRes.result, null, 2));

  // 4. tools/call — simple prompt
  console.log('\n[tools/call agent] sending prompt...');
  const callRes = await send('tools/call', {
    name: 'agent',
    arguments: {
      prompt: 'echo "hello from claudia MCP" && echo done',
      model: 'claude-opus-4.6',
    },
  });
  console.log('[tools/call result]', JSON.stringify(callRes.result ?? callRes.error, null, 2));

  server.stdin.end();
  server.kill('SIGTERM');
  process.exit(0);
}

server.on('error', (e) => { console.error('spawn error:', e); process.exit(1); });
server.on('close', (code) => { if (pending.size) console.error('server closed with pending requests'); });

run().catch((e) => { console.error(e); process.exit(1); });
