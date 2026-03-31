import { z } from "zod";
import { zCoercedArray } from "./shared.js";
import { writeFile } from "../file-io.js";
import { readProjectFile, serializeProject, findSimilarProject } from "../helpers.js";

export const name = "brain_update_project";

export const description = "Update project summary (status, decisions, pending). Creates projects/{project}.md.";

export const schema = {
  project: z.string().describe("Project slug (e.g., 'binary-engine', 'laia-brain')"),
  status: z.enum(["active", "paused", "completed", "archived"]).optional().describe("Project status"),
  summary: z.string().optional().describe("What the project is (short description)"),
  add_decisions: zCoercedArray(z.string()).optional().describe("New decisions to append"),
  set_pending: zCoercedArray(z.string()).optional().describe("Replace pending items list"),
  add_pending: zCoercedArray(z.string()).optional().describe("Add items to pending list"),
  remove_pending: zCoercedArray(z.string()).optional().describe("Remove items from pending (by substring match)"),
  notes: z.string().optional().describe("Replace notes section"),
  tags: zCoercedArray(z.string()).optional().describe("Project tags"),
  force: z.boolean().optional().describe("Bypass similarity check for new projects")
};

export async function handler({ project, status, summary, add_decisions, set_pending, add_pending, remove_pending, notes, tags, force }) {
  const slug = project.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const filePath = `memory/projects/${slug}.md`;
  const today = new Date().toISOString().split("T")[0];

  let data = readProjectFile(slug);
  const isNew = !data;

  // Similarity check for new projects — prevent duplicates
  let similarWarning;
  if (isNew && !force) {
    const similar = findSimilarProject(slug, tags);
    if (similar?.level === "block") {
      return { content: [{ type: "text", text:
        `⚠️ Similar project exists: "${similar.slug}" (similarity: ${similar.similarity}, tags: ${similar.tagOverlap}${similar.isSubstring ? ", substring match" : ""})\n` +
        `→ Use project="${similar.slug}" to update the existing project, or pass force=true to create a new one.`
      }] };
    }
    if (similar?.level === "warn") {
      // Warn but proceed — append notice to output
      similarWarning = `\n⚠️ Note: similar project "${similar.slug}" exists (similarity: ${similar.similarity}, tags: ${similar.tagOverlap}). Consider using that slug instead.`;
    }
  }

  if (!data) {
    data = {
      frontmatter: {
        title: project,
        status: status || "active",
        last_activity: today,
        tags: tags || []
      },
      sections: {}
    };
  }

  data.frontmatter.last_activity = today;
  if (status) data.frontmatter.status = status;
  if (tags) data.frontmatter.tags = tags;

  if (summary) data.sections["What"] = summary;

  if (add_decisions) {
    const existing = data.sections["Decisions"] || "";
    const existingItems = existing.split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2));
    const newItems = add_decisions.filter(d => !existingItems.some(e => e.toLowerCase() === d.toLowerCase()));
    data.sections["Decisions"] = [...existingItems, ...newItems].map(d => `- ${d}`).join("\n");
  }

  if (set_pending) {
    data.sections["Pending"] = set_pending.map(p => `- ${p}`).join("\n");
  } else if (add_pending || remove_pending) {
    const existing = (data.sections["Pending"] || "").split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2));
    let items = [...existing];
    if (remove_pending) {
      items = items.filter(item => !remove_pending.some(r => item.toLowerCase().includes(r.toLowerCase())));
    }
    if (add_pending) {
      const newItems = add_pending.filter(p => !items.some(e => e.toLowerCase() === p.toLowerCase()));
      items = [...items, ...newItems];
    }
    data.sections["Pending"] = items.map(p => `- ${p}`).join("\n");
  }

  if (notes) data.sections["Notes"] = notes;
  if (isNew && !data.sections["What"]) data.sections["What"] = summary || `Project: ${project}`;

  writeFile(filePath, serializeProject(data));

  const changes = [];
  if (isNew) changes.push("created");
  if (status) changes.push(`status → ${status}`);
  if (summary) changes.push("summary updated");
  if (add_decisions) changes.push(`+${add_decisions.length} decisions`);
  if (set_pending) changes.push(`pending set (${set_pending.length} items)`);
  if (add_pending) changes.push(`+${add_pending.length} pending`);
  if (remove_pending) changes.push(`-${remove_pending.length} pending`);
  if (notes) changes.push("notes updated");

  const msg = `✓ Project "${slug}" updated: ${changes.join(", ")}\n→ ${filePath}` +
    (typeof similarWarning === "string" ? similarWarning : "");
  return { content: [{ type: "text", text: msg }] };
}
