/**
 * Tool: brain_get_learnings
 * Get learnings by tags, optionally filtered by type.
 */

import { z } from "zod";
import { zCoercedArray, getTagAliasMap } from "./shared.js";
import { applyTagAliases, sanitizeTag } from "../utils.js";
import { retrieveLearningsByTags, checkSearchAttribution } from "../learnings.js";

export const name = "brain_get_learnings";

export const description =
  "Get learnings by tags, optionally filtered by type (warning/pattern/learning).";

export const schema = {
  tags: zCoercedArray(z.string()).describe("Tags to filter learnings, e.g. ['bash', 'docker']"),
  type: z.enum(["warning", "pattern", "learning", "principle", "bridge"]).optional().describe("Filter by type. Omit for all.")
};

export async function handler({ tags, type }) {
  // P7.5: normalize input tags through alias map before searching
  const normalizedTags = applyTagAliases(tags.map(sanitizeTag), getTagAliasMap());
  const { active, stale, allRelated } = retrieveLearningsByTags(normalizedTags, type);

  // P10.3: Check if these accesses are attributable to a prior brain_search
  checkSearchAttribution(active.slice(0, 15).map(l => l.slug));

  const typeLabel = type === "warning" ? "Warnings" : type === "pattern" ? "Patterns" : "Learnings";
  let output = `# ${typeLabel} for: ${tags.join(", ")}\n\n`;

  if (allRelated.length > 0) output += `**Related concepts:** ${allRelated.join(", ")}\n\n`;

  if (active.length === 0 && stale.length === 0) {
    output += `No ${typeLabel.toLowerCase()} found for these tags.\n`;
    if (allRelated.length > 0) output += `\nConsider checking for related concepts: ${allRelated.join(", ")}`;
    return { content: [{ type: "text", text: output }] };
  }

  for (const l of active.slice(0, 15)) {
    output += `- **${l.title}**: ${l.headline || l.title}\n`;
  }

  if (active.length === 0 && stale.length > 0) {
    output += `\n_(${stale.length} stale ${typeLabel.toLowerCase()} hidden — stale filtering is automatic)_\n`;
  }

  return { content: [{ type: "text", text: output }] };
}
