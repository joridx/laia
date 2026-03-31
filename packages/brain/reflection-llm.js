/**
 * reflection-llm.js — LLM bridge for brain_reflect_session.
 *
 * Separated to:
 * 1. Allow easy mock injection in tests
 * 2. Encapsulate budget + task config for "reflection"
 * 3. Keep the tool handler clean
 */

import { callLlm } from "./llm.js";

const REFLECTION_MAX_TOKENS = 2048;
const REFLECTION_TEMPERATURE = 0.3;

// ─── Mock support ───────────────────────────────────────────────────────────

let _mock = null;
export function _setMock(fn) { _mock = fn; }
export function _clearMock() { _mock = null; }

/**
 * Call LLM for session reflection.
 * @param {string} systemPrompt - The reflection analysis prompt
 * @param {string} transcript - The session transcript to analyze
 * @returns {string|null} - Raw LLM response text, or null on failure
 */
export default async function callReflectionLlm(systemPrompt, transcript) {
  if (_mock) return _mock(systemPrompt, transcript);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: transcript }
  ];

  try {
    // callLlm handles budget reservation internally via task="reflection"
    // Budget cost for reflection is defined in llm.js _defaultCosts
    const result = await callLlm(messages, {
      maxTokens: REFLECTION_MAX_TOKENS,
      temperature: REFLECTION_TEMPERATURE,
      task: "reflection",
    });

    return result?.content || null;
  } catch (e) {
    console.error(`[reflection-llm] callLlm failed: ${e.message}`);
    return null;
  }
}
