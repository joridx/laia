/**
 * Tool: brain_index_notes
 * Scan Obsidian notes (memory/notes/), diagnose issues, and optionally enrich
 * with frontmatter + tags via LLM.
 */

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { BRAIN_PATH } from "../config.js";
import { isLlmAvailable, callLlm } from "../llm.js";
import { sanitizeTag, parseLearningFrontmatter } from "../utils.js";
import { getAllLearnings } from "../learnings.js";

export const name = "brain_index_notes";

export const description = "Scan and enrich brain files. action: scan (diagnose ALL brain files: notes+learnings+knowledge+self), enrich (add frontmatter+tags via LLM to notes), fix-single (enrich one note), add-links (add ## Related [[wikilinks]] to files missing them).";

export const schema = {
  action: z.enum(["scan", "enrich", "fix-single", "add-links"]).describe("scan=diagnose ALL brain files, enrich=bulk add frontmatter+tags to notes, fix-single=fix one note, add-links=add ## Related wikilinks to files missing them"),
  scope: z.enum(["all", "notes", "learnings", "knowledge"]).optional().describe("For scan/add-links: which area to scan (default: all)"),
  path: z.string().optional().describe("For fix-single: relative path within memory/notes/ (e.g. 'Learning/IT/docker.md')"),
  dry_run: z.boolean().optional().describe("For enrich: preview changes without writing (default: true)"),
  limit: z.number().optional().describe("For enrich: max notes to process in one batch (default: 10)")
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOTES_DIR = path.join(BRAIN_PATH, "memory", "notes");

function walkNotes(dir, baseDir = null, results = []) {
  if (!baseDir) baseDir = dir;
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walkNotes(path.join(dir, entry.name), baseDir, results);
    } else if (entry.name.endsWith(".md")) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

function analyzeNote(fullPath) {
  const content = fs.readFileSync(fullPath, "utf8");
  const trimmed = content.trim();

  const result = {
    content,
    isEmpty: !trimmed || trimmed.length < 10,
    hasFrontmatter: false,
    hasTags: false,
    tags: [],
    title: null,
    bodyLength: trimmed.length,
  };

  if (content.startsWith("---")) {
    const fmEnd = content.indexOf("---", 4);
    if (fmEnd !== -1) {
      result.hasFrontmatter = true;
      const fm = content.slice(4, fmEnd);

      // Extract tags
      const tagMatch = fm.match(/tags?:\s*\[([^\]]*)\]/);
      if (tagMatch) {
        result.tags = tagMatch[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
        result.hasTags = result.tags.length > 0;
      } else {
        // YAML list format
        const tagLines = fm.match(/tags?:\s*\n((?:\s*-\s*.+\n?)*)/);
        if (tagLines) {
          result.tags = tagLines[1].match(/-\s*(.+)/g)?.map(t => t.replace(/^-\s*/, "").trim().replace(/['"]/g, "")) || [];
          result.hasTags = result.tags.length > 0;
        }
      }

      // Extract title
      const titleMatch = fm.match(/title:\s*["']?(.+?)["']?\s*$/m);
      if (titleMatch) result.title = titleMatch[1];
    }
  }

  return result;
}

async function generateFrontmatter(relPath, content) {
  if (!isLlmAvailable()) return null;

  const truncated = content.slice(0, 2000);
  const folder = path.dirname(relPath);

  const prompt = `Analyze this Obsidian note and generate YAML frontmatter.
File path: memory/notes/${relPath}
Folder: ${folder}

Content (first 2000 chars):
${truncated}

Return ONLY valid YAML (no markdown fences) with these fields:
- title: short descriptive title (from content or filename)
- tags: array of 2-5 relevant tags (lowercase, no spaces, use hyphens)
- type: one of [note, reference, tutorial, log, checklist, template]
- created: best guess date in YYYY-MM-DD format (from content or "unknown")

Example output:
title: Docker Compose Networking Guide
tags: [docker, networking, compose, devops]
type: reference
created: 2024-03-15`;

  try {
    const result = await callLlm([
      { role: "system", content: "You generate YAML frontmatter for Obsidian notes. Return ONLY valid YAML, no explanations." },
      { role: "user", content: prompt }
    ], { maxTokens: 300, temperature: 0.2 });
    return result?.trim() || null;
  } catch {
    return null;
  }
}

function addFrontmatterToNote(content, yaml) {
  // If already has frontmatter, merge (keep existing, add missing)
  if (content.startsWith("---")) {
    const fmEnd = content.indexOf("---", 4);
    if (fmEnd !== -1) {
      const existingFm = content.slice(4, fmEnd).trim();
      const body = content.slice(fmEnd + 3).trim();
      // Simple merge: if existing doesn't have tags, add from generated
      const newLines = yaml.split("\n");
      const existingKeys = new Set(existingFm.split("\n").map(l => l.split(":")[0].trim()));
      const toAdd = newLines.filter(l => {
        const key = l.split(":")[0].trim();
        return key && !existingKeys.has(key);
      });
      if (toAdd.length === 0) return null; // Nothing to add
      const inlineTags = _inlineTagsFromYaml(existingFm + "\n" + toAdd.join("\n"));
      const bodyHasInline = /(?<!\w)#[a-z][a-z0-9-]+/.test(body.split("\n").slice(-3).join("\n"));
      const merged = `---\n${existingFm}\n${toAdd.join("\n")}\n---\n\n${body}${bodyHasInline ? "" : inlineTags}`;
      return merged;
    }
  }

  // No frontmatter — prepend
  return `---\n${yaml}\n---\n\n${content}${_inlineTagsFromYaml(yaml)}`;
}

/** Extract tags from YAML and return inline hashtags for Obsidian Graph View */
function _inlineTagsFromYaml(yaml) {
  const m = yaml.match(/tags:\s*\[([^\]]*)\]/);
  if (!m) return "";
  const tags = m[1].split(",").map(t => t.trim().replace(/['"/]/g, "")).filter(Boolean);
  return tags.length > 0 ? `\n\n${tags.map(t => `#${t}`).join(" ")}\n` : "";
}

/** Extract tags array from YAML string */
function _extractTagsFromYaml(yaml) {
  const m = yaml.match(/tags:\s*\[([^\]]*)\]/);
  if (!m) return [];
  return m[1].split(",").map(t => t.trim().replace(/['"/]/g, "")).filter(Boolean);
}

/**
 * Generate a ## Related section with [[wikilinks]] for a note.
 * Finds top-5 most related learnings/knowledge via Jaccard on tag sets.
 */
function _generateRelatedForNote(noteTags) {
  if (!noteTags || noteTags.length === 0) return "";
  const myTags = new Set(noteTags.map(sanitizeTag));

  try {
    const all = getAllLearnings();
    if (!all || all.length === 0) return "";

    const scored = [];
    for (const l of all) {
      const lTags = new Set((l.tags || []).map(sanitizeTag));
      if (lTags.size === 0) continue;
      const intersection = [...myTags].filter(t => lTags.has(t)).length;
      if (intersection === 0) continue;
      const union = new Set([...myTags, ...lTags]).size;
      const jaccard = intersection / union;
      if (jaccard >= 0.15) {
        scored.push({ slug: l.slug, jaccard, shared: intersection });
      }
    }
    if (scored.length === 0) return "";
    scored.sort((a, b) => b.jaccard - a.jaccard || b.shared - a.shared);
    const top = scored.slice(0, 5);
    const links = top.map(s => `- [[${s.slug}]]`).join("\n");
    return `\n\n## Related\n${links}\n`;
  } catch {
    return "";
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handler({ action = "scan", scope = "all", path: notePath, dry_run = true, limit = 10 }) {
  const lines = [];

  if (action === "scan") {
    // ── Scan: ALL brain areas ──
    const SCAN_AREAS = {
      notes:     { dir: path.join(BRAIN_PATH, "memory", "notes"),     label: "📝 Notes (Joplin/OneNote)" },
      learnings: { dir: path.join(BRAIN_PATH, "memory", "learnings"), label: "🧠 Learnings" },
      knowledge: { dir: path.join(BRAIN_PATH, "knowledge"),           label: "📚 Knowledge" },
      self:      { dir: path.join(BRAIN_PATH, "self"),                label: "🪞 Self" },
      sessions:  { dir: path.join(BRAIN_PATH, "memory", "sessions"),  label: "📋 Sessions" },
    };

    const areasToScan = scope === "all" ? Object.keys(SCAN_AREAS) : [scope].filter(k => SCAN_AREAS[k]);
    if (areasToScan.length === 0) areasToScan.push(...Object.keys(SCAN_AREAS));

    let grandTotal = 0;
    const grandIssues = { noFrontmatter: [], noTags: [], noWikilinks: [], noInlineTags: [], empty: [], wellFormed: [] };

    lines.push(`# 🧠 Brain Full Scan\n`);

    for (const areaKey of areasToScan) {
      const area = SCAN_AREAS[areaKey];
      const files = walkNotes(area.dir);
      if (files.length === 0) continue;

      const issues = { noFrontmatter: [], noTags: [], noWikilinks: [], noInlineTags: [], empty: [], wellFormed: 0 };
      const folderStats = {};

      for (const { fullPath, relPath } of files) {
        const analysis = analyzeNote(fullPath);
        const content = analysis.content || "";
        const folder = path.dirname(relPath) || "root";
        folderStats[folder] = (folderStats[folder] || 0) + 1;

        const hasWikilinks = content.includes("[[");
        const hasInlineTags = /(?<!\w)#[a-z][a-z0-9-]+/.test(content.replace(/^---[\s\S]*?---/, ""));
        const areaPrefix = `${areaKey}/${relPath}`;

        if (analysis.isEmpty) { issues.empty.push(areaPrefix); grandIssues.empty.push(areaPrefix); }
        else if (!analysis.hasFrontmatter) { issues.noFrontmatter.push(areaPrefix); grandIssues.noFrontmatter.push(areaPrefix); }
        else if (!analysis.hasTags) { issues.noTags.push(areaPrefix); grandIssues.noTags.push(areaPrefix); }
        else {
          issues.wellFormed++;
          grandIssues.wellFormed.push(areaPrefix);
          if (!hasWikilinks) { issues.noWikilinks.push(areaPrefix); grandIssues.noWikilinks.push(areaPrefix); }
          if (!hasInlineTags) { issues.noInlineTags.push(areaPrefix); grandIssues.noInlineTags.push(areaPrefix); }
        }
      }

      grandTotal += files.length;

      lines.push(`## ${area.label} — ${files.length} files`);
      lines.push(`| Metric | Count |`);
      lines.push(`|---|---:|`);
      lines.push(`| ✅ Well-formed | **${issues.wellFormed}** |`);
      lines.push(`| ⚠️ No frontmatter | ${issues.noFrontmatter.length} |`);
      lines.push(`| ⚠️ No tags | ${issues.noTags.length} |`);
      lines.push(`| 🔗 No [[wikilinks]] | ${issues.noWikilinks.length} |`);
      lines.push(`| #️⃣ No inline #tags | ${issues.noInlineTags.length} |`);
      lines.push(`| ❌ Empty/tiny | ${issues.empty.length} |`);
      lines.push("");

      // Show some examples if there are issues
      const areaIssues = [...issues.noFrontmatter, ...issues.noTags, ...issues.empty];
      if (areaIssues.length > 0 && areaIssues.length <= 5) {
        for (const p of areaIssues) lines.push(`  - ${p}`);
        lines.push("");
      } else if (areaIssues.length > 5) {
        for (const p of areaIssues.slice(0, 3)) lines.push(`  - ${p}`);
        lines.push(`  - ... and ${areaIssues.length - 3} more`);
        lines.push("");
      }
    }

    // Grand summary
    lines.push(`---\n## 📊 Grand Total: ${grandTotal} files\n`);
    lines.push(`| Metric | Count | % |`);
    lines.push(`|---|---:|---:|`);
    const wf = grandIssues.wellFormed.length;
    lines.push(`| ✅ Well-formed (frontmatter + tags) | **${wf}** | ${(100*wf/grandTotal).toFixed(1)}% |`);
    lines.push(`| ⚠️ No frontmatter | ${grandIssues.noFrontmatter.length} | ${(100*grandIssues.noFrontmatter.length/grandTotal).toFixed(1)}% |`);
    lines.push(`| ⚠️ No tags | ${grandIssues.noTags.length} | ${(100*grandIssues.noTags.length/grandTotal).toFixed(1)}% |`);
    lines.push(`| 🔗 No [[wikilinks]] (among well-formed) | ${grandIssues.noWikilinks.length} | ${wf > 0 ? (100*grandIssues.noWikilinks.length/wf).toFixed(1) : 0}% |`);
    lines.push(`| #️⃣ No inline #tags (among well-formed) | ${grandIssues.noInlineTags.length} | ${wf > 0 ? (100*grandIssues.noInlineTags.length/wf).toFixed(1) : 0}% |`);
    lines.push(`| ❌ Empty/tiny | ${grandIssues.empty.length} | ${(100*grandIssues.empty.length/grandTotal).toFixed(1)}% |`);

    const fixable = grandIssues.noFrontmatter.length + grandIssues.noTags.length;
    const linkable = grandIssues.noWikilinks.length;
    lines.push("");
    if (fixable > 0) lines.push(`**Fixable by enrich:** ${fixable} files`);
    if (linkable > 0) lines.push(`**Fixable by add-links:** ${linkable} files (have tags but no [[wikilinks]])`);
    if (fixable === 0 && linkable === 0) lines.push(`**🎯 All files healthy!**`);

  } else if (action === "fix-single") {
    // ── Fix single note ──
    if (!notePath) {
      return { content: [{ type: "text", text: "Error: path is required for fix-single action" }] };
    }

    const fullPath = path.join(NOTES_DIR, notePath);
    if (!fs.existsSync(fullPath)) {
      return { content: [{ type: "text", text: `Error: note not found: ${notePath}` }] };
    }

    const analysis = analyzeNote(fullPath);
    lines.push(`# Fix Note: ${notePath}\n`);
    lines.push(`- Has frontmatter: ${analysis.hasFrontmatter ? "✅" : "❌"}`);
    lines.push(`- Has tags: ${analysis.hasTags ? `✅ [${analysis.tags.join(", ")}]` : "❌"}`);
    lines.push(`- Body length: ${analysis.bodyLength} chars\n`);

    if (analysis.hasFrontmatter && analysis.hasTags) {
      lines.push("Note is already well-formed. No changes needed.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const yaml = await generateFrontmatter(notePath, analysis.content);
    if (!yaml) {
      lines.push("⚠️ LLM unavailable — cannot generate frontmatter.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const newContent = addFrontmatterToNote(analysis.content, yaml);
    if (!newContent) {
      lines.push("Note already has all fields. No changes needed.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    lines.push(`## Generated frontmatter:\n\`\`\`yaml\n${yaml}\n\`\`\`\n`);

    // Append ## Related wikilinks based on tags
    const noteTags = _extractTagsFromYaml(yaml);
    const related = _generateRelatedForNote(noteTags);
    const finalContent = related ? newContent.trimEnd() + related : newContent;

    if (dry_run) {
      lines.push("**Dry run** — no changes written. Run with `dry_run: false` to apply.");
      if (related) lines.push(`\n💡 Would add ## Related with ${(related.match(/\[\[/g) || []).length} wikilinks`);
    } else {
      fs.writeFileSync(fullPath, finalContent, "utf8");
      lines.push("✅ **Applied!** Frontmatter + Related links added to note.");
    }

  } else if (action === "enrich") {
    // ── Bulk enrich notes without frontmatter/tags ──
    const notes = walkNotes(NOTES_DIR);
    const toFix = [];

    for (const { fullPath, relPath } of notes) {
      if (toFix.length >= limit) break;
      const analysis = analyzeNote(fullPath);
      if (!analysis.isEmpty && (!analysis.hasFrontmatter || !analysis.hasTags)) {
        toFix.push({ fullPath, relPath, analysis });
      }
    }

    lines.push(`# Enrich Obsidian Notes\n`);
    lines.push(`**Notes to process:** ${toFix.length} (limit: ${limit})`);
    lines.push(`**Mode:** ${dry_run ? "🔍 Dry run (preview only)" : "✍️ Write mode"}\n`);

    if (!isLlmAvailable()) {
      lines.push("⚠️ LLM unavailable — cannot generate frontmatter. Configure BRAIN_LLM_FALLBACK.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    let fixed = 0;
    let failed = 0;

    for (const { fullPath, relPath, analysis } of toFix) {
      const yaml = await generateFrontmatter(relPath, analysis.content);
      if (!yaml) {
        lines.push(`- ❌ **${relPath}** — LLM failed to generate frontmatter`);
        failed++;
        continue;
      }

      const newContent = addFrontmatterToNote(analysis.content, yaml);
      if (!newContent) {
        lines.push(`- ⏭️ **${relPath}** — no changes needed`);
        continue;
      }

      // Generate ## Related wikilinks from tags
      const noteTags = _extractTagsFromYaml(yaml);
      const related = _generateRelatedForNote(noteTags);
      const finalContent = related ? newContent.trimEnd() + related : newContent;

      if (dry_run) {
        // Extract tags from generated yaml
        const tagMatch = yaml.match(/tags:\s*\[([^\]]*)\]/);
        const tags = tagMatch ? tagMatch[1] : "?";
        const rlCount = related ? (related.match(/\[\[/g) || []).length : 0;
        lines.push(`- 📝 **${relPath}** → tags: [${tags}]${rlCount ? ` + ${rlCount} related links` : ""}`);
      } else {
        fs.writeFileSync(fullPath, finalContent, "utf8");
        lines.push(`- ✅ **${relPath}** — enriched`);
      }
      fixed++;
    }

    lines.push(`\n## Results`);
    lines.push(`- Processed: ${fixed + failed}`);
    lines.push(`- ${dry_run ? "Would fix" : "Fixed"}: ${fixed}`);
    lines.push(`- Failed: ${failed}`);

    if (dry_run && fixed > 0) {
      lines.push(`\n---\n**Next step:** Run with \`dry_run: false\` to apply changes.`);
    }

  } else if (action === "add-links") {
    // ── Add ## Related [[wikilinks]] to files that have tags but no wikilinks ──
    const ADD_LINKS_AREAS = {
      notes:     path.join(BRAIN_PATH, "memory", "notes"),
      learnings: path.join(BRAIN_PATH, "memory", "learnings"),
      knowledge: path.join(BRAIN_PATH, "knowledge"),
    };

    const areasToProcess = scope === "all" ? Object.keys(ADD_LINKS_AREAS) : [scope].filter(k => ADD_LINKS_AREAS[k]);
    if (areasToProcess.length === 0) areasToProcess.push(...Object.keys(ADD_LINKS_AREAS));

    // Collect all files that need links
    const toFix = [];
    for (const areaKey of areasToProcess) {
      const dir = ADD_LINKS_AREAS[areaKey];
      if (!dir) continue;
      const files = walkNotes(dir);
      for (const { fullPath, relPath } of files) {
        if (toFix.length >= limit) break;
        const content = fs.readFileSync(fullPath, "utf8");
        if (!content.startsWith("---")) continue;
        if (content.includes("[[")) continue; // already has wikilinks
        const analysis = analyzeNote(fullPath);
        if (!analysis.hasTags || analysis.tags.length === 0) continue;
        toFix.push({ fullPath, relPath: `${areaKey}/${relPath}`, tags: analysis.tags, content });
      }
    }

    lines.push(`# Add [[wikilinks]] to brain files\n`);
    lines.push(`**Files to process:** ${toFix.length} (limit: ${limit})`);
    lines.push(`**Scope:** ${areasToProcess.join(", ")}`);
    lines.push(`**Mode:** ${dry_run ? "🔍 Dry run" : "✍️ Write mode"}\n`);

    let fixed = 0;
    let noMatch = 0;

    for (const file of toFix) {
      const related = _generateRelatedForNote(file.tags);
      if (!related) {
        noMatch++;
        continue;
      }

      const linkCount = (related.match(/\[\[/g) || []).length;

      if (dry_run) {
        lines.push(`- 🔗 **${file.relPath}** → +${linkCount} wikilinks`);
      } else {
        // Insert ## Related before last inline tags line, or at end
        let content = file.content;
        const lastLines = content.trimEnd().split("\n").slice(-3).join("\n");
        const hasInline = /(?<!\w)#[a-z][a-z0-9-]+/.test(lastLines);
        if (hasInline) {
          // Insert before inline tags
          const allLines = content.trimEnd().split("\n");
          let insertAt = allLines.length;
          for (let i = allLines.length - 1; i >= 0; i--) {
            if (/^#[a-z]/.test(allLines[i].trim())) insertAt = i;
            else break;
          }
          allLines.splice(insertAt, 0, ...related.trim().split("\n"));
          content = allLines.join("\n") + "\n";
        } else {
          content = content.trimEnd() + related;
        }
        fs.writeFileSync(file.fullPath, content, "utf8");
        lines.push(`- ✅ **${file.relPath}** → +${linkCount} wikilinks`);
      }
      fixed++;
    }

    lines.push(`\n## Results`);
    lines.push(`- Processed: ${toFix.length}`);
    lines.push(`- ${dry_run ? "Would fix" : "Fixed"}: ${fixed}`);
    lines.push(`- No match (no similar files): ${noMatch}`);

    if (dry_run && fixed > 0) {
      lines.push(`\n---\n**Next step:** Run with \`dry_run: false\` to apply.`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
