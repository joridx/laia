import { z } from "zod";
import { zCoercedArray } from "./shared.js";
import { readFile, writeFile } from "../file-io.js";
import { recordHit, addTagCooccurrenceRelations } from "../graph.js";
import { fetchConfluencePage } from "../helpers.js";
import { slugify, sanitizeTag, parseLearningFrontmatter, applyTagAliases } from "../utils.js";
import { getTagAliasMap } from "./shared.js";

export const name = "brain_ingest_confluence";

export const description =
  "Cache Confluence page as knowledge/{domain}/. Skips if same version.";

export const schema = {
  page_id: z.string().describe("Confluence page ID (e.g. '2719853123')"),
  domain: z
    .string()
    .optional()
    .describe("Knowledge domain directory (default: 'confluence')"),
  tags: zCoercedArray(z.string())
    .optional()
    .describe("Additional tags for categorization"),
  force: z
    .boolean()
    .optional()
    .describe("Force update even if version matches"),
};

export async function handler({ page_id, domain, tags, force }) {
  const targetDomain = (domain || "confluence").replace(/[^a-z0-9_-]/gi, "-");
  const cleanTags = applyTagAliases((tags || []).map(sanitizeTag), getTagAliasMap());

  const page = await fetchConfluencePage(page_id);

  const slug = slugify(page.title);
  const filePath = `knowledge/${targetDomain}/${slug}.md`;

  const existing = readFile(filePath);
  if (existing && !force) {
    const parsed = parseLearningFrontmatter(existing);
    if (parsed?.frontmatter?.confluence_version) {
      const cachedVersion = parseInt(parsed.frontmatter.confluence_version, 10);
      if (cachedVersion === page.version) {
        return {
          content: [
            {
              type: "text",
              text: `Cache hit — ${filePath} already at version ${page.version}. Use force:true to update.`,
            },
          ],
        };
      }
    }
  }

  const today = new Date().toISOString().split("T")[0];
  const allTags = [
    ...new Set([
      ...cleanTags,
      "confluence",
      sanitizeTag(page.space || targetDomain),
    ]),
  ];

  let md = `---\n`;
  md += `title: "${page.title.replace(/"/g, '\\"')}"\n`;
  md += `source: "${page.webUrl}"\n`;
  md += `confluence_page_id: "${page_id}"\n`;
  md += `confluence_version: ${page.version}\n`;
  md += `confluence_space: "${page.space || ""}"\n`;
  md += `created: ${existing ? (parseLearningFrontmatter(existing)?.frontmatter?.created || today) : today}\n`;
  md += `updated: ${today}\n`;
  md += `tags: [${allTags.join(", ")}]\n`;
  md += `slug: ${slug}\n`;
  md += `---\n\n`;
  md += page.body + "\n";
  md += `\n${allTags.map((t) => `#${t}`).join(" ")}\n`;

  writeFile(filePath, md);

  addTagCooccurrenceRelations(allTags);
  for (const t of allTags) recordHit("tag", t);

  const action = existing ? "Updated" : "Ingested";
  return {
    content: [
      {
        type: "text",
        text: `✓ ${action}: ${filePath} (v${page.version}, ${page.body.length} chars)\nTitle: ${page.title}\nSpace: ${page.space}\nTags: ${allTags.map((t) => `#${t}`).join(", ")}`,
      },
    ],
  };
}
