// src/memory/rerank.js — LLM-powered memory reranking for LAIA V5
// Side-query to a cheap/fast model to select the most relevant memories.
// Gated by flag: memory_rerank = 'off' | 'auto' | 'always'
// In 'auto' mode, only fires when candidates > threshold or score gap is low.

import { stderr } from 'process';
import { getFlag } from '../config/flags.js';

const DIM = '\x1b[2m';
const R = '\x1b[0m';

// Thresholds for 'auto' mode
const MIN_CANDIDATES_FOR_RERANK = 8;    // Don't bother if fewer candidates
const MAX_RESULTS = 5;                   // Return top N after rerank
const RERANK_TIMEOUT_MS = 10_000;        // 10s timeout for side-query

/**
 * Determine if reranking should fire.
 * @param {number} candidateCount - Number of brain search candidates
 * @returns {boolean}
 */
function shouldRerank(candidateCount) {
  const mode = getFlag('memory_rerank', 'auto');
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // 'auto': only when enough candidates to make it worthwhile
  return candidateCount >= MIN_CANDIDATES_FOR_RERANK;
}

/**
 * Build the rerank prompt for the side-query.
 * @param {string} userQuery - The user's current query/context
 * @param {Array<{title: string, snippet: string, id: string}>} candidates
 * @returns {string}
 */
function buildRerankPrompt(userQuery, candidates) {
  const numbered = candidates.map((c, i) =>
    `[${i + 1}] ${c.title}\n    ${c.snippet}`
  ).join('\n');

  return `You are a memory relevance ranker. Given a user query and a list of memory entries, return ONLY the numbers of the ${MAX_RESULTS} most relevant entries, comma-separated, most relevant first.

USER QUERY:
${userQuery}

MEMORY ENTRIES:
${numbered}

Reply with ONLY the numbers (e.g. "3,1,7,2,5"). No explanation.`;
}

/**
 * Parse the rerank response — extract ordered indices.
 * @param {string} response - LLM response (e.g. "3,1,7,2,5")
 * @param {number} maxIndex - Maximum valid index
 * @returns {number[]} 0-based indices in ranked order
 */
function parseRerankResponse(response, maxIndex) {
  const indices = [];
  // Extract numbers from the response (handle various formats)
  const matches = response.match(/\d+/g);
  if (!matches) return [];
  
  for (const m of matches) {
    const idx = parseInt(m) - 1; // Convert 1-based to 0-based
    if (idx >= 0 && idx < maxIndex && !indices.includes(idx)) {
      indices.push(idx);
    }
    if (indices.length >= MAX_RESULTS) break;
  }
  return indices;
}

/**
 * Rerank brain search results using a cheap LLM side-query.
 *
 * @param {object} opts
 * @param {string} opts.query - User query
 * @param {Array<{title: string, snippet: string, score?: number}>} opts.candidates - Brain search results
 * @param {Function} opts.llmCall - Function to call LLM: (prompt: string) => Promise<string>
 * @returns {Promise<Array>} Reranked candidates (top N)
 */
export async function rerankMemories({ query, candidates, llmCall }) {
  if (!candidates || candidates.length === 0) return [];

  // Check gate
  if (!shouldRerank(candidates.length)) {
    // Return top N without reranking
    return candidates.slice(0, MAX_RESULTS);
  }

  // Cap candidates to avoid huge prompts (take top 15 by original score)
  const cappedCandidates = candidates.slice(0, 15);
  // Truncate snippets to 250 chars
  const sanitized = cappedCandidates.map(c => ({
    ...c,
    snippet: (c.snippet || '').slice(0, 250),
  }));

  stderr.write(`${DIM}[rerank] Reranking ${sanitized.length} of ${candidates.length} memories...${R}\n`);
  const start = Date.now();

  // AbortController for real cancellation
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), RERANK_TIMEOUT_MS);

  try {
    const prompt = buildRerankPrompt(query, sanitized);

    const response = await llmCall(prompt, { signal: abort.signal });
    clearTimeout(timeoutId);

    const indices = parseRerankResponse(response, sanitized.length);
    const elapsed = Date.now() - start;
    stderr.write(`${DIM}[rerank] Done in ${elapsed}ms, selected ${indices.length} of ${sanitized.length}${R}\n`);

    if (indices.length === 0) {
      return candidates.slice(0, MAX_RESULTS);
    }

    // Map back to original candidates (cappedCandidates indices match candidates)
    const reranked = indices.map(i => cappedCandidates[i]);

    // Fill up to MAX_RESULTS with remaining candidates
    if (reranked.length < MAX_RESULTS) {
      for (const c of candidates) {
        if (!reranked.includes(c)) {
          reranked.push(c);
          if (reranked.length >= MAX_RESULTS) break;
        }
      }
    }

    return reranked;
  } catch (err) {
    clearTimeout(timeoutId);
    stderr.write(`${DIM}[rerank] Failed (${err.message}), using original order${R}\n`);
    return candidates.slice(0, MAX_RESULTS);
  }
}

/**
 * Create a cheap LLM call function for reranking.
 * Uses the fastest/cheapest available model.
 * @param {object} config - LAIA config
 * @returns {Function} (prompt: string) => Promise<string>
 */
export function createRerankLlmCall(config) {
  return async (prompt, { signal } = {}) => {
    // Dynamic import to avoid circular deps
    const { detectProvider, getProvider, resolveUrl, buildAuthHeaders } = await import('@laia/providers');

    // Use the cheapest model available — configurable with fallback chain
    const rerankModel = config.rerankModel || 'claude-haiku-4-20250414';
    const { providerId } = detectProvider(rerankModel);
    const provider = getProvider(providerId);
    const { getProviderToken } = await import('../auth.js');
    const token = await getProviderToken(providerId);
    const url = resolveUrl(provider, '/chat/completions');
    const headers = buildAuthHeaders(provider, token);

    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, ...provider.extraHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: rerankModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0,
      }),
      signal,  // Pass AbortController signal for real cancellation
    });

    if (!res.ok) {
      throw new Error(`Rerank LLM error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
  };
}
