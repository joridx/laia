// src/repl/feedback.js
// Post-turn implicit relevance feedback — extracted from repl.js

import { brainFeedback } from '../brain/client.js';

const FEEDBACK_MIN_RESPONSE = 50;

export async function sendFeedback(turnMessages, responseText) {
  if (!turnMessages || !responseText) return;

  const cleaned = responseText.slice(0, 2000);
  if (cleaned.length < FEEDBACK_MIN_RESPONSE) return;

  const searchCalls = [];
  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i];
    if (!msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const fn = tc.function;
      if (!fn || fn.name !== 'brain_search') continue;
      const resultMsg = turnMessages.find(m => m.role === 'tool' && m.tool_call_id === tc.id);
      if (!resultMsg?.content) continue;
      try {
        const args = JSON.parse(fn.arguments || '{}');
        const result = JSON.parse(resultMsg.content);
        searchCalls.push({ query: args.query, result });
      } catch { /* skip malformed */ }
    }
  }
  if (!searchCalls.length) return;

  const isMulti = searchCalls.length > 1;
  const globalUsed = new Set();

  for (const call of searchCalls) {
    const learnings = extractLearningsFromResult(call.result);
    if (!learnings.length) continue;

    const slugs = learnings.map(l => l.slug);
    const titles = learnings.map(l => l.title);
    const explorationSlugs = learnings.filter(l => l._exploration).map(l => l.slug);

    if (isMulti) {
      const hasUsage = slugs.some(s => {
        if (globalUsed.has(s)) return false;
        const title = titles[slugs.indexOf(s)] || s.replace(/-/g, ' ');
        return cleaned.toLowerCase().includes(s) || cleaned.toLowerCase().includes(title.toLowerCase());
      });
      if (!hasUsage) continue;
    }

    const dedupedSlugs = slugs.filter(s => !globalUsed.has(s));
    const dedupedTitles = dedupedSlugs.map(s => titles[slugs.indexOf(s)]);

    try {
      await brainFeedback({
        query: call.query,
        result_slugs: dedupedSlugs,
        result_titles: dedupedTitles,
        exploration_slugs: explorationSlugs.filter(s => dedupedSlugs.includes(s)),
        response: cleaned,
      });
      dedupedSlugs.forEach(s => globalUsed.add(s));
    } catch (e) {
      if (process.env.DEBUG) console.error('[feedback]', call.query, e.message);
    }
  }
}

function extractLearningsFromResult(result) {
  let data = result;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return []; }
  }
  if (!data) return [];

  const text = data.result || data;
  if (typeof text === 'string') {
    const learnings = [];

    const primaryMatches = text.matchAll(/[-•]\s+\*\*(.+?)\*\*\s+\[([a-z0-9-]+)\]/g);
    for (const m of primaryMatches) {
      learnings.push({ slug: m[2], title: m[1] });
    }
    if (learnings.length) return learnings;

    const fallbackMatches = text.matchAll(/[-•]\s+\*\*(.+?)\*\*\s*\(/g);
    for (const m of fallbackMatches) {
      const title = m[1].trim();
      const slug = title.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
      if (slug) learnings.push({ slug, title });
    }
    return learnings;
  }

  if (Array.isArray(data.learnings)) {
    return data.learnings.map(l => ({
      slug: l.slug || '',
      title: l.title || l.headline || '',
      _exploration: l._exploration || false,
    }));
  }
  return [];
}
