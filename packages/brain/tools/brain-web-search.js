/**
 * Tool: brain_web_search
 * Web search via Tavily API, optionally save results as brain knowledge.
 */

import { z } from "zod";

import { TAVILY_API_KEY, LEARNINGS_DIR } from "../config.js";
import { writeFile } from "../file-io.js";
import { ensureLearningMeta } from "../learnings.js";
import { slugify, sanitizeTag, buildLearningMarkdown } from "../utils.js";

export const name = "brain_web_search";
export const description = "Web search via Tavily API, optionally save results as brain knowledge.";
export const schema = {
  query: z.string().describe("Search query"),
  max_results: z.number().int().min(1).max(10).optional().default(5).describe("Number of results (1-10, default 5)"),
  save: z.boolean().optional().default(false).describe("Save top results as brain knowledge file"),
  search_depth: z.enum(["basic", "advanced"]).optional().default("basic").describe("Search depth: basic (fast) or advanced (thorough)")
};

export async function handler({ query, max_results = 5, save = false, search_depth = "basic" }) {
  if (!TAVILY_API_KEY) {
    return {
      content: [{ type: "text", text: "❌ TAVILY_API_KEY not configured. Add it to the MCP server env vars." }]
    };
  }

  let data;
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth,
        max_results,
        include_answer: true
      })
    });
    if (!response.ok) {
      const err = await response.text();
      return { content: [{ type: "text", text: `❌ Tavily error ${response.status}: ${err}` }] };
    }
    data = await response.json();
  } catch (e) {
    return { content: [{ type: "text", text: `❌ Network error: ${e.message}` }] };
  }

  const lines = [`# Web Search: ${query}\n`];

  if (data.answer) {
    lines.push(`## Answer\n${data.answer}\n`);
  }

  lines.push(`## Results (${data.results?.length || 0})\n`);
  for (const r of (data.results || [])) {
    lines.push(`### ${r.title}`);
    lines.push(`**URL:** ${r.url}`);
    if (r.content) lines.push(`${r.content.slice(0, 400)}${r.content.length > 400 ? "…" : ""}`);
    lines.push("");
  }

  if (save && data.results?.length > 0) {
    const slug = slugify(`web-search-${query}`).slice(0, 60);
    const tags = ["web-search", "tavily", ...query.toLowerCase().split(/\s+/).slice(0, 3).map(t => sanitizeTag(t))];
    const searchTitle = `Web Search: ${query}`;
    const searchBody = (data.answer || `Web search results for: ${query}`) + "\n\n" + lines.join("\n");
    const content = buildLearningMarkdown(searchTitle, "learning", tags, searchBody);
    writeFile(`${LEARNINGS_DIR}/${slug}.md`, content);
    ensureLearningMeta(slug, searchTitle, `${LEARNINGS_DIR}/${slug}.md`, "learning");
    lines.push(`\n✅ Saved as learning: \`${slug}\``);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
