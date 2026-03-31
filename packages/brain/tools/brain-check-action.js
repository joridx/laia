import { z } from "zod";
import { getTagAliasMap } from "./shared.js";
import { applyTagAliases, extractTags } from "../utils.js";
import { retrieveLearningsByTags, checkSearchAttribution } from "../learnings.js";

const name = "brain_check_action";

const description = "Pre-action check: find relevant warnings before commands or changes.";

const schema = {
  action: z.string().describe("Command, code snippet, or action description to check"),
  context: z.string().optional().describe("Additional context")
};

async function handler({ action, context = "" }) {
  const fullText = `${action} ${context}`;
  const detectedTags = applyTagAliases(extractTags(fullText), getTagAliasMap());

  if (detectedTags.length === 0) {
    return { content: [{ type: "text", text: "✓ No specific technology detected. Proceeding." }] };
  }

  const { active: activeChecks, stale: staleChecks, allRelated } = retrieveLearningsByTags(detectedTags, "warning");

  // P10.3: Check if these accesses are attributable to a prior brain_search
  checkSearchAttribution(activeChecks.slice(0, 8).map(w => w.slug));

  let output = `# Proactive Check: ${detectedTags.join(", ")}\n\n`;

  if (activeChecks.length === 0 && staleChecks.length === 0) {
    output += `✅ **No warnings found** for detected technologies.\n`;
    output += `\nDetected: ${detectedTags.join(", ")}\n`;
    output += `Related: ${allRelated.join(", ") || "none"}\n`;
    return { content: [{ type: "text", text: output }] };
  }

  if (activeChecks.length === 0 && staleChecks.length > 0) {
    output += `✅ **No active warnings found** (${staleChecks.length} stale filtered out).\n`;
    return { content: [{ type: "text", text: output }] };
  }

  output += `⚠️ **${activeChecks.length} warning(s) found!**\n\n`;

  for (const w of activeChecks.slice(0, 8)) {
    output += `### ${w.title}\n`;
    output += `- ${w.headline || w.title}\n`;
    output += `- Tags: ${(w.tags || []).map(t => `#${t}`).join(", ")}\n`;
    output += "\n";
  }

  if (activeChecks.length > 8) output += `\n... and ${activeChecks.length - 8} more warnings.\n`;
  if (staleChecks.length > 0) output += `\n_(${staleChecks.length} stale warning(s) filtered out)_\n`;

  output += `\n---\n**Action:** Review warnings before proceeding.`;
  return { content: [{ type: "text", text: output }] };
}

export { name, description, schema, handler };
