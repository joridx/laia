/**
 * Pure utility functions for LAIA Brain.
 * Text processing, parsing, path handling — no I/O, no fs, no BRAIN_PATH.
 */

import * as path from "path";

// ─── Cross-platform path normalizer ──────────────────────────────────────────

export const normPath = (p) => p.replace(/\\/g, "/");

// ─── Text utilities ──────────────────────────────────────────────────────────

export function slugify(text) {
  return text.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function sanitizeTag(tag) {
  return tag.toLowerCase()
    .replace("#", "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .split(/[\s\-_.,;:!?()\[\]{}'"\/\\|#*`>]+/)
    .filter(t => t.length >= 2);
}

export function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|td|th)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .trim();
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

export function parseLearningFrontmatter(content) {
  if (!content || !content.startsWith("---")) return null;

  // Require closing delimiter on its own line (not matching --- inside body)
  const endIdx = content.indexOf("\n---\n", 3);
  const endIdxCRLF = content.indexOf("\n---\r\n", 3);
  const endIdxEOF = content.indexOf("\n---", 3); // fallback: end of file
  const bestEnd = endIdx !== -1 ? endIdx
    : endIdxCRLF !== -1 ? endIdxCRLF
    : endIdxEOF !== -1 ? endIdxEOF
    : -1;
  if (bestEnd === -1) return null;

  const yamlBlock = content.slice(4, bestEnd);
  const body = content.slice(bestEnd + 4).trim();

  const fm = {};
  for (const rawLine of yamlBlock.split("\n")) {
    const line = rawLine.replace(/\r$/, ""); // normalize CRLF from imported notes
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "tags" || key === "connects" || key === "trigger_intents" || key === "preconditions") {
      const arrMatch = value.match(/\[([^\]]*)\]/);
      fm[key] = arrMatch ? arrMatch[1].split(",").map(t => t.trim()).filter(Boolean) : [];
    } else if (key === "protected") {
      fm[key] = value === "true";
    } else if (["steps", "used_count", "success_count"].includes(key)) {
      fm[key] = parseInt(value, 10) || 0;
    } else if (value.startsWith('"') && value.endsWith('"')) {
      fm[key] = value.slice(1, -1).replace(/\\\"/g, '"');
    } else {
      fm[key] = value;
    }
  }

  return { frontmatter: fm, body };
}

export function isLearningFile(filePath) {
  const normalized = normPath(filePath);
  return (normalized.includes("memory/learnings/") || normalized.includes("memory/notes/")) &&
         !normalized.includes("_legacy/") &&
         normalized.endsWith(".md");
}

export function isHumanNote(filePath) {
  return normPath(filePath).includes("memory/notes/");
}

/**
 * Derive a unique slug for a note in memory/notes/.
 * Includes subfolder path components to avoid collision with memory/learnings/.
 * Example: notes/docker/tips.md -> "docker-tips", notes/my-note.md -> "my-note"
 */
export function noteSlugFromPath(normalizedFp, notesDirNorm) {
  const rel = normalizedFp.replace(notesDirNorm + "/", "").replace(/\.md$/, "");
  // Convert path separators to hyphens: "docker/tips" -> "docker-tips"
  return rel.replace(/\//g, "-");
}

const VALID_TYPES = ["learning", "pattern", "warning", "principle", "bridge", "procedure"];
const TYPE_TAG_MAP = { warning: "#avoid", pattern: "#pattern", bridge: "#bridge", procedure: "#procedure" };

/** Normalize a concept slug for connects[] — same rules as sanitizeTag but preserving hyphens */
export function normalizeConnectSlug(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Safely quote a YAML string value: handles quotes, newlines, backslashes, control chars. */
function _yamlSafe(val) {
  if (typeof val !== 'string') return String(val);
  // If it contains special chars, double-quote with proper escaping
  if (/["\\\n\r\t\x00-\x1f:#{}[\],&*?|>!%@`]/.test(val)) {
    return '"' + val
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      + '"';
  }
  // Simple values can go unquoted, but quote anyway for safety
  return '"' + val.replace(/"/g, '\\"') + '"';
}

export function buildLearningMarkdown(title, type, tags, content, extra, { connects, provenance, procedureFields, protected: isProtected } = {}) {
  const safeType = VALID_TYPES.includes(type) ? type : "learning";
  const headline = (content.split("\n").find(l => l.trim()) || "").slice(0, 150);
  const typeTag = TYPE_TAG_MAP[safeType] || "#learning";
  const slug = slugify(title);
  const cleanTags = tags.map(sanitizeTag);

  // Normalize + dedupe connects
  const cleanConnects = connects
    ? [...new Set(connects.map(normalizeConnectSlug).filter(Boolean))]
    : [];

  let md = `---\n`;
  md += `title: "${title.replace(/"/g, '\\"')}"\n`;
  md += `headline: "${headline.replace(/"/g, '\\"')}"\n`;
  md += `type: ${safeType}\n`;
  md += `created: ${new Date().toISOString().split("T")[0]}\n`;
  md += `tags: [${cleanTags.join(", ")}]\n`;
  if (cleanConnects.length > 0) {
    md += `connects: [${cleanConnects.join(", ")}]\n`;
  }
  md += `slug: ${slug}\n`;
  // Protected flag (Golden Suite Lite)
  if (isProtected) {
    md += `protected: true\n`;
  }
  // Procedure-specific fields (Sprint 1A)
  if (safeType === "procedure" && procedureFields) {
    if (procedureFields.trigger_intents?.length > 0) {
      md += `trigger_intents: [${procedureFields.trigger_intents.join(", ")}]\n`;
    }
    if (procedureFields.preconditions?.length > 0) {
      md += `preconditions: [${procedureFields.preconditions.join(", ")}]\n`;
    }
    if (procedureFields.steps != null) {
      md += `steps: ${procedureFields.steps}\n`;
    }
    md += `used_count: ${procedureFields.used_count || 0}\n`;
    md += `success_count: ${procedureFields.success_count || 0}\n`;
    md += `last_outcome: ${procedureFields.last_outcome || "null"}\n`;
    md += `last_used: ${procedureFields.last_used || "null"}\n`;
  }
  // Source provenance fields (P15.0)
  if (provenance) {
    if (provenance.source_type) md += `source_type: ${provenance.source_type}\n`;
    if (provenance.source_session) md += `source_session: ${_yamlSafe(provenance.source_session)}\n`;
    if (provenance.source_context) md += `source_context: ${_yamlSafe(provenance.source_context)}\n`;
    if (provenance.created_by) md += `created_by: ${provenance.created_by}\n`;
    if (provenance.source_ref) md += `source_ref: ${_yamlSafe(provenance.source_ref)}\n`;
  }
  md += `---\n\n`;
  md += content + "\n";
  if (extra) md += extra;
  if (cleanTags.length > 0) {
    md += `\n${cleanTags.map(t => `#${t}`).join(" ")} ${typeTag}\n`;
  } else {
    md += `\n${typeTag}\n`;
  }
  return md;
}

// ─── Tag alias normalization (P7.5) ──────────────────────────────────────────

/**
 * Normalize an array of sanitized tags using an alias map.
 * aliasMap: { "alias": "canonical", ... }
 * Returns a deduplicated array with aliases replaced by canonical tags.
 */
export function applyTagAliases(tags, aliasMap) {
  if (!aliasMap || Object.keys(aliasMap).length === 0) return tags;
  const seen = new Set();
  const result = [];
  for (const tag of tags) {
    const canonical = aliasMap[tag] || tag;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

// ─── Tag extraction ──────────────────────────────────────────────────────────

export const KNOWN_KEYWORDS = {
  bash: ["bash", "shell", "script", "sh", "set -e", "#!/bin", "export", "source", "chmod", "chown"],
  docker: ["docker", "container", "dockerfile", "docker-compose", "swarm", "kubernetes", "k8s"],
  git: ["git", "commit", "push", "pull", "merge", "rebase", "checkout", "branch", "stash"],
  api: ["curl", "fetch", "api", "rest", "endpoint", "bearer", "token", "authorization"],
  scala: ["scala", "spark", "sbt", "akka", "parquet", "dataframe"],
  sql: ["sql", "query", "select", "insert", "update", "delete", "join", "index"],
  auth: ["auth", "token", "bearer", "password", "credential", "secret", "api_key"],
  compression: ["gzip", "deflate", "compress", "zip", "tar", "pigz"],
  deployment: ["deploy", "release", "production", "staging", "ci/cd", "pipeline"]
};

export function extractTags(text) {
  const lowerText = text.toLowerCase();
  const foundTags = new Set();

  for (const [tag, keywords] of Object.entries(KNOWN_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        foundTags.add(tag);
        break;
      }
    }
  }

  return Array.from(foundTags);
}

// ─── Project detection ───────────────────────────────────────────────────────

export function detectProjectFromPath(cwd) {
  if (!cwd) return null;

  const normalized = normPath(cwd);
  const patterns = [
    /\/(bi-[^/]+)/,
    /\/([^/]+-engine)/,
    /\/([^/]+)$/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return match[1];
  }

  return null;
}
