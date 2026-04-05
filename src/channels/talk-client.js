// src/channels/talk-client.js — Nextcloud Talk API client for LAIA
// Sprint 2a: Talk integration
//
// Adapted from Istota's talk.py (451 LOC Python → ~200 LOC JS)
// Uses user API (not bot API) — LAIA is a regular NC user
//
// API endpoints: /ocs/v2.php/apps/spreed/api/v1/chat/... (messaging)
//                /ocs/v2.php/apps/spreed/api/v4/room/...  (rooms)

// ─── Constants ───────────────────────────────────────────────────────────────

const TALK_MSG_MAX = 4000;   // Talk's max message length
const DEFAULT_TIMEOUT = 15_000; // 15s for short API calls
const OCS_HEADERS = {
  'OCS-APIRequest': 'true',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getConfig() {
  const url = process.env.NC_URL;
  const user = process.env.NC_USER;
  const pass = process.env.NC_PASS;
  if (!url || !user || !pass) {
    throw new Error('Missing NC_URL, NC_USER, or NC_PASS environment variables');
  }
  return {
    baseUrl: url.replace(/\/$/, ''),
    auth: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    user,
  };
}

function ocsData(json) {
  return json?.ocs?.data ?? null;
}

async function ocsRequest(method, path, { body, params, timeout = DEFAULT_TIMEOUT } = {}) {
  const { baseUrl, auth } = getConfig();
  const url = new URL(`${baseUrl}/ocs/v2.php${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url.toString(), {
      method,
      headers: { ...OCS_HEADERS, Authorization: auth },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    // 304 = no new messages (long-poll timeout) — not an error
    if (resp.status === 304) return { status: 304, data: [] };

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Talk API ${method} ${path} → ${resp.status}: ${text.slice(0, 200)}`);
    }

    const json = await resp.json();
    return { status: resp.status, data: ocsData(json) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Room / Conversation API (v4) ───────────────────────────────────────────

/**
 * List all conversations the user is part of.
 * @returns {Promise<Array>}
 */
export async function listConversations() {
  const { data } = await ocsRequest('GET', '/apps/spreed/api/v4/room');
  return data || [];
}

/**
 * Create or get a 1-to-1 conversation with another user.
 * If already exists, Nextcloud returns the existing one.
 * @param {string} targetUser — Nextcloud user ID
 * @returns {Promise<{token: string, displayName: string}>}
 */
export async function createOneToOne(targetUser) {
  const { data } = await ocsRequest('POST', '/apps/spreed/api/v4/room', {
    body: { roomType: 1, invite: targetUser },
  });
  return data;
}

/**
 * Create a group conversation.
 * @param {string} name — Room display name
 * @returns {Promise<{token: string}>}
 */
export async function createGroup(name) {
  const { data } = await ocsRequest('POST', '/apps/spreed/api/v4/room', {
    body: { roomType: 2, roomName: name },
  });
  return data;
}

/**
 * Get conversation info (displayName, type, etc.)
 * @param {string} token — Conversation token
 */
export async function getConversation(token) {
  const { data } = await ocsRequest('GET', `/apps/spreed/api/v4/room/${token}`);
  return data;
}

/**
 * Get participants of a conversation.
 * @param {string} token — Conversation token
 */
export async function getParticipants(token) {
  const { data } = await ocsRequest('GET', `/apps/spreed/api/v4/room/${token}/participants`);
  return data || [];
}

// ─── Chat API (v1) ──────────────────────────────────────────────────────────

/**
 * Send a message to a conversation. Auto-splits if >4000 chars.
 * @param {string} token — Conversation token
 * @param {string} message — Message content
 * @param {Object} [opts]
 * @param {number} [opts.replyTo] — Message ID to reply to
 * @returns {Promise<Array<Object>>} — Array of sent message(s)
 */
export async function sendMessage(token, message, { replyTo } = {}) {
  const parts = splitMessage(message, TALK_MSG_MAX);
  const results = [];

  for (const part of parts) {
    const body = { message: part };
    if (replyTo && results.length === 0) body.replyTo = replyTo;

    const { data } = await ocsRequest('POST', `/apps/spreed/api/v1/chat/${token}`, { body });
    results.push(data);
  }

  return results;
}

/**
 * Poll for new messages (long-polling).
 * 
 * @param {string} token — Conversation token
 * @param {Object} [opts]
 * @param {number} [opts.lastKnownMessageId] — null=fetch history, number=long-poll
 * @param {number} [opts.timeout] — Server-side timeout in seconds (default 30)
 * @param {number} [opts.limit] — Max messages (default 50)
 * @returns {Promise<Array>} Messages in oldest-first order
 */
export async function pollMessages(token, { lastKnownMessageId, timeout = 30, limit = 50 } = {}) {
  const params = { limit };

  if (lastKnownMessageId != null) {
    // Long-poll: block until new messages arrive or timeout
    params.lookIntoFuture = 1;
    params.timeout = timeout;
    params.lastKnownMessageId = lastKnownMessageId;
  } else {
    // History fetch: get recent messages (non-blocking)
    params.lookIntoFuture = 0;
  }

  const clientTimeout = (lastKnownMessageId ? timeout + 10 : 30) * 1000;
  const { status, data } = await ocsRequest('GET', `/apps/spreed/api/v1/chat/${token}`, {
    params,
    timeout: clientTimeout,
  });

  if (status === 304 || !data) return [];

  // History fetch returns newest-first → reverse to oldest-first
  if (lastKnownMessageId == null && data.length > 0) data.reverse();

  return data;
}

/**
 * Get the ID of the most recent message (for initializing poll state).
 * @param {string} token — Conversation token
 * @returns {Promise<number|null>}
 */
export async function getLatestMessageId(token) {
  const messages = await pollMessages(token, { lastKnownMessageId: null, limit: 1 });
  return messages.length > 0 ? messages[0].id : null;
}

// ─── Message utilities ──────────────────────────────────────────────────────

/**
 * Split message into chunks that fit Talk's 4000 char limit.
 * Splits at: paragraph → newline → sentence → hard cut.
 * @param {string} message
 * @param {number} maxLength
 * @returns {string[]}
 */
export function splitMessage(message, maxLength = TALK_MSG_MAX) {
  if (message.length <= maxLength) return [message];

  const parts = [];
  let remaining = message;

  while (remaining) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    const effective = maxLength - 10; // reserve for " (1/99)"
    const chunk = remaining.slice(0, effective);

    let splitPos = chunk.lastIndexOf('\n\n');
    if (splitPos < effective / 2) splitPos = chunk.lastIndexOf('\n');
    if (splitPos < effective / 2) {
      for (const sep of ['. ', '! ', '? ']) {
        const pos = chunk.lastIndexOf(sep);
        if (pos >= effective / 2) { splitPos = pos + sep.length - 1; break; }
      }
    }
    if (splitPos < effective / 2) splitPos = effective;

    parts.push(remaining.slice(0, splitPos).trimEnd());
    remaining = remaining.slice(splitPos).replace(/^\n+/, '');
  }

  if (parts.length > 1) {
    const total = parts.length;
    const suffixLen = ` (${total}/${total})`.length; // worst case suffix
    return parts.map((p, i) => {
      const suffix = ` (${i + 1}/${total})`;
      // Ensure total doesn't exceed maxLength
      if (p.length + suffix.length > maxLength) {
        return p.slice(0, maxLength - suffix.length) + suffix;
      }
      return `${p}${suffix}`;
    });
  }
  return parts;
}

/**
 * Clean message content: resolve file/mention placeholders.
 * @param {Object} message — Talk message object
 * @param {string} [botUser] — Bot's username (its mentions get stripped)
 * @returns {string}
 */
export function cleanMessageContent(message, botUser) {
  let content = message.message || '';
  const params = message.messageParameters;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return content;

  // Replace {fileN} → [filename]
  content = content.replace(/\{file(\d+)\}/g, (match, n) => {
    const p = params[`file${n}`];
    return p?.name ? `[${p.name}]` : match;
  });

  // Replace mention placeholders
  content = content.replace(/\{(mention-(?:user|call|federated-user)\d+)\}/g, (match, key) => {
    const p = params[key];
    if (!p || typeof p !== 'object') return match;
    if (botUser && p.id === botUser) return ''; // strip bot's own mention
    const name = p.name || p.id || '';
    return name ? `@${name}` : match;
  });

  return content.replace(/ {2,}/g, ' ').trim();
}

/**
 * Filter messages: only human messages (not from bot, not system events).
 * Does NOT check mentions — returns all human messages in the conversation.
 * Caller decides how to handle (DM = all relevant, group = check mention).
 * @param {Array} messages — Raw Talk messages
 * @param {string} botUser — Bot's username (filtered out)
 * @returns {Array} Filtered messages
 */
export function filterRelevantMessages(messages, botUser) {
  if (!botUser) botUser = process.env.NC_USER;
  return (messages || []).filter(msg => {
    if (msg.actorType !== 'users') return false; // skip system messages
    if (msg.actorId === botUser) return false;    // skip own messages
    if (msg.systemMessage) return false;          // skip system events
    return true;
  });
}
