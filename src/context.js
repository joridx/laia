// Conversation history and context management
// Stores full turn transcripts (user + tool calls + tool results + assistant reply)
// for multi-turn reasoning. Large tool results are truncated to stay within budget.

const CHARS_PER_TOKEN = 4;
const MAX_TOOL_RESULT_CHARS = 3000;  // truncate large tool outputs (file reads, bash)
const MAX_HISTORY_TURNS = 6;        // keep last N turns in full; older turns drop tool detail

export function createContext({ maxTokens = 300_000, threshold = 0.8 } = {}) {
  // Simple pairs for display/compaction (user+assistant text only)
  const messages = [];
  // Full turn transcripts in /chat/completions format (canonical)
  // Each entry: [{role, content?, tool_calls?, tool_call_id?}]
  const turns = [];

  function addUser(text) {
    messages.push({ role: 'user', content: text, ts: Date.now() });
  }

  function addAssistant(text) {
    messages.push({ role: 'assistant', content: text, ts: Date.now() });
  }

  // Store the full message transcript of a turn (tool calls + results + final reply).
  // msgs is the array from llm.js representing [user, tool_exchanges..., final_assistant].
  function addTurnMessages(msgs) {
    if (!msgs?.length) return;
    // Truncate large tool results to stay within token budget
    const truncated = msgs.map(m => {
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > MAX_TOOL_RESULT_CHARS) {
        return { ...m, content: m.content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n...[truncated]' };
      }
      return m;
    });
    turns.push(truncated);
  }

  // Return full history for LLM: last MAX_HISTORY_TURNS turns with tool detail.
  // Older turns are represented only by user+assistant text pairs.
  function getHistory() {
    if (!turns.length) return [];

    const result = [];
    const fullStart = Math.max(0, turns.length - MAX_HISTORY_TURNS);

    // Older turns: user + assistant text only (no tool detail)
    for (let i = 0; i < fullStart; i++) {
      const turn = turns[i];
      const userMsg = turn.find(m => m.role === 'user');
      const assistantMsgs = turn.filter(m => m.role === 'assistant' && m.content);
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
      if (userMsg) result.push({ role: 'user', content: userMsg.content ?? '' });
      if (lastAssistant) result.push({ role: 'assistant', content: lastAssistant.content ?? '' });
    }

    // Recent turns: full tool transcript
    for (let i = fullStart; i < turns.length; i++) {
      result.push(...turns[i]);
    }

    return result;
  }

  function estimateTokens() {
    let chars = 0;
    for (const m of messages) chars += (m.content?.length ?? 0);
    // Also count tool transcript chars
    for (const turn of turns) {
      for (const m of turn) {
        if (typeof m.content === 'string') chars += m.content.length;
        if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  function needsCompaction() {
    return estimateTokens() > maxTokens * threshold;
  }

  function getMessages() {
    return [...messages];
  }

  function clear() {
    messages.length = 0;
    turns.length = 0;
  }

  // Compaction: drop oldest turns' tool detail, keep only user+assistant text
  function compact(keepLast = 6) {
    // Drop old turns entirely (they're preserved as text pairs in messages)
    if (turns.length > keepLast) turns.splice(0, turns.length - keepLast);
    // Compact simple messages array
    if (messages.length > keepLast) {
      const kept = messages.slice(-keepLast);
      messages.length = 0;
      messages.push({ role: 'system', content: '[Earlier conversation compacted]', ts: Date.now() });
      messages.push(...kept);
    }
  }

  // Serialize context state for session persistence
  function serialize() {
    return {
      turns: structuredClone(turns),
      messages: structuredClone(messages),
    };
  }

  // Restore context state from saved session data
  function deserialize(data) {
    if (!data || typeof data !== 'object') return false;
    if (!Array.isArray(data.turns) || !Array.isArray(data.messages)) return false;
    turns.length = 0;
    messages.length = 0;
    turns.push(...data.turns);
    messages.push(...data.messages);
    return true;
  }

  function turnCount() {
    return turns.length;
  }

  function usagePercent() {
    return Math.round((estimateTokens() / maxTokens) * 100);
  }

  function getMaxTokens() {
    return maxTokens;
  }

  return { addUser, addAssistant, addTurnMessages, getHistory, estimateTokens, needsCompaction, getMessages, clear, compact, serialize, deserialize, turnCount, usagePercent, getMaxTokens };
}
