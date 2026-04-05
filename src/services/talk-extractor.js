// src/services/talk-extractor.js — Extract learnings from Talk conversations
// Sprint 5.2: Reads Talk message history, uses LLM to extract facts/learnings
//
// Flow:
//   1. Fetch recent Talk messages (last 24h or since last extraction)
//   2. Filter human messages only (skip bot, system, commands)
//   3. Batch into chunks (~2000 chars each)
//   4. Send each batch to LLM with extraction prompt
//   5. Parse structured output → brain_remember
//
// Hooks into: runAdvancedSleepCycle (step 4) or /talk extract (manual)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.laia');
const STATE_FILE = join(STATE_DIR, 'talk-extract-state.json');

// Messages that are not useful for extraction
const SKIP_PATTERNS = [
  /^\/\w+/,             // Slash commands
  /^https?:\/\/\S+$/,   // Plain URLs
  /^\s*$/,              // Empty
  /^[👍👎✅❌🔴🟡·]+$/, // Emoji-only reactions
];

const SYSTEM_ACTOR_TYPES = ['bots', 'bridged', 'guests'];

// ─── State Management ────────────────────────────────────────────────────────

/**
 * Load extraction state (last processed message IDs per room).
 * @returns {{ rooms: Record<string, { lastExtractedId: number, lastExtractedAt: string }> }}
 */
export function loadExtractState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // Corrupt state, reset
  }
  return { rooms: {} };
}

/**
 * Save extraction state.
 */
export function saveExtractState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Message Filtering ──────────────────────────────────────────────────────

/**
 * Filter messages to only human-authored, meaningful content.
 * @param {Array} messages — Raw Talk API messages
 * @param {string} botUser — Bot's username to exclude
 * @returns {Array} Filtered messages with { author, text, timestamp, id }
 */
export function filterExtractableMessages(messages, botUser) {
  return messages
    .filter(msg => {
      // Skip bot's own messages
      if (msg.actorId === botUser) return false;
      // Skip system actors
      if (SYSTEM_ACTOR_TYPES.includes(msg.actorType)) return false;
      // Skip system messages (joins, leaves, etc.)
      if (msg.systemMessage) return false;
      // Skip empty
      const text = (msg.message || '').trim();
      if (!text) return false;
      // Skip pattern matches
      if (SKIP_PATTERNS.some(p => p.test(text))) return false;
      return true;
    })
    .map(msg => ({
      id: msg.id,
      author: msg.actorDisplayName || msg.actorId || 'unknown',
      text: (msg.message || '').trim(),
      timestamp: new Date((msg.timestamp || 0) * 1000).toISOString(),
    }));
}

/**
 * Chunk messages into batches by total char count.
 * @param {Array} messages — Filtered messages
 * @param {number} maxChars — Max chars per batch
 * @returns {Array<Array>} Batches of messages
 */
export function batchMessages(messages, maxChars = 2000) {
  const batches = [];
  let current = [];
  let currentLen = 0;

  for (const msg of messages) {
    const msgLen = msg.author.length + msg.text.length + 20; // overhead
    if (currentLen + msgLen > maxChars && current.length > 0) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(msg);
    currentLen += msgLen;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

// ─── LLM Extraction ─────────────────────────────────────────────────────────

/**
 * Build the extraction prompt for a batch of messages.
 * @param {Array} batch — Messages [{ author, text, timestamp }]
 * @returns {string}
 */
export function buildExtractionPrompt(batch) {
  const conversation = batch
    .map(m => `[${m.timestamp}] ${m.author}: ${m.text}`)
    .join('\n');

  return `You are a knowledge extractor for LAIA, a personal AI assistant.

Analyze this conversation excerpt and extract useful facts, preferences, or decisions that LAIA should remember long-term.

Rules:
- Extract ONLY concrete facts, preferences, decisions, or instructions
- SKIP small talk, greetings, acknowledgments, questions without answers
- SKIP anything the user explicitly says NOT to remember
- SKIP information LAIA already said (only extract human knowledge)
- Each learning must be self-contained (understandable without context)
- Classify each as: "learning", "preference", or "warning"
- Add relevant tags (lowercase, hyphenated)
- If there is NOTHING worth extracting, return empty array

Conversation:
${conversation}

Respond ONLY with a JSON array (no markdown, no explanation):
[
  {
    "type": "learning",
    "title": "Short descriptive title",
    "description": "Full context and detail",
    "tags": ["tag1", "tag2"]
  }
]

If nothing to extract, respond with: []`;
}

/**
 * Call LLM to extract learnings from a message batch.
 * @param {Array} batch — Messages
 * @param {Object} config — LAIA config (for model/provider)
 * @returns {Promise<Array>} Extracted learnings
 */
export async function extractFromBatch(batch, config, llmCall) {
  const prompt = buildExtractionPrompt(batch);
  if (!llmCall) {
    llmCall = await createExtractorLlmCall(config);
  }

  const raw = await llmCall(prompt);
  const { learnings, parseError } = parseExtractionResponse(raw);

  return { learnings, parseError };
}

/**
 * Parse LLM response into structured learnings.
 * @param {string} raw — LLM response text
 * @returns {Array} Parsed learnings
 */
export function parseExtractionResponse(raw) {
  if (!raw || !raw.trim()) return { learnings: [], parseError: null };

  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return { learnings: [], parseError: null };

    // Validate each entry
    const learnings = parsed.filter(entry =>
      entry &&
      typeof entry.title === 'string' &&
      typeof entry.description === 'string' &&
      entry.title.trim() &&
      entry.description.trim() &&
      ['learning', 'preference', 'warning'].includes(entry.type)
    ).map(entry => ({
      type: entry.type,
      title: entry.title.trim().slice(0, 120),
      description: entry.description.trim().slice(0, 500),
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter(t => typeof t === 'string').map(t => t.toLowerCase().replace(/\s+/g, '-').replace(/^-+|-+$/g, '').trim()).filter(Boolean).slice(0, 5)
        : [],
    }));

    return { learnings, parseError: null };
  } catch (err) {
    // LLM returned non-JSON — report for diagnostics
    const snippet = raw.slice(0, 100).replace(/\n/g, ' ');
    return { learnings: [], parseError: `JSON parse failed: ${err.message} — "${snippet}..."` };
  }
}

// ─── LLM Call Factory ────────────────────────────────────────────────────────

/**
 * Create a cheap LLM call function for extraction.
 * Reuses the provider pattern from rerank.js.
 * @param {Object} config — LAIA config
 * @returns {Function} (prompt: string) => Promise<string>
 */
async function createExtractorLlmCall(config) {
  // Import once and cache — reused across batches
  const { detectProvider, getProvider, resolveUrl, buildAuthHeaders } = await import('@laia/providers');
  const { getProviderToken } = await import('../auth.js');

  // Use a capable but cheap model — extraction needs understanding
  const extractModel = config.extractModel || config.model || 'claude-haiku-4-20250414';
  const { providerId } = detectProvider(extractModel);
  const provider = getProvider(providerId);
  const token = await getProviderToken(providerId);
  const url = resolveUrl(provider, '/chat/completions');
  const headers = buildAuthHeaders(provider, token);

  // Return reusable function (no repeated setup)
  return async (prompt) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, ...provider.extraHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: extractModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Extraction LLM error: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
  };
}

// ─── Main Extraction Pipeline ────────────────────────────────────────────────

/**
 * Run the full extraction pipeline on Talk conversations.
 *
 * @param {Object} opts
 * @param {Object} opts.config — LAIA config (model, etc.)
 * @param {string[]} [opts.roomTokens] — Specific rooms (default: all DMs)
 * @param {boolean} [opts.dryRun=true] — Show what would be extracted without saving
 * @param {number} [opts.maxMessages=200] — Max messages to process per room
 * @param {boolean} [opts.save=false] — Save to brain
 * @returns {Promise<Object>} Extraction report
 */
export async function extractFromTalk({
  config,
  roomTokens,
  dryRun = true,
  maxMessages = 200,
  save = false,
} = {}) {
  const { pollMessages, listConversations } = await import('../channels/talk-client.js');

  const state = loadExtractState();
  const botUser = process.env.NC_USER || 'laia-fujitsu';

  // Discover rooms if not specified
  let rooms;
  if (roomTokens?.length) {
    rooms = roomTokens.map(token => ({ token, type: 1, displayName: token }));
  } else {
    const convos = await listConversations();
    // Only DMs (type 1) and groups where bot participates (type 2)
    rooms = convos.filter(c => c.type === 1 || c.type === 2);
  }

  const report = {
    rooms: rooms.length,
    messagesProcessed: 0,
    batchesSent: 0,
    learningsExtracted: [],
    learningsSaved: 0,
    errors: [],
    dryRun,
    timestamp: new Date().toISOString(),
  };

  // Create LLM call function once for all batches
  let llmCall;
  try {
    llmCall = await createExtractorLlmCall(config);
  } catch (err) {
    report.errors.push(`LLM init: ${err.message}`);
    return report;
  }

  // Track seen titles for cross-batch dedup
  const seenTitles = new Set();

  for (const room of rooms) {
    try {
      const roomState = state.rooms[room.token] || {};

      // Fetch messages (history mode — lookIntoFuture=0)
      const messages = await pollMessages(room.token, {
        lastKnownMessageId: null,
        timeout: 0,
        limit: maxMessages,
      });

      if (!messages.length) continue;

      // Filter to only new messages (after last extraction)
      const newMessages = roomState.lastExtractedId
        ? messages.filter(m => m.id > roomState.lastExtractedId)
        : messages;

      const extractable = filterExtractableMessages(newMessages, botUser);
      if (!extractable.length) {
        // Still update state to latest message
        const maxId = Math.max(...messages.map(m => m.id));
        state.rooms[room.token] = {
          lastExtractedId: maxId,
          lastExtractedAt: new Date().toISOString(),
        };
        continue;
      }

      report.messagesProcessed += extractable.length;

      // Batch and extract
      const batches = batchMessages(extractable);
      for (const batch of batches) {
        try {
          report.batchesSent++;
          const { learnings, parseError } = await extractFromBatch(batch, config, llmCall);

          if (parseError) report.errors.push(`Room ${room.token}: ${parseError}`);

          // Tag with source + sanitize room tag
          const roomTag = `room-${(room.displayName || room.token).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
          for (const l of learnings) {
            l.tags = [...new Set([...l.tags, 'talk-extracted', roomTag])];
            l.source = `talk:${room.token}`;

            // Dedup: skip if same title already extracted this run
            const titleKey = l.title.toLowerCase();
            if (seenTitles.has(titleKey)) continue;
            seenTitles.add(titleKey);

            report.learningsExtracted.push(l);
          }
        } catch (err) {
          report.errors.push(`Room ${room.token} batch: ${err.message}`);
        }
      }

      // Update state per room (incremental — survives crash)
      const maxId = Math.max(...messages.map(m => m.id));
      state.rooms[room.token] = {
        lastExtractedId: maxId,
        lastExtractedAt: new Date().toISOString(),
      };
      if (!dryRun) saveExtractState(state);
    } catch (err) {
      report.errors.push(`Room ${room.token}: ${err.message}`);
    }
  }

  // Save learnings to brain
  if (save && !dryRun && report.learningsExtracted.length > 0) {
    try {
      const { brainRemember } = await import('../brain/client.js');
      for (const learning of report.learningsExtracted) {
        await brainRemember(learning);
        report.learningsSaved++;
      }
    } catch (err) {
      report.errors.push(`Brain save: ${err.message}`);
    }
  }

  return report;
}

/**
 * Format extraction report for display.
 * @param {Object} report — From extractFromTalk()
 * @returns {string}
 */
export function formatExtractionReport(report) {
  const lines = [];
  const mode = report.dryRun ? '(dry-run)' : '';

  lines.push(`🔍 Talk Extraction ${mode}`);
  lines.push(`   Rooms scanned: ${report.rooms}`);
  lines.push(`   Messages processed: ${report.messagesProcessed}`);
  lines.push(`   LLM batches: ${report.batchesSent}`);

  if (report.learningsExtracted.length > 0) {
    lines.push(`   Learnings found: ${report.learningsExtracted.length}`);
    for (const l of report.learningsExtracted.slice(0, 10)) {
      const icon = l.type === 'warning' ? '⚠️' : l.type === 'preference' ? '🎯' : '💡';
      lines.push(`     ${icon} ${l.title}`);
    }
    if (report.learningsExtracted.length > 10) {
      lines.push(`     _(+${report.learningsExtracted.length - 10} more)_`);
    }
  } else {
    lines.push('   Learnings found: 0 (nothing new to extract)');
  }

  if (!report.dryRun && report.learningsSaved > 0) {
    lines.push(`   Saved to brain: ${report.learningsSaved}`);
  }

  if (report.errors.length > 0) {
    lines.push(`   ⚠ Errors: ${report.errors.length}`);
    for (const e of report.errors.slice(0, 3)) {
      lines.push(`     - ${e}`);
    }
  }

  return lines.join('\n');
}
