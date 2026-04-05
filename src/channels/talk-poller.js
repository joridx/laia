// src/channels/talk-poller.js — Talk polling loop for LAIA
// Sprint 2: Listens for new messages across Talk conversations
//
// Architecture:
//   talk-poller.js (this) → poll loop, message routing, state management
//   talk-client.js         → low-level API calls (already implemented)
//
// Modes:
//   - Manual: /talk-poll (one-shot check)
//   - Continuous: poller.start() (long-poll loop for daemon mode)
//
// Message routing rules:
//   - DM (1-to-1): all human messages → task queue
//   - Group (≥3): only when @mentioned → task queue
//   - System messages, own messages: ignored
//
// State: lastKnownMessageId per room, persisted to JSON file

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stderr } from 'process';
import {
  listConversations,
  pollMessages,
  sendMessage,
  filterRelevantMessages,
  cleanMessageContent,
  getLatestMessageId,
} from './talk-client.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.laia');
const STATE_FILE = join(STATE_DIR, 'talk-poll-state.json');
const POLL_INTERVAL_MS = 5_000;       // 5s between poll cycles (short-poll mode)
const LONG_POLL_TIMEOUT_S = 30;       // Server-side long-poll timeout
const MAX_MESSAGES_PER_POLL = 20;     // Prevent flood
const ROOM_TYPE_ONE_TO_ONE = 1;
const ROOM_TYPE_GROUP = 2;
const ROOM_TYPE_PUBLIC = 3;

// ─── State Management ────────────────────────────────────────────────────────

/**
 * Load poll state from disk.
 * @returns {{ rooms: Record<string, { lastId: number, lastPoll: string }> }}
 */
export function loadPollState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    stderr.write(`\x1b[33m[talk-poller] Failed to load state: ${err.message}\x1b[0m\n`);
  }
  return { rooms: {} };
}

/**
 * Save poll state to disk.
 * @param {{ rooms: Record<string, { lastId: number, lastPoll: string }> }} state
 */
export function savePollState(state) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    stderr.write(`\x1b[33m[talk-poller] Failed to save state: ${err.message}\x1b[0m\n`);
  }
}

// ─── Message Routing ─────────────────────────────────────────────────────────

/**
 * Check if bot is mentioned in a message (for group rooms).
 * @param {Object} msg — Talk message object
 * @param {string} botUser — Bot's Nextcloud username
 * @returns {boolean}
 */
export function isBotMentioned(msg, botUser) {
  if (!botUser) botUser = process.env.NC_USER;

  // Check structured mention parameters first
  if (msg.messageParameters && typeof msg.messageParameters === 'object') {
    for (const [key, param] of Object.entries(msg.messageParameters)) {
      if (/^mention-user\d+$/.test(key) && param?.id === botUser) return true;
    }
  }

  // Fallback: raw @username text check
  if (msg.message && botUser) {
    return msg.message.includes(`@${botUser}`);
  }
  return false;
}

/**
 * Route messages from a room: decide which ones LAIA should process.
 * @param {Array} messages — Raw Talk messages
 * @param {number} roomType — 1=DM, 2=Group, 3=Public
 * @param {string} botUser — Bot's NC username
 * @returns {Array<{ text: string, author: string, authorId: string, messageId: number, roomToken: string, roomType: number, roomName: string, replyTo: number|null }>}
 */
export function routeMessages(messages, roomType, botUser, roomToken, roomName) {
  const relevant = filterRelevantMessages(messages, botUser);
  const routed = [];

  for (const msg of relevant) {
    // In group rooms, only respond if @mentioned
    if ((roomType === ROOM_TYPE_GROUP || roomType === ROOM_TYPE_PUBLIC) && !isBotMentioned(msg, botUser)) {
      continue;
    }

    routed.push({
      text: cleanMessageContent(msg, botUser),
      author: msg.actorDisplayName || msg.actorId,
      authorId: msg.actorId,
      messageId: msg.id,
      roomToken,
      roomType,
      roomName: roomName || roomToken,
      replyTo: msg.id, // Reply to this message
    });
  }

  return routed;
}

// ─── One-Shot Poll ───────────────────────────────────────────────────────────

/**
 * Poll all conversations once for new messages.
 * Returns tasks to process (does NOT execute them).
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.roomTokens] — Only poll these rooms (default: all)
 * @param {boolean} [opts.initOnly] — Just initialize state, don't return messages
 * @returns {Promise<Array<{ text, author, authorId, messageId, roomToken, roomType, roomName, replyTo }>>}
 */
export async function pollOnce({ roomTokens, initOnly = false } = {}) {
  const botUser = process.env.NC_USER;
  const state = loadPollState();
  const tasks = [];

  // Get conversations
  let rooms;
  try {
    rooms = await listConversations();
  } catch (err) {
    stderr.write(`\x1b[33m[talk-poller] Failed to list rooms: ${err.message}\x1b[0m\n`);
    return [];
  }

  // Filter: only DMs and groups (skip changelog, note-to-self)
  const pollable = rooms.filter(r => {
    if (roomTokens && !roomTokens.includes(r.token)) return false;
    return [ROOM_TYPE_ONE_TO_ONE, ROOM_TYPE_GROUP, ROOM_TYPE_PUBLIC].includes(r.type);
  });

  for (const room of pollable) {
    const token = room.token;
    const roomState = state.rooms[token];

    try {
      if (!roomState || roomState.lastId == null) {
        // First time seeing this room: initialize state, don't process history
        const latestId = await getLatestMessageId(token);
        state.rooms[token] = {
          lastId: latestId || 0,
          lastPoll: new Date().toISOString(),
        };
        stderr.write(`\x1b[2m[talk-poller] Initialized ${room.displayName} (${token}) at message ${latestId}\x1b[0m\n`);
        continue;
      }

      if (initOnly) continue;

      // Poll for new messages since lastKnownMessageId
      const messages = await pollMessages(token, {
        lastKnownMessageId: roomState.lastId,
        timeout: 0, // Non-blocking for one-shot
        limit: MAX_MESSAGES_PER_POLL,
      });

      if (messages.length === 0) continue;

      // Update lastId to newest message
      const maxId = Math.max(...messages.map(m => m.id));
      state.rooms[token].lastId = maxId;
      state.rooms[token].lastPoll = new Date().toISOString();

      // Route messages
      const routed = routeMessages(messages, room.type, botUser, token, room.displayName);
      tasks.push(...routed);

      if (routed.length > 0) {
        stderr.write(`\x1b[2m[talk-poller] ${room.displayName}: ${routed.length} new task(s)\x1b[0m\n`);
      }
    } catch (err) {
      stderr.write(`\x1b[33m[talk-poller] Error polling ${room.displayName}: ${err.message}\x1b[0m\n`);
    }
  }

  // Save state
  savePollState(state);
  return tasks;
}

// ─── Continuous Poll Loop ────────────────────────────────────────────────────

/**
 * Start continuous polling. Calls onTask for each new message.
 * Designed for daemon mode (Sprint 3).
 *
 * @param {Object} opts
 * @param {Function} opts.onTask — async ({ text, author, roomToken, roomName, replyTo }) => void
 * @param {string[]} [opts.roomTokens] — Only poll these rooms
 * @param {number} [opts.intervalMs] — Poll interval (default 5000)
 * @param {AbortSignal} [opts.signal] — Abort signal to stop the loop
 * @returns {Promise<void>} — Resolves when stopped
 */
export async function startPolling({ onTask, roomTokens, intervalMs = POLL_INTERVAL_MS, signal } = {}) {
  if (!onTask) throw new Error('onTask callback required');

  stderr.write(`\x1b[2m[talk-poller] Starting continuous poll (interval: ${intervalMs}ms)\x1b[0m\n`);

  // Initialize state for all rooms first
  await pollOnce({ roomTokens, initOnly: true });

  while (!signal?.aborted) {
    try {
      const tasks = await pollOnce({ roomTokens });

      for (const task of tasks) {
        try {
          await onTask(task);
        } catch (err) {
          stderr.write(`\x1b[33m[talk-poller] onTask error: ${err.message}\x1b[0m\n`);
        }
      }
    } catch (err) {
      stderr.write(`\x1b[33m[talk-poller] Poll cycle error: ${err.message}\x1b[0m\n`);
    }

    // Wait for interval (interruptible by abort)
    if (!signal?.aborted) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, intervalMs);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  stderr.write(`\x1b[2m[talk-poller] Polling stopped\x1b[0m\n`);
}

// ─── Talk Response Helper ────────────────────────────────────────────────────

/**
 * Send a response to a Talk task (convenience wrapper).
 * @param {Object} task — Task from pollOnce/routing
 * @param {string} response — Response text
 */
export async function respondToTask(task, response) {
  return sendMessage(task.roomToken, response, { replyTo: task.replyTo });
}
