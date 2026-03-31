/**
 * session-evolved-hook.js — Compile evolved prompt at session end.
 * Called from brain_log_session. Runs inside the brain server process.
 *
 * This is the brain-side bridge: it gathers learnings from meta,
 * formats them, and calls the agent-side compiler (evolved-prompt.js).
 *
 * Since the brain server can't import from src/ (different package),
 * we inline a lightweight version of the compilation logic here,
 * writing directly to ~/.laia/evolved/ (or ~/.claudia/evolved/).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readJSON, readFile } from "../file-io.js";
import { computeAllVitalities } from "../learnings.js";
import { parseLearningFrontmatter } from "../utils.js";
import { BRAIN_PATH, LEARNINGS_DIR } from "../config.js";
import fs from "fs";
import path from "path";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_LINES_PER_SECTION = 50;
const MAX_TOTAL_CHARS = 16_000;
const ADAPTIVE_EXPIRY_DAYS = 30;
const STABLE_PROMOTION_HITS = 3;

const TYPE_FILE_MAP = {
  preference: "user-preferences.md",
  principle: "user-preferences.md",
  procedure: "task-patterns.md",
  pattern: "task-patterns.md",
  warning: "error-recovery.md",
  learning: "domain-knowledge.md",
  bridge: "domain-knowledge.md",
};

const SECTION_TITLES = {
  "user-preferences.md": "User Preferences",
  "task-patterns.md": "Task Patterns & Procedures",
  "error-recovery.md": "Error Recovery & Warnings",
  "domain-knowledge.md": "Domain Knowledge",
};

// Detect which agent we're running under
function getEvolvedDir() {
  // Check LAIA first, then Claudia
  const laiaDir = join(homedir(), ".laia", "evolved");
  const claudiaDir = join(homedir(), ".claudia", "evolved");
  // If .laia exists, use it; otherwise fall back to .claudia
  if (existsSync(join(homedir(), ".laia"))) return laiaDir;
  if (existsSync(join(homedir(), ".claudia"))) return claudiaDir;
  return laiaDir; // default
}

// Strip XML role tags that could poison the system prompt
const ROLE_TAG_RE = /<\/?(?:system|user|assistant|human|tool|function_calls|antml)[^>]*>/gi;

function sanitize(text) {
  if (!text) return "";
  return text.replace(ROLE_TAG_RE, "").replace(/\n/g, " ").trim();
}

function formatLine(l) {
  const title = sanitize(l.title || "(untitled)").slice(0, 200);
  const body = l.body ? sanitize(l.body).slice(0, 150) : "";
  return body && body !== title ? `${title}: ${body}` : title;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function compileEvolvedAfterSession() {
  const evolvedDir = getEvolvedDir();
  mkdirSync(evolvedDir, { recursive: true });

  // Gather learnings
  const meta = readJSON("learnings-meta.json");
  if (!meta?.learnings || Object.keys(meta.learnings).length === 0) return null;

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

  const learnings = [];
  for (const learning of allLearnings) {
    const slug = learning.slug;
    const metaEntry = meta.learnings[slug] || {};
    if (metaEntry.archived || metaEntry.stale || metaEntry.superseded_by) continue;

    const vData = vitalityMap.get(slug);
    learnings.push({
      slug,
      title: learning.title || metaEntry.title || "(untitled)",
      type: learning.type || metaEntry.type || "learning",
      body: (learning.body || "").slice(0, 200),
      hit_count: metaEntry.hit_count || 0,
      vitality: vData?.vitality ?? 0.5,
    });
  }

  if (learnings.length === 0) return null;

  // Load persistent state
  const stableFile = join(evolvedDir, "_stable.json");
  const adaptiveFile = join(evolvedDir, "_adaptive.json");
  const stable = loadJSON(stableFile);
  const adaptive = loadJSON(adaptiveFile);

  const stats = { added: 0, removed: 0, expired: 0, promoted: 0 };
  const fileContents = {};

  for (const [filename, title] of Object.entries(SECTION_TITLES)) {
    const types = Object.entries(TYPE_FILE_MAP)
      .filter(([_, f]) => f === filename)
      .map(([t]) => t);

    const relevant = learnings
      .filter(l => types.includes(l.type))
      .sort((a, b) => (b.vitality - a.vitality) || (b.hit_count - a.hit_count))
      .slice(0, MAX_LINES_PER_SECTION);

    const stableEntries = [];
    const adaptiveEntries = [];

    for (const l of relevant) {
      const line = formatLine(l);

      if (stable[l.slug]) {
        stableEntries.push(line);
        continue;
      }

      if (l.hit_count >= STABLE_PROMOTION_HITS) {
        stableEntries.push(line);
        stable[l.slug] = { line, promoted_at: new Date().toISOString() };
        stats.promoted++;
        continue;
      }

      const existing = adaptive[l.slug];
      if (existing?.expired) { stats.expired++; continue; }
      if (existing) {
        const ageDays = (Date.now() - new Date(existing.added_at).getTime()) / 86400000;
        if (ageDays > ADAPTIVE_EXPIRY_DAYS && l.hit_count === 0) {
          adaptive[l.slug] = { ...existing, expired: true };
          stats.expired++;
          continue;
        }
      }

      if (!existing) stats.added++;
      adaptive[l.slug] = { added_at: existing?.added_at || new Date().toISOString(), type: l.type };
      const expiry = new Date(Date.now() + ADAPTIVE_EXPIRY_DAYS * 86400000).toISOString().split("T")[0];
      adaptiveEntries.push(`${line} [expires: ${expiry}]`);
    }

    let content = `# ${title}\n\n`;
    if (stableEntries.length > 0) {
      content += `## Stable (manually confirmed, never expire)\n`;
      for (const e of stableEntries) content += `- ${e}\n`;
      content += "\n";
    }
    if (adaptiveEntries.length > 0) {
      content += `## Adaptive (auto-compiled, expires after ${ADAPTIVE_EXPIRY_DAYS} days without revalidation)\n`;
      for (const e of adaptiveEntries) content += `- ${e}\n`;
      content += "\n";
    }
    if (stableEntries.length === 0 && adaptiveEntries.length === 0) {
      content += "_No entries yet._\n";
    }
    fileContents[filename] = content;
  }

  // Size gate
  let totalChars = Object.values(fileContents).reduce((s, c) => s + c.length, 0);
  for (const file of ["domain-knowledge.md", "error-recovery.md", "task-patterns.md"]) {
    if (totalChars <= MAX_TOTAL_CHARS) break;
    const lines = fileContents[file].split("\n");
    while (lines.length > 5 && totalChars > MAX_TOTAL_CHARS) {
      totalChars -= (lines.pop().length + 1);
    }
    fileContents[file] = lines.join("\n");
  }

  // Write files
  const totalLines = Object.values(fileContents).reduce((s, c) => s + c.split("\n").length, 0);
  for (const [fn, content] of Object.entries(fileContents)) {
    writeFileSync(join(evolvedDir, fn), content, "utf8");
  }

  // Persist state
  writeFileSync(stableFile, JSON.stringify(stable, null, 2), "utf8");
  writeFileSync(adaptiveFile, JSON.stringify(adaptive, null, 2), "utf8");

  // Version
  const versionFile = join(evolvedDir, "_version.json");
  let version = 1;
  try { version = JSON.parse(readFileSync(versionFile, "utf8")).version + 1; } catch {}
  const versionData = { version, compiled_at: new Date().toISOString(), stable: Object.keys(stable).length, adaptive: Object.keys(adaptive).filter(k => !adaptive[k].expired).length, totalLines };
  writeFileSync(versionFile, JSON.stringify(versionData, null, 2), "utf8");

  // Log
  appendFileSync(join(evolvedDir, "_evolution-log.jsonl"),
    JSON.stringify({ version, timestamp: versionData.compiled_at, ...stats, totalLines }) + "\n", "utf8");

  return {
    version,
    ...stats,
    stableCount: versionData.stable,
    adaptiveCount: versionData.adaptive,
    totalLines,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return {}; }
}
