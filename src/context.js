// Conversation history and context management
// MVP: simple history with char-based token estimation and truncation

const CHARS_PER_TOKEN = 4;

export function createContext({ maxTokens = 300_000, threshold = 0.8 } = {}) {
  const messages = [];

  function addUser(text) {
    messages.push({ role: 'user', content: text, ts: Date.now() });
  }

  function addAssistant(text) {
    messages.push({ role: 'assistant', content: text, ts: Date.now() });
  }

  function estimateTokens() {
    let chars = 0;
    for (const m of messages) chars += (m.content?.length ?? 0);
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
  }

  // Simple compaction: keep last N messages
  function compact(keepLast = 6) {
    if (messages.length <= keepLast) return;
    const kept = messages.slice(-keepLast);
    messages.length = 0;
    messages.push({ role: 'system', content: '[Earlier conversation compacted]', ts: Date.now() });
    messages.push(...kept);
  }

  return { addUser, addAssistant, estimateTokens, needsCompaction, getMessages, clear, compact };
}
