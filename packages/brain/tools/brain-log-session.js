import { z } from "zod";
import { zCoercedArray } from "./shared.js";
import { writeFile, readJSON } from "../file-io.js";
import { performGitPush } from "../git-sync.js";
import { sanitizeTag } from "../utils.js";
import { readProjectFile, serializeProject, syncSkillsToData, findSimilarProject } from "../helpers.js";

const name = "brain_log_session";
const description = "Session end: log summary, learnings, tags. Auto git-sync.";

const schema = {
  project: z.string().describe("Project name or topic of the session"),
  summary: z.string().describe("Brief summary of what was accomplished"),
  learnings: zCoercedArray(z.string()).optional().describe("New things learned during the session"),
  tags: zCoercedArray(z.string()).describe("Tags for this session")
};

async function handler({ project, summary, learnings = [], tags }) {
  const date = new Date().toISOString().split("T")[0];
  // Normalize project name: lowercase, _ → -, collapse multiples, trim
  let normalizedProject = project.toLowerCase()
    .replace(/[_\s]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

  // Fix A: Match against existing project files to use canonical name
  const similar = findSimilarProject(normalizedProject, tags);
  if (similar?.level === "block") {
    normalizedProject = similar.slug;
  }

  const filename = `memory/sessions/${date}_${normalizedProject}.md`;
  const tagString = tags.map(t => `#${sanitizeTag(t)}`).join(" ");

  let content = `# Session: ${date} - ${normalizedProject}\n\n`;
  content += `**Tags**: ${tagString}\n\n`;
  content += `## Summary\n${summary}\n\n`;

  if (learnings.length > 0) {
    content += `## Learnings\n`;
    for (const l of learnings) content += `- ${l}\n`;
  }

  writeFile(filename, content);

  const index = readJSON("index.json");
  if (index) {
    index.sessions = index.sessions || [];
    // Dedup: update existing entry for same file instead of pushing duplicate
    const existingIdx = index.sessions.findIndex(s => s.file === filename);
    if (existingIdx >= 0) {
      const existing = index.sessions[existingIdx];
      const mergedTags = [...new Set([...(existing.tags || []), ...tags])];
      index.sessions[existingIdx] = { date, project: normalizedProject, file: filename, tags: mergedTags };
    } else {
      index.sessions.push({ date, project: normalizedProject, file: filename, tags });
    }
    index.updated = date;
    writeFile("index.json", JSON.stringify(index, null, 2));
  }

  // Fix B: Auto-create skeleton project file if it doesn't exist
  const projectFilePath = `memory/projects/${normalizedProject}.md`;
  if (!readProjectFile(normalizedProject)) {
    const skeletonData = {
      frontmatter: {
        title: project,
        status: "active",
        last_activity: date,
        tags: tags || []
      },
      sections: { "What": `Project: ${project}` }
    };
    writeFile(projectFilePath, serializeProject(skeletonData));
  }

  // P8.2: Sync skills to brain-data before git push
  let skillsReport = "";
  try {
    const skillsSync = syncSkillsToData();
    if (skillsSync.synced.length > 0) {
      skillsReport = `\n📋 Skills synced: ${skillsSync.synced.join(", ")}`;
    }
  } catch (e) { console.error(`Skills sync failed: ${e.message}`); }

  const syncResult = performGitPush(`Session ${date}: ${project}`);
  let response = `✓ Session logged to ${filename}`;
  if (skillsReport) response += skillsReport;
  if (syncResult.syncReport) response += `\n${syncResult.syncReport}`;
  return { content: [{ type: "text", text: response }] };
}

export { name, description, schema, handler };
