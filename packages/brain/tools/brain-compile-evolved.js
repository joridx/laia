/**
 * Tool: brain_compile_evolved
 * Compile brain learnings into evolved system prompt sections.
 * Reads all active learnings, groups by type, writes to ~/.laia/evolved/*.md
 */

import { z } from "zod";
import { computeAllVitalities } from "../learnings.js";
import { readJSON, readFile } from "../file-io.js";
import { parseLearningFrontmatter } from "../utils.js";
import { BRAIN_PATH, LEARNINGS_DIR } from "../config.js";
import fs from "fs";
import path from "path";

export const name = "brain_compile_evolved";

export const description = "Compile brain learnings into evolved system prompt files (~/.laia/evolved/). Groups by type: preferences, patterns, warnings, domain facts. Dual-layer: stable (promoted) + adaptive (30-day expiry).";

export const schema = {
  dry_run: z.boolean().optional().describe("If true, show what would be compiled without writing files. Default: false"),
};

export async function handler({ dry_run = false } = {}) {
  // Gather all active learnings with their metadata
  const meta = readJSON("learnings-meta.json");
  if (!meta?.learnings || Object.keys(meta.learnings).length === 0) {
    return { content: [{ type: "text", text: "⚠️ No learnings found in brain. Nothing to compile." }] };
  }

  const vitalityMap = computeAllVitalities();

  // Read learnings directly from filesystem (DB may not be synced)
  const learningsDir = path.join(BRAIN_PATH, LEARNINGS_DIR);
  const allLearnings = [];
  if (fs.existsSync(learningsDir)) {
    for (const f of fs.readdirSync(learningsDir)) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue;
      const content = readFile(`${LEARNINGS_DIR}/${f}`);
      const parsed = parseLearningFrontmatter(content);
      if (!parsed) continue;
      allLearnings.push({
        slug: f.replace(".md", ""),
        ...parsed.frontmatter,
        body: parsed.body,
      });
    }
  }

  // Build structured learning list with full metadata
  const learnings = [];
  for (const learning of allLearnings) {
    const slug = learning.slug;
    const metaEntry = meta.learnings[slug] || {};
    const vData = vitalityMap.get(slug);

    // Skip archived/stale/superseded
    if (metaEntry.archived || metaEntry.stale || metaEntry.superseded_by) continue;

    learnings.push({
      slug,
      title: learning.title || metaEntry.title || "(untitled)",
      type: learning.type || metaEntry.type || "learning",
      body: (learning.body || "").slice(0, 200),
      tags: learning.tags || metaEntry.tags || [],
      hit_count: metaEntry.hit_count || 0,
      vitality: vData?.vitality ?? 0.5,
      protected: metaEntry.protected || false,
    });
  }

  // Format as structured text for the evolved-prompt compiler
  const lines = [];
  lines.push(`# Brain Learnings for Evolved Prompt Compilation`);
  lines.push(`Total: ${learnings.length} active learnings\n`);

  // Sort by type, then vitality desc
  learnings.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return (b.vitality ?? 0) - (a.vitality ?? 0);
  });

  for (const l of learnings) {
    lines.push(`- **${l.title}** [${l.slug}] (type:${l.type}, vitality:${l.vitality.toFixed(2)}, hits:${l.hit_count})`);
    if (l.body) {
      const bodyPreview = l.body.replace(/\n/g, ' ').trim().slice(0, 100);
      if (bodyPreview && bodyPreview !== l.title) {
        lines.push(`  ${bodyPreview}`);
      }
    }
  }

  const result = lines.join("\n");

  if (dry_run) {
    return {
      content: [{ type: "text", text: `# Dry Run — Would compile ${learnings.length} learnings\n\n${result}` }],
    };
  }

  // Return formatted text for the agent-side compiler to process
  return {
    content: [{ type: "text", text: result }],
  };
}
