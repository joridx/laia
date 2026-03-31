/**
 * Session, project, and Confluence helpers for LAIA Brain.
 */

import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import { BRAIN_PATH } from "./config.js";
import { readFile, readJSON } from "./file-io.js";
import { stripHtml, tokenize, sanitizeTag } from "./utils.js";
import { getRelatedConcepts } from "./graph.js";

// ─── Sessions ─────────────────────────────────────────────────────────────────

export function getRecentSessions(count = 3) {
  const sessionsDir = path.join(BRAIN_PATH, "memory", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith(".md") && !fs.statSync(path.join(sessionsDir, f)).isDirectory())
    .sort()
    .reverse()
    .slice(0, count);

  return files.map(f => ({
    file: `memory/sessions/${f}`,
    content: readFile(`memory/sessions/${f}`)
  }));
}

export function getSessionsByProject(projectName, count = 5) {
  const sessionsDir = path.join(BRAIN_PATH, "memory", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith(".md") && !fs.statSync(path.join(sessionsDir, f)).isDirectory())
    .filter(f => f.toLowerCase().includes(projectName.toLowerCase()))
    .sort()
    .reverse()
    .slice(0, count);

  return files.map(f => ({
    file: `memory/sessions/${f}`,
    content: readFile(`memory/sessions/${f}`)
  }));
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function getProjectContext(projectName) {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

  const projectSummary = readFile(`memory/projects/${slug}.md`);
  if (projectSummary) {
    return { file: `memory/projects/${slug}.md`, content: projectSummary, isStructured: true };
  }

  const knowledgePaths = [
    `knowledge/projects/${projectName}.md`,
    `knowledge/domain/${projectName}.md`
  ];
  for (const p of knowledgePaths) {
    const content = readFile(p);
    if (content) {
      return { file: p, content, isStructured: false };
    }
  }

  const generalProjects = readFile("memory/user/projects.md");
  if (generalProjects && generalProjects.toLowerCase().includes(projectName.toLowerCase())) {
    return { file: "memory/user/projects.md", content: generalProjects, isStructured: false };
  }

  return null;
}

export function readProjectFile(projectSlug) {
  const content = readFile(`memory/projects/${projectSlug}.md`);
  if (!content) return null;

  const parsed = { frontmatter: {}, sections: {} };

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const fmLines = fmMatch[1].split("\n");
    for (const line of fmLines) {
      const kvMatch = line.match(/^(\w+):\s*(.+)$/);
      if (kvMatch) {
        let value = kvMatch[2].trim();
        if (value.startsWith("[") && value.endsWith("]")) {
          value = value.slice(1, -1).split(",").map(s => s.trim());
        }
        parsed.frontmatter[kvMatch[1]] = value;
      }
    }
    const body = fmMatch[2];
    const sectionRegex = /^## (.+)$/gm;
    let match;
    const sectionStarts = [];
    while ((match = sectionRegex.exec(body)) !== null) {
      sectionStarts.push({ name: match[1], index: match.index, headerLen: match[0].length });
    }
    for (let i = 0; i < sectionStarts.length; i++) {
      const start = sectionStarts[i].index + sectionStarts[i].headerLen;
      const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index : body.length;
      parsed.sections[sectionStarts[i].name] = body.slice(start, end).trim();
    }
  }

  return parsed;
}

export function serializeProject(data) {
  let content = "---\n";
  for (const [key, value] of Object.entries(data.frontmatter)) {
    if (Array.isArray(value)) {
      content += `${key}: [${value.join(", ")}]\n`;
    } else {
      content += `${key}: ${value}\n`;
    }
  }
  content += "---\n";

  for (const [name, body] of Object.entries(data.sections)) {
    content += `\n## ${name}\n${body}\n`;
  }

  return content;
}

/**
 * Find existing projects similar to a new slug.
 * Uses Jaccard similarity on slug tokens + tag overlap.
 *
 * Returns:
 *   { level: "block", slug, similarity, tagOverlap } — Jaccard >= 0.60 or substring match
 *   { level: "warn",  slug, similarity, tagOverlap } — Jaccard >= 0.40 or tagOverlap >= 0.70
 *   null — no similar project found
 */
export function findSimilarProject(newSlug, newTags) {
  const projectsDir = path.join(BRAIN_PATH, "memory", "projects");
  let files;
  try { files = fs.readdirSync(projectsDir).filter(f => f.endsWith(".md")); }
  catch { return null; }

  const newTokens = new Set(tokenize(newSlug));
  if (newTokens.size === 0) return null;

  const newTagSet = new Set((newTags || []).map(sanitizeTag));
  let bestMatch = null;
  let bestScore = 0;

  for (const file of files) {
    const existingSlug = file.replace(/\.md$/, "");
    if (existingSlug === newSlug) continue; // exact match = same project, OK

    const existingTokens = new Set(tokenize(existingSlug));
    if (existingTokens.size === 0) continue;

    // Jaccard on slug tokens
    const intersection = [...newTokens].filter(t => existingTokens.has(t)).length;
    const union = new Set([...newTokens, ...existingTokens]).size;
    const similarity = intersection / union;

    // Substring containment (one slug contains the other)
    const isSubstring = newSlug.includes(existingSlug) || existingSlug.includes(newSlug);

    // Tag overlap
    let tagOverlap = 0;
    if (newTagSet.size > 0) {
      const existingData = readProjectFile(existingSlug);
      if (existingData?.frontmatter?.tags) {
        const existingTags = new Set(
          (Array.isArray(existingData.frontmatter.tags) ? existingData.frontmatter.tags : [])
            .map(sanitizeTag)
        );
        const tagIntersection = [...newTagSet].filter(t => existingTags.has(t)).length;
        tagOverlap = tagIntersection / newTagSet.size;
      }
    }

    // Combined score for ranking (similarity dominates, substring is strong signal)
    const score = similarity + (isSubstring ? 0.3 : 0) + tagOverlap * 0.2;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        slug: existingSlug,
        similarity: +similarity.toFixed(3),
        tagOverlap: +tagOverlap.toFixed(3),
        isSubstring
      };
    }
  }

  if (!bestMatch) return null;

  // Block: high similarity or substring match
  if (bestMatch.similarity >= 0.60 || bestMatch.isSubstring) {
    return { level: "block", ...bestMatch };
  }
  // Warn: moderate similarity or high tag overlap
  if (bestMatch.similarity >= 0.40 || bestMatch.tagOverlap >= 0.70) {
    return { level: "warn", ...bestMatch };
  }
  return null;
}

// ─── Skills Sync ─────────────────────────────────────────────────────────────

/**
 * Sync skill files from ~/.laia/commands/ to brain-data/skills/.
 * Copies only files newer than the target (or missing).
 * Returns { synced: string[], skipped: number }.
 */
export function syncSkillsToData() {
  const commandsDir = path.join(homedir(), ".laia", "commands");
  const skillsDir = path.join(BRAIN_PATH, "skills");
  const result = { synced: [], skipped: 0 };

  if (!fs.existsSync(commandsDir)) return result;
  if (!fs.existsSync(skillsDir)) {
    try { fs.mkdirSync(skillsDir, { recursive: true }); } catch { return result; }
  }

  // Also sync helper scripts (.py) from ~/.laia/
  const helperScripts = [];
  const laiaDir = path.join(homedir(), ".laia");
  try {
    for (const f of fs.readdirSync(laiaDir)) {
      if (f.endsWith(".py") && !f.startsWith(".")) helperScripts.push(f);
    }
  } catch { /* ignore */ }

  // Collect all files to check: .md from commands/ + .py from ~/.laia/
  const filesToSync = [];
  try {
    for (const f of fs.readdirSync(commandsDir)) {
      if (f.endsWith(".md")) filesToSync.push({ name: f, src: path.join(commandsDir, f) });
    }
  } catch { return result; }
  for (const f of helperScripts) {
    filesToSync.push({ name: f, src: path.join(laiaDir, f) });
  }

  for (const { name, src } of filesToSync) {
    const dst = path.join(skillsDir, name);
    try {
      const srcStat = fs.statSync(src);
      if (fs.existsSync(dst)) {
        const dstStat = fs.statSync(dst);
        if (srcStat.mtimeMs <= dstStat.mtimeMs) { result.skipped++; continue; }
      }
      fs.copyFileSync(src, dst);
      result.synced.push(name);
    } catch { result.skipped++; }
  }

  return result;
}

// ─── Confluence ───────────────────────────────────────────────────────────────

export async function fetchConfluencePage(pageId) {
  if (!/^\d+$/.test(pageId)) throw new Error(`Invalid Confluence page ID (must be numeric): ${pageId}`);

  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !token) throw new Error("CONFLUENCE_BASE_URL and CONFLUENCE_API_TOKEN env vars required");

  // Security: validate URL protocol to prevent SSRF
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") throw new Error("CONFLUENCE_BASE_URL must use https");
  } catch (e) {
    if (e.message.includes("https")) throw e;
    throw new Error(`CONFLUENCE_BASE_URL is not a valid URL: ${baseUrl}`);
  }

  const url = `${baseUrl}/rest/api/content/${pageId}?expand=body.storage,version,space`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let resp;
  try {
    resp = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Confluence request timed out (30s)");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) throw new Error(`Confluence API error: ${resp.status} ${resp.statusText}`);

  const data = await resp.json();
  return {
    title: data.title,
    body: stripHtml(data.body?.storage?.value || ''),
    version: data.version?.number,
    space: data.space?.key,
    webUrl: `${baseUrl}${data._links?.webui || `/rest/api/content/${pageId}`}`
  };
}
