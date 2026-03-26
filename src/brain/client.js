// MCP stdio client for claude-brain server
// Spawns the brain MCP server as a child process and communicates via JSON-RPC/stdio

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

// Derive paths from home directory (portable across users)
// Supports both C:\claude\ (custom install) and %USERPROFILE%\claude\ (standard)
function findBrainServerPath() {
  if (process.env.BRAIN_SERVER_PATH) return process.env.BRAIN_SERVER_PATH;

  // Try both naming conventions: hyphen and underscore
  const candidates = [
    join(homedir(), 'claude', 'claude-local-brain', 'mcp-server', 'index.js'),
    join(homedir(), 'claude', 'claude_local_brain', 'mcp-server', 'index.js'),
  ];
  if (process.platform === 'win32') {
    candidates.push('C:\\claude\\claude-local-brain\\mcp-server\\index.js');
    candidates.push('C:\\claude\\claude_local_brain\\mcp-server\\index.js');
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]; // fallback (will error at spawn time with a clear path)
}

function findBrainDataPath() {
  const homeDefault = join(homedir(), 'claude', 'claude-brain-data');
  if (existsSync(homeDefault)) return homeDefault;
  const winAlt = 'C:\\claude\\claude-brain-data';
  if (process.platform === 'win32' && existsSync(winAlt)) return winAlt;
  return homeDefault;
}

let client = null;
let transport = null;

export async function startBrain({ brainPath, brainServerPath, verbose } = {}) {
  if (client) return client;

  const serverPath = brainServerPath || findBrainServerPath();
  const dataPath = brainPath || findBrainDataPath();

  const env = {
    ...process.env,
    CLAUDE_BRAIN_PATH: dataPath,
    BRAIN_LLM_FALLBACK: process.env.BRAIN_LLM_FALLBACK || 'genailab:sonnet',
    BRAIN_LLM_FALLBACK_DISTILL: process.env.BRAIN_LLM_FALLBACK_DISTILL || 'genailab:claude',
  };

  transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env,
  });

  client = new Client({ name: 'claudia', version: '0.1.0' }, {});
  await client.connect(transport);

  if (verbose) process.stderr.write('[brain] MCP server connected\n');
  return client;
}

export async function stopBrain() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    transport = null;
  }
}

export async function callBrainTool(name, args = {}) {
  if (!client) throw new Error('Brain not started. Call startBrain() first.');
  const result = await client.callTool({ name, arguments: args });
  // MCP returns { content: [{ type: 'text', text: '...' }] }
  const text = result?.content?.map(c => c.text ?? '').join('') ?? '';
  return text;
}

// Convenience wrappers for the 4 brain tools claudia needs
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
