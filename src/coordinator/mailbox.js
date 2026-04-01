// src/phase4/mailbox.js — Inter-agent messaging (SendMessage equivalent)
// Inspired by Claude Code's src/tools/SendMessageTool/
// Simple mailbox: agents can send messages to named peers.

import { stderr } from 'process';

// ─── Mailbox ─────────────────────────────────────────────────────────────────
// Per-agent message queue. Messages are delivered when the agent next checks.

const mailboxes = new Map(); // agentName → [{ from, message, ts }]
const agentRegistry = new Map(); // agentName → { workerId, status }

const MAX_QUEUE_LEN = 100; // max messages per agent
const MAX_MESSAGE_BYTES = 10_000; // max message size

/**
 * Register an agent as addressable.
 */
export function registerAgent(name, workerId) {
  agentRegistry.set(name, { workerId, status: 'active', registeredAt: Date.now() });
  if (!mailboxes.has(name)) mailboxes.set(name, []);
}

/**
 * Unregister an agent.
 */
export function unregisterAgent(name) {
  agentRegistry.delete(name);
  // Keep mailbox for late delivery inspection
}

/**
 * Send a message to a named agent.
 * @param {string} from - Sender name
 * @param {string} to - Recipient name, or "*" for broadcast
 * @param {string} message - Message content
 * @returns {{ delivered: boolean, to: string|string[], error?: string }}
 */
export function sendMessage(from, to, message) {
  if (!message) return { delivered: false, to, error: 'Empty message' };

  // Truncate oversized messages
  const safeMsg = typeof message === 'string'
    ? message.slice(0, MAX_MESSAGE_BYTES)
    : JSON.stringify(message).slice(0, MAX_MESSAGE_BYTES);

  const envelope = {
    from,
    message: safeMsg,
    ts: Date.now(),
  };

  // Broadcast
  if (to === '*') {
    const recipients = [];
    for (const [name, _] of agentRegistry) {
      if (name !== from) {
        if (!mailboxes.has(name)) mailboxes.set(name, []);
        mailboxes.get(name).push({ ...envelope });
        recipients.push(name);
      }
    }
    stderr.write(`\x1b[2m[mailbox] ${from} → * (${recipients.length} recipients)\x1b[0m\n`);
    return { delivered: recipients.length > 0, to: recipients };
  }

  // Direct message
  if (!agentRegistry.has(to)) {
    return { delivered: false, to, error: `Agent '${to}' not found. Available: ${[...agentRegistry.keys()].join(', ') || '(none)'}` };
  }

  if (!mailboxes.has(to)) mailboxes.set(to, []);
  const box = mailboxes.get(to);
  if (box.length >= MAX_QUEUE_LEN) box.shift(); // Evict oldest
  box.push(envelope);
  stderr.write(`\x1b[2m[mailbox] ${from} → ${to}\x1b[0m\n`);
  return { delivered: true, to };
}

/**
 * Check mailbox for pending messages.
 * @param {string} name - Agent name
 * @param {boolean} [consume=true] - Remove messages after reading
 * @returns {{ from, message, ts }[]}
 */
export function checkMailbox(name, consume = true) {
  const box = mailboxes.get(name);
  if (!box || box.length === 0) return [];

  if (consume) {
    const messages = [...box];
    box.length = 0;
    return messages;
  }
  return [...box];
}

/**
 * List all registered agents.
 */
export function listAgents() {
  return [...agentRegistry.entries()].map(([name, info]) => ({
    name,
    ...info,
  }));
}

/**
 * Get mailbox status for all agents.
 */
export function getMailboxStatus() {
  const status = {};
  for (const [name, box] of mailboxes) {
    status[name] = {
      pending: box.length,
      registered: agentRegistry.has(name),
    };
  }
  return status;
}

/**
 * Create the send_message tool schema for LLM.
 */
export function getSendMessageSchema() {
  return {
    type: 'function',
    name: 'send_message',
    description: 'Send a message to another agent. Use agent names (not IDs). Use "*" to broadcast to all agents.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient: agent name, or "*" for broadcast to all',
        },
        message: {
          type: 'string',
          description: 'Message content',
        },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  };
}

/**
 * Execute send_message tool call.
 * @param {object} args - { to, message }
 * @param {string} senderName - Name of the calling agent
 */
export function executeSendMessage(args, senderName = 'coordinator') {
  const { to, message } = args;
  return sendMessage(senderName, to, message);
}
