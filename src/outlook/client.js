// MCP stdio client for outlook-mcp server
// Spawns the Outlook MCP server and communicates via JSON-RPC/stdio

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

function findOutlookServerPath() {
  if (process.env.OUTLOOK_MCP_PATH) return process.env.OUTLOOK_MCP_PATH;

  // Look inside laia repo packages/ first
  const repoPath = join(new URL('..', import.meta.url).pathname, '..', 'packages', 'outlook-mcp', 'src', 'index.js');
  if (existsSync(repoPath)) return repoPath;

  // Fallback: standalone path under home
  const homePath = join(homedir(), 'laia-data', 'mcp-servers', 'outlook-mcp', 'src', 'index.js');
  if (existsSync(homePath)) return homePath;

  // Windows fallback
  if (process.platform === 'win32') {
    const winAlt = 'C:\\laia\\packages\\outlook-mcp\\src\\index.js';
    if (existsSync(winAlt)) return winAlt;
  }

  return repoPath;
}

let client = null;
let transport = null;

export async function startOutlook({ serverPath, verbose } = {}) {
  if (client) return client;

  const path = serverPath || findOutlookServerPath();
  if (!existsSync(path)) {
    throw new Error(`Outlook MCP server not found at: ${path}. Run: cd mcp-servers/outlook-mcp && npm install`);
  }

  transport = new StdioClientTransport({
    command: 'node',
    args: [path],
    env: { ...process.env },
  });

  client = new Client({ name: 'laia-outlook', version: '1.0.0' }, {});
  await client.connect(transport);

  if (verbose) process.stderr.write('[outlook-mcp] Connected\n');
  return client;
}

export async function stopOutlook() {
  if (transport) { await transport.close().catch(() => {}); }
  client = null;
  transport = null;
}

// Generic tool caller — calls any outlook-mcp tool by name
async function callTool(name, args = {}) {
  if (!client) await startOutlook();
  const result = await client.callTool({ name, arguments: args });
  // Extract text from MCP content array
  const texts = (result?.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text);
  return texts.join('\n');
}

// ── Exported tool functions ──────────────────────────────────────

export async function checkAuth() {
  return callTool('check_auth');
}

export async function getSchedule(date) {
  return callTool('get_schedule', date ? { date } : {});
}

export async function getEmails(folder = 'inbox', count = 20) {
  return callTool('get_emails', { folder, count });
}

export async function searchEmails(opts = {}) {
  return callTool('search_emails', opts);
}

export async function getUnreadCount() {
  return callTool('get_unread_count');
}

export async function readEmail(opts = {}) {
  return callTool('read_email', opts);
}

export async function findContact(name) {
  return callTool('find_contact', { name });
}

export async function composeDraft(opts) {
  return callTool('compose_draft', opts);
}

export async function replyEmail(index, body, reply_all = false) {
  return callTool('reply_email', { index, body, reply_all });
}

export async function forwardEmail(index, to, body = '') {
  return callTool('forward_email', { index, to: Array.isArray(to) ? to : [to], body });
}

export async function sendDraft(index, confirmed) {
  return callTool('send_draft', { index, confirmed });
}

export async function getDraftContent(opts = {}) {
  return callTool('get_draft_content', opts);
}

export async function updateDraft(opts) {
  return callTool('update_draft', opts);
}
