import { z } from "zod";
import { zCoercedArray } from "./shared.js";
import { writeFile, readJSON } from "../file-io.js";
import { performGitPush } from "../git-sync.js";
import { sanitizeTag } from "../utils.js";
import { readProjectFile, serializeProject, syncSkillsToData, findSimilarProject } from "../helpers.js";
import { computeCompositeScore, sanitizeQuality } from "../quality.js";
import { isDbAvailable, getDb, insertSessionQuality } from "../database.js";
import { compileEvolvedAfterSession } from "./session-evolved-hook.js";

const name = "brain_log_session";
const description = "Session end: log summary, learnings, tags, quality scorecard. Auto git-sync.";

const schema = {
  project: z.string().describe("Project name or topic of the session"),
  summary: z.string().describe("Brief summary of what was accomplished"),
  learnings: zCoercedArray(z.string()).optional().describe("New things learned during the session"),
  tags: zCoercedArray(z.string()).describe("Tags for this session"),
  quality: z.object({
    task_completed: z.boolean().optional().describe("Was the main task completed?"),
    rework_required: z.boolean().optional().describe("Did the user ask to redo something?"),
    user_corrections: z.number().optional().describe("Number of user corrections"),
    tool_errors: z.number().optional().describe("Number of tool calls that returned errors"),
    tools_used: z.number().optional().describe("Total tool invocations"),
    turns: z.number().optional().describe("Number of user-agent turns"),
    satisfaction: z.enum(["high", "medium", "low"]).optional().describe("User satisfaction estimate"),
  }).optional().describe("V4: Quality scorecard for this session")
};

async function handler({ project, summary, learnings = [], tags, quality }) {
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

  // V4 Sprint 3: Quality scorecard
  const cleanQuality = sanitizeQuality(quality);
  const qualityScore = computeCompositeScore(cleanQuality);
  if (cleanQuality) {
    content += `\n## Quality Scorecard\n`;
    content += `- **Score**: ${qualityScore}/10\n`;
    if (cleanQuality.task_completed != null) content += `- Task completed: ${cleanQuality.task_completed ? "yes" : "no"}\n`;
    if (cleanQuality.rework_required != null) content += `- Rework required: ${cleanQuality.rework_required ? "yes" : "no"}\n`;
    if (cleanQuality.user_corrections != null) content += `- User corrections: ${cleanQuality.user_corrections}\n`;
    if (cleanQuality.tool_errors != null) content += `- Tool errors: ${cleanQuality.tool_errors}\n`;
    if (cleanQuality.tools_used != null) content += `- Tools used: ${cleanQuality.tools_used}\n`;
    if (cleanQuality.turns != null) content += `- Turns: ${cleanQuality.turns}\n`;
    if (cleanQuality.satisfaction) content += `- Satisfaction: ${cleanQuality.satisfaction}\n`;
  }

  writeFile(filename, content);

  // Store quality score in SQLite for trend analysis
  if (cleanQuality && qualityScore != null && isDbAvailable()) {
    try {
      insertSessionQuality(getDb(), {
        session_date: date,
        project: normalizedProject,
        score: qualityScore,
        ...cleanQuality,
        session_file: filename,
      });
    } catch (e) {
      console.error(`Quality DB insert failed: ${e.message}`);
    }
  }

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

  // V4 Sprint 4: Auto-compile evolved prompt at session end
  let evolvedReport = "";
  try {
    const evolvedResult = await compileEvolvedAfterSession();
    if (evolvedResult) {
      evolvedReport = `\n🧠 Evolved prompt v${evolvedResult.version}: ${evolvedResult.stableCount} stable, ${evolvedResult.adaptiveCount} adaptive`;
      if (evolvedResult.promoted > 0) evolvedReport += ` (🌟 ${evolvedResult.promoted} promoted)`;
      if (evolvedResult.expired > 0) evolvedReport += ` (🗑️ ${evolvedResult.expired} expired)`;
    }
  } catch (e) { console.error(`Evolved compile failed: ${e.message}`); }

  const syncResult = performGitPush(`Session ${date}: ${project}`);
  let response = `✓ Session logged to ${filename}`;
  if (qualityScore != null) response += `\n🎯 Quality score: ${qualityScore}/10`;
  if (skillsReport) response += skillsReport;
  if (evolvedReport) response += evolvedReport;
  if (syncResult.syncReport) response += `\n${syncResult.syncReport}`;
  return { content: [{ type: "text", text: response }] };
}

export { name, description, schema, handler };
