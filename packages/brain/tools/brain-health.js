/**
 * Tool: brain_health
 * Diagnostics: JSON integrity, orphans, stats, metrics, quality audit.
 */

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";

import { BRAIN_PATH, LEARNINGS_DIR, GIT_SYNC_ENABLED } from "../config.js";
import { readFile, readJSON } from "../file-io.js";
import { gitIsRepo } from "../git-sync.js";
import {
  getAllLearnings, computeAllVitalities, computeRelevanceMetrics
} from "../learnings.js";
import { detectClusters } from "../maintenance.js";
import {
  isDbAvailable, getDb, getDbStats, checkFtsIntegrity,
  getActivationStatsFromDb, getEmbeddingDbStats,
  loadAllEmbeddings, metaRepo
} from "../database.js";
import { readTodos } from "../todos.js";
import { getPageRankMap } from "../graph.js";
import { isLlmAvailable, getBudgetStatus } from "../llm.js";
import {
  isEmbeddingsAvailable, getEmbeddingStats
} from "../embeddings.js";
import {
  planDistillation, getDistillStatus,
  computeDistillMetrics, computeDistillEffectiveness
} from "../distillation.js";
import { parseLearningFrontmatter } from "../utils.js";
import { readMeta, readMetrics, SEARCH_LOG_MAX } from "./shared.js";

export const name = "brain_health";
export const description = "Diagnostics: JSON integrity, orphans, stats, metrics. duplicates:true for clusters. quality:true for learning quality audit.";
export const schema = {
  duplicates: z.boolean().optional().describe("Run cluster & duplicate detection analysis (slower, uses pairwise Jaccard on all learnings)"),
  quality: z.boolean().optional().describe("Run quality audit: flags weak titles, missing tags, short bodies, type mismatches (no auto-fix)")
};

export async function handler({ duplicates, quality } = {}) {
    const issues = [];
    const lines = ["# Brain Health Report\n"];

    // A. JSON Integrity
    lines.push("## JSON Integrity");
    const jsonFiles = ["index.json", "metrics.json", "relations.json", "learnings-meta.json"];
    for (const f of jsonFiles) {
      const fullPath = path.join(BRAIN_PATH, f);
      const parsed = readJSON(f);
      if (parsed) {
        try {
          const size = fs.statSync(fullPath).size;
          const sizeStr = size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
          lines.push(`- ✅ ${f} (${sizeStr})`);
        } catch { lines.push(`- ✅ ${f}`); }
      } else if (!fs.existsSync(fullPath)) {
        lines.push(`- ⚠️ ${f} (missing)`);
        issues.push(`${f} missing`);
      } else {
        lines.push(`- ❌ ${f} (parse error)`);
        issues.push(`${f} corrupt`);
      }
    }

    // B. Learnings Consistency
    lines.push("\n## Learnings Consistency");
    const learningsDir = path.join(BRAIN_PATH, LEARNINGS_DIR);
    let learningFiles = [];
    if (fs.existsSync(learningsDir)) {
      learningFiles = fs.readdirSync(learningsDir)
        .filter(f => f.endsWith(".md") && !f.startsWith("_"));
    }
    const learningFileSlugs = new Set(learningFiles.map(f => f.replace(".md", "")));

    const meta = readMeta();
    const metaSlugs = new Set(meta?.learnings ? Object.keys(meta.learnings) : []);

    // Orphan detection: check actual file path from meta entry (handles knowledge/, notes/, etc.)
    const orphans = [...metaSlugs].filter(s => {
      if (learningFileSlugs.has(s)) return false;
      const entry = meta.learnings[s];
      if (entry?.file) {
        const fullPath = path.join(BRAIN_PATH, entry.file);
        if (fs.existsSync(fullPath)) return false;
      }
      return true;
    });
    const untracked = [...learningFileSlugs].filter(s => !metaSlugs.has(s));

    let invalidFm = 0;
    for (const f of learningFiles) {
      const content = readFile(`${LEARNINGS_DIR}/${f}`);
      if (!parseLearningFrontmatter(content)) invalidFm++;
    }

    const vitalityMap = computeAllVitalities({ forceRecompute: true });
    const zoneCounts = { active: 0, stale: 0, cold: 0, fading: 0, archived: 0 };
    let totalVitality = 0;
    let vitalityCount = 0;
    for (const [slug] of Object.entries(meta?.learnings || {})) {
      const vData = vitalityMap.get(slug);
      const zone = vData?.zone || "active";
      zoneCounts[zone] = (zoneCounts[zone] || 0) + 1;
      if (vData?.vitality !== undefined) {
        totalVitality += vData.vitality;
        vitalityCount++;
      }
    }
    const avgVitality = vitalityCount > 0 ? (totalVitality / vitalityCount).toFixed(3) : "N/A";

    lines.push(`- Total: ${learningFiles.length} files, ${metaSlugs.size} meta entries`);

    // V4: Protected count
    const protectedCount = Object.values(meta?.learnings || {}).filter(d => d.protected || d.type === "principle").length;
    const procedureCount = Object.values(meta?.learnings || {}).filter(d => d.type === "procedure").length;
    if (protectedCount > 0) lines.push(`- Protected (immune to decay): **${protectedCount}** 🛡️`);
    if (procedureCount > 0) lines.push(`- Procedures: **${procedureCount}**`);
    lines.push(`- Orphans (meta without file): ${orphans.length}`);
    if (orphans.length > 0) {
      issues.push(`${orphans.length} orphan meta entries: ${orphans.slice(0, 5).join(", ")}`);
      for (const o of orphans.slice(0, 5)) lines.push(`  - ${o}`);
    }
    lines.push(`- Untracked (file without meta): ${untracked.length}`);
    if (untracked.length > 0) {
      issues.push(`${untracked.length} untracked learnings: ${untracked.slice(0, 5).join(", ")}`);
      for (const u of untracked.slice(0, 5)) lines.push(`  - ${u}`);
    }
    lines.push(`- Invalid frontmatter: ${invalidFm}`);
    if (invalidFm > 0) issues.push(`${invalidFm} learnings with invalid frontmatter`);
    lines.push(`- Vitality zones: **${zoneCounts.active}** active | **${zoneCounts.stale}** stale | **${zoneCounts.cold || 0}** cold | **${zoneCounts.fading}** fading | **${zoneCounts.archived}** archived`);
    lines.push(`- Average vitality: ${avgVitality}`);

    // V2: Memory Quality Dashboard
    const metaEntries = Object.values(meta?.learnings || {});
    const neverHit = metaEntries.filter(d => !d.archived && (!d.hit_count || d.hit_count === 0)).length;
    const totalActive = metaEntries.filter(d => !d.archived).length;
    const neverHitPct = totalActive > 0 ? ((neverHit / totalActive) * 100).toFixed(1) : '0';
    const coldCount = zoneCounts.cold || 0;

    // Type breakdown with avg vitality
    const typeStats = {};
    for (const [slug, data] of Object.entries(meta?.learnings || {})) {
      if (data.archived) continue;
      const t = data.type || 'learning';
      if (!typeStats[t]) typeStats[t] = { count: 0, totalV: 0 };
      typeStats[t].count++;
      const vData = vitalityMap.get(slug);
      typeStats[t].totalV += vData?.vitality ?? 0;
    }

    lines.push(`\n## Memory Quality (V2)`);
    lines.push(`- Never hit: **${neverHit}** (${neverHitPct}% of active)`);
    lines.push(`- Cold (hidden from default search): **${coldCount}**`);
    lines.push(`- Type breakdown:`);
    for (const [type, stats] of Object.entries(typeStats).sort((a,b) => b[1].count - a[1].count)) {
      const avgV = stats.count > 0 ? (stats.totalV / stats.count).toFixed(2) : 'N/A';
      lines.push(`  - **${type}**: ${stats.count} (avg vitality: ${avgV})`);
    }

    // Memory health grade
    const activePct = totalActive > 0 ? (zoneCounts.active / totalActive) : 0;
    const neverHitRatio = totalActive > 0 ? (neverHit / totalActive) : 0;
    let grade = 'F';
    if (activePct > 0.80 && neverHitRatio < 0.05) grade = 'A';
    else if (activePct > 0.60 && neverHitRatio < 0.15) grade = 'B';
    else if (activePct > 0.40 && neverHitRatio < 0.30) grade = 'C';
    else if (activePct > 0.20) grade = 'D';
    lines.push(`- **Memory Health Grade: ${grade}** (${(activePct*100).toFixed(0)}% active, ${neverHitPct}% never-hit)`);

    const archivedCount = meta?.learnings
      ? Object.values(meta.learnings).filter(d => d.archived).length : 0;
    const archiveDir = path.join(learningsDir, "_archive");
    const archiveFiles = fs.existsSync(archiveDir)
      ? fs.readdirSync(archiveDir).filter(f => f.endsWith("_archived.md")).length : 0;
    lines.push(`- Archived: ${archivedCount} (in ${archiveFiles} archive files)`);

    // C. Knowledge Graph
    lines.push("\n## Knowledge Graph");
    const relations = readJSON("relations.json");
    let totalConcepts = 0;
    let totalRelations = 0;
    let brokenRefs = [];
    if (relations?.concepts) {
      const conceptNames = new Set(Object.keys(relations.concepts));
      totalConcepts = conceptNames.size;
      for (const [name, data] of Object.entries(relations.concepts)) {
        const neighbors = [
          ...(data.related_to || []),
          ...(data.parent ? [data.parent] : []),
          ...(data.children || [])
        ];
        totalRelations += neighbors.length;
        for (const n of neighbors) {
          if (!conceptNames.has(n)) brokenRefs.push(`${name} → ${n}`);
        }
      }
    }
    lines.push(`- Concepts: ${totalConcepts}`);
    lines.push(`- Total relations: ${totalRelations}`);
    lines.push(`- Broken references: ${brokenRefs.length}`);
    if (brokenRefs.length > 0) {
      issues.push(`${brokenRefs.length} broken graph references`);
      for (const b of brokenRefs.slice(0, 5)) lines.push(`  - ${b}`);
    }

    // C2. Spreading Activation (P4.6)
    lines.push("\n## Spreading Activation");
    if (isDbAvailable()) {
      const actStats = getActivationStatsFromDb();
      if (actStats) {
        lines.push(`- Active concepts: ${actStats.total}`);
        if (actStats.top.length > 0) {
          lines.push("- Top activated:");
          for (const { concept, activation } of actStats.top.slice(0, 5)) {
            lines.push(`  - **${concept}**: ${activation.toFixed(3)}`);
          }
        }
      } else {
        lines.push("- No activations recorded yet");
      }
    } else {
      lines.push("- Requires SQLite (better-sqlite3)");
    }

    // D. Volume
    lines.push("\n## Volume");
    const countFiles = (dir) => {
      const fullDir = path.join(BRAIN_PATH, dir);
      if (!fs.existsSync(fullDir)) return 0;
      return fs.readdirSync(fullDir).filter(f => f.endsWith(".md") && !f.startsWith("_")).length;
    };
    const learningsCount = countFiles("memory/learnings");
    const sessionsCount = countFiles("memory/sessions");
    const projectsCount = countFiles("memory/projects");
    let knowledgeCount = 0;
    const knowledgeDir = path.join(BRAIN_PATH, "knowledge");
    if (fs.existsSync(knowledgeDir)) {
      const walkDir = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walkDir(path.join(dir, entry.name));
          else if (entry.name.endsWith(".md")) knowledgeCount++;
        }
      };
      walkDir(knowledgeDir);
    }
    const metrics = readMetrics();
    const totalQueries = metrics?.total_queries || 0;

    const todosData = readTodos();
    const todosPending = todosData.filter(t => t.status === "pending" || t.status === "in_progress").length;
    lines.push(`- TODOs: ${todosData.length} total (${todosPending} pending)`);
    lines.push(`- Learnings: ${learningsCount}`);
    lines.push(`- Sessions: ${sessionsCount}`);
    lines.push(`- Projects: ${projectsCount}`);
    // Count Obsidian notes (memory/notes/) with diagnostics
    let notesCount = 0;
    let notesNoFrontmatter = 0;
    let notesNoTags = 0;
    let notesEmpty = 0;
    const notesDir = path.join(BRAIN_PATH, "memory", "notes");
    if (fs.existsSync(notesDir)) {
      const walkNotes = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walkNotes(path.join(dir, entry.name));
          else if (entry.name.endsWith(".md")) {
            notesCount++;
            try {
              const content = fs.readFileSync(path.join(dir, entry.name), "utf8");
              if (!content.trim() || content.trim().length < 10) notesEmpty++;
              else if (!content.startsWith("---")) notesNoFrontmatter++;
              else {
                const fmEnd = content.indexOf("---", 4);
                if (fmEnd === -1) notesNoFrontmatter++;
                else {
                  const fm = content.slice(4, fmEnd);
                  if (!fm.includes("tags:") && !fm.includes("tag:")) notesNoTags++;
                }
              }
            } catch { notesNoFrontmatter++; }
          }
        }
      };
      walkNotes(notesDir);
    }
    lines.push(`- Knowledge: ${knowledgeCount}`);
    lines.push(`- Obsidian notes: ${notesCount}`);
    if (notesCount > 0) {
      lines.push(`  - No frontmatter: ${notesNoFrontmatter}`);
      lines.push(`  - No tags: ${notesNoTags}`);
      lines.push(`  - Empty/tiny: ${notesEmpty}`);
      const notesHealthy = notesCount - notesNoFrontmatter - notesNoTags - notesEmpty;
      lines.push(`  - Well-formed: ${notesHealthy} (${(notesHealthy / notesCount * 100).toFixed(0)}%)`);
      if (notesNoFrontmatter + notesNoTags > notesCount * 0.5) {
        issues.push(`${notesNoFrontmatter + notesNoTags} Obsidian notes without frontmatter/tags (>${(50)}%)`);
      }
    }
    lines.push(`- Total queries: ${totalQueries}`);

    // E. Usage Metrics
    lines.push("\n## Usage Metrics");
    lines.push(`**Total queries:** ${totalQueries}`);
    lines.push(`**Last prune:** ${metrics?.last_prune || "never"}`);
    lines.push(`**Last consolidation:** ${metrics?.last_consolidation || "never"}`);
    lines.push(`**Last archive:** ${metrics?.last_archive_learnings || "never"}`);
    lines.push(`**Total archived:** ${metrics?.total_archived_learnings || 0}`);

    if (metrics?.tag_hits) {
      const sortedTags = Object.entries(metrics.tag_hits)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      if (sortedTags.length > 0) {
        lines.push("\n**Top Tags:**");
        for (const [tag, hits] of sortedTags) {
          if (hits > 0) lines.push(`- **${tag}**: ${hits} hits`);
        }
      }
    }

    if (metrics?.search_hits) {
      const sortedSearches = Object.entries(metrics.search_hits)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      if (sortedSearches.length > 0) {
        lines.push("\n**Top Searches:**");
        for (const [query, hits] of sortedSearches) {
          lines.push(`- **"${query}"**: ${hits} times`);
        }
      }
    }

    // F. Git Sync
    lines.push("\n## Git Sync");
    const gitRepo = gitIsRepo();
    if (!gitRepo.isRepo) {
      lines.push(`- Status: not a git repo${gitRepo.reason ? ` (${gitRepo.reason})` : ""}`);
    } else {
      lines.push(`- Repository: ✅`);
      lines.push(`- Remote: ${gitRepo.hasRemote ? "✅ configured" : "⚠️ none"}`);
      // Import gitExec for health check details
      const { gitExec } = await import("../git-sync.js");
      const gitSt = gitExec(["status", "--porcelain"]);
      const pendingChanges = gitSt.ok ? gitSt.stdout.split("\n").filter(Boolean).length : 0;
      lines.push(`- Pending changes: ${pendingChanges}`);
      const lastCommit = gitExec(["log", "-1", "--format=%h %s (%ar)"]);
      if (lastCommit.ok) lines.push(`- Last commit: ${lastCommit.stdout}`);
      if (gitRepo.hasRemote) {
        const remote = gitExec(["remote", "get-url", "origin"]);
        if (remote.ok) lines.push(`- Remote URL: ${remote.stdout}`);
        const ahead = gitExec(["rev-list", "--count", "@{u}..HEAD"]);
        const behind = gitExec(["rev-list", "--count", "HEAD..@{u}"]);
        if (ahead.ok && behind.ok) {
          lines.push(`- Ahead/Behind: ${ahead.stdout}/${behind.stdout}`);
        }
      }
      lines.push(`- Sync enabled: ${GIT_SYNC_ENABLED}`);
    }

    // G. SQLite Index
    lines.push("\n## SQLite Index");
    if (isDbAvailable()) {
      const db = getDb();
      if (db) {
        const stats = getDbStats(db);
        lines.push(`- Status: ✅ available`);
        lines.push(`- Size: ${stats.sizeMB} MB`);
        lines.push(`- Schema version: ${stats.schemaVersion}`);
        lines.push(`- Learnings indexed: ${stats.learnings?.total ?? stats.learningsCount}`);
        lines.push(`- Files indexed: ${stats.files ?? stats.filesCount}`);
        lines.push(`- Concepts: ${stats.graph?.concepts ?? stats.conceptsCount}, Edges: ${stats.graph?.edges ?? stats.edgesCount}`);
        lines.push(`- Last rebuild: ${stats.lastRebuild || "never"}`);
        const integrity = checkFtsIntegrity(db);
        if (integrity.ok) {
          lines.push(`- FTS5 integrity: ✅`);
        } else {
          lines.push(`- FTS5 integrity: ❌ ${integrity.error}`);
          issues.push(`FTS5 integrity check failed: ${integrity.error}`);
        }
      } else {
        lines.push(`- Status: ⚠️ driver loaded but DB unavailable`);
      }
    } else {
      lines.push(`- Status: ℹ️ better-sqlite3 not installed (optional)`);
    }

    // G2. Index Consistency (P16.16)
    lines.push("\n## Index Consistency (P16.16)");
    try {
      let consistencyIssues = 0;

      // 1. Embedding orphans & stale vectors
      if (isDbAvailable()) {
        const embedMap = loadAllEmbeddings();
        if (embedMap && embedMap.size > 0) {
          const orphanEmbeds = [];
          const staleEmbeds = [];

          // Lazy-import only if we have embeddings to check
          let computeHash = null;
          let buildText = null;
          try {
            const emb = await import("../embeddings.js");
            computeHash = emb.computeEmbeddingHash;
            buildText = emb.buildEmbeddingText;
          } catch { /* embeddings module not available */ }

          for (const [slug, data] of embedMap) {
            // Check if learning file exists
            const metaEntry = meta?.learnings?.[slug];
            const filePath = metaEntry?.file
              ? path.join(BRAIN_PATH, metaEntry.file)
              : path.join(BRAIN_PATH, LEARNINGS_DIR, `${slug}.md`);

            if (!fs.existsSync(filePath)) {
              orphanEmbeds.push(slug);
              continue;
            }

            // Check content hash staleness
            if (computeHash && buildText && data.contentHash) {
              try {
                const content = fs.readFileSync(filePath, "utf8");
                const fm = parseLearningFrontmatter(content);
                if (fm) {
                  const text = buildText(fm);
                  const currentHash = computeHash(text);
                  if (currentHash !== data.contentHash) {
                    staleEmbeds.push(slug);
                  }
                }
              } catch { /* read error — skip */ }
            }
          }

          lines.push(`- Embeddings stored: ${embedMap.size}`);
          lines.push(`- Orphan embeddings (no file): ${orphanEmbeds.length}`);
          if (orphanEmbeds.length > 0) {
            consistencyIssues += orphanEmbeds.length;
            issues.push(`${orphanEmbeds.length} orphan embedding(s)`);
            for (const o of orphanEmbeds.slice(0, 5)) lines.push(`  - ${o}`);
            if (orphanEmbeds.length > 5) lines.push(`  - ... and ${orphanEmbeds.length - 5} more`);
          }
          lines.push(`- Stale embeddings (content changed): ${staleEmbeds.length}`);
          if (staleEmbeds.length > 0) {
            consistencyIssues += staleEmbeds.length;
            issues.push(`${staleEmbeds.length} stale embedding(s)`);
            for (const s of staleEmbeds.slice(0, 5)) lines.push(`  - ${s}`);
            if (staleEmbeds.length > 5) lines.push(`  - ... and ${staleEmbeds.length - 5} more`);
          }
        } else {
          lines.push(`- Embeddings: none stored (signal hibernated)`);
        }

        // 2. SQLite ↔ JSON meta desync
        const sqliteMeta = metaRepo.getAll();
        const jsonMeta = readJSON("learnings-meta.json");
        if (sqliteMeta && jsonMeta?.learnings) {
          const desyncEntries = [];
          const sqliteSlugs = new Set(Object.keys(sqliteMeta));
          const jsonSlugs = new Set(Object.keys(jsonMeta.learnings));

          // Slugs in JSON but not SQLite
          const jsonOnly = [...jsonSlugs].filter(s => !sqliteSlugs.has(s));
          // Slugs in SQLite but not JSON
          const sqliteOnly = [...sqliteSlugs].filter(s => !jsonSlugs.has(s));

          // Field-level desync for common slugs
          const checkFields = ["title", "type", "hit_count", "search_appearances", "search_followup_hits"];
          for (const slug of jsonSlugs) {
            if (!sqliteSlugs.has(slug)) continue;
            const jd = jsonMeta.learnings[slug];
            const sd = sqliteMeta[slug];
            for (const field of checkFields) {
              const jv = jd[field] ?? (typeof sd[field] === "number" ? 0 : null);
              const sv = sd[field] ?? (typeof jd[field] === "number" ? 0 : null);
              if (jv !== sv && String(jv) !== String(sv)) {
                desyncEntries.push({ slug, field, json: jv, sqlite: sv });
                break; // one desync per slug is enough
              }
            }
          }

          lines.push(`- SQLite meta entries: ${sqliteSlugs.size}`);
          lines.push(`- JSON meta entries: ${jsonSlugs.size}`);
          lines.push(`- JSON-only (not in SQLite): ${jsonOnly.length}`);
          if (jsonOnly.length > 0) {
            consistencyIssues += jsonOnly.length;
            issues.push(`${jsonOnly.length} meta entries in JSON but not SQLite`);
            for (const s of jsonOnly.slice(0, 3)) lines.push(`  - ${s}`);
            if (jsonOnly.length > 3) lines.push(`  - ... and ${jsonOnly.length - 3} more`);
          }
          lines.push(`- SQLite-only (not in JSON): ${sqliteOnly.length}`);
          if (sqliteOnly.length > 0) {
            consistencyIssues += sqliteOnly.length;
            issues.push(`${sqliteOnly.length} meta entries in SQLite but not JSON`);
            for (const s of sqliteOnly.slice(0, 3)) lines.push(`  - ${s}`);
            if (sqliteOnly.length > 3) lines.push(`  - ... and ${sqliteOnly.length - 3} more`);
          }
          lines.push(`- Field desync (title/type/counters): ${desyncEntries.length}`);
          if (desyncEntries.length > 0) {
            consistencyIssues += desyncEntries.length;
            issues.push(`${desyncEntries.length} meta field desync(s) between JSON and SQLite`);
            for (const d of desyncEntries.slice(0, 5)) {
              lines.push(`  - \`${d.slug}\` → ${d.field}: JSON=${d.json}, SQLite=${d.sqlite}`);
            }
            if (desyncEntries.length > 5) lines.push(`  - ... and ${desyncEntries.length - 5} more`);
          }
        } else {
          lines.push(`- SQLite ↔ JSON sync: skipped (${!sqliteMeta ? "no SQLite" : "no JSON"})`);
        }
      } else {
        lines.push(`- Skipped (SQLite not available)`);
      }

      if (consistencyIssues === 0) {
        lines.push(`- ✅ All indexes consistent`);
      }
    } catch (e) {
      lines.push(`- ⚠️ Error during consistency check: ${e.message}`);
    }

    // H. BRAIN_PATH
    lines.push("\n## BRAIN_PATH");
    lines.push(`- Path: ${BRAIN_PATH}`);
    lines.push(`- Accessible: ✅`);

    // I. Skills & Service Endpoints (P5.3)
    // Count installed skills (*.md in commands/)
    const commandsDir = path.join(homedir(), ".laia", "commands");
    let skillCount = 0;
    try {
      skillCount = fs.readdirSync(commandsDir).filter(f => f.endsWith(".md")).length;
    } catch { /* dir may not exist */ }
    lines.push("\n## Skills & Service Endpoints");
    lines.push(`- Installed skills: **${skillCount}**`);
    const skillsHealthPath = path.join(homedir(), ".laia", ".skills-health.json");
    if (fs.existsSync(skillsHealthPath)) {
      try {
        const shData = JSON.parse(fs.readFileSync(skillsHealthPath, "utf8"));
        const { timestamp, checks, summary } = shData;
        const age = timestamp ? Math.floor((Date.now() - new Date(timestamp).getTime()) / (1000 * 60)) : null;
        const ageStr = age !== null
          ? (age < 60 ? `${age}m ago` : age < 1440 ? `${Math.floor(age / 60)}h ago` : `${Math.floor(age / 1440)}d ago`)
          : "unknown";
        lines.push(`- Last check: ${timestamp} (${ageStr})`);
        lines.push(`- Service endpoints: **${summary.ok}** OK, **${summary.fail}** failing (of ${summary.total})`);
        if (summary.fail > 0) {
          issues.push(`${summary.fail} service endpoint(s) failing`);
          for (const c of checks) {
            if (!c.ok) {
              lines.push(`  - ❌ **${c.service}**: ${c.error || `HTTP ${c.http}`} (${c.ms}ms)`);
            }
          }
        }
        if (age !== null && age > 1440) {
          lines.push(`- ⚠️ Last check is >24h old. Run: \`/monitor\``);
        }
      } catch (e) {
        lines.push(`- ⚠️ Error reading skills health: ${e.message}`);
      }
    } else {
      lines.push("- No health data. Run: `/monitor` to check services");
    }

    // J. LLM Enhancement
    lines.push("\n## LLM Enhancement");
    if (isLlmAvailable()) {
      const bs = getBudgetStatus();
      lines.push(`- Status: ✅ available (${bs.model})`);
      lines.push(`- Mode: ${bs.mode}`);
      lines.push(`- Budget: ${bs.used}/${bs.limit} units used (${bs.remaining} remaining)`);
      lines.push(`- Calls: ${bs.calls} total, ${bs.errors} errors`);
      if (bs.disabled) lines.push(`- ⚠️ **Circuit breaker active** (3+ consecutive errors)`);
    } else {
      const bs = getBudgetStatus();
      const reason = bs.mode === "false" ? "disabled (BRAIN_LLM_ENABLED=false)" : bs.disabled ? "circuit breaker active" : "no Copilot token found";
      lines.push(`- Status: ℹ️ ${reason}`);
    }

    // K2. Embeddings (P9.2)
    lines.push("\n## Embeddings (P9.2)");
    if (isEmbeddingsAvailable()) {
      const embStats = getEmbeddingStats();
      const embDbStats = getEmbeddingDbStats();
      lines.push(`- Status: ✅ available`);
      lines.push(`- Model: ${embStats.model} (${embStats.dimension}d)`);
      lines.push(`- Backend: ${embStats.backend}`);
      lines.push(`- Load time: ${embStats.loadTimeMs}ms`);
      lines.push(`- Embeddings stored: ${embDbStats?.total || 0} / ${learningsCount} learnings`);
      lines.push(`- Avg embed time: ${embStats.avgEmbedMs}ms (${embStats.embedCount} calls)`);
    } else {
      const embEnabled = process.env.BRAIN_EMBEDDINGS_ENABLED || "auto";
      const reason = embEnabled === "false" ? "disabled (BRAIN_EMBEDDINGS_ENABLED=false)" : "model not loaded (check @huggingface/transformers)";
      lines.push(`- Status: ℹ️ ${reason}`);
    }

    // K1. Search Relevance (P10.3)
    lines.push("\n## Search Relevance (P10.3)");
    const relevance = computeRelevanceMetrics();
    if (relevance && relevance.totalAppearances > 0) {
      const pct = relevance.overallConversion !== null ? (relevance.overallConversion * 100).toFixed(1) : "N/A";
      lines.push(`- Overall conversion: **${pct}%** (smoothed, ${relevance.totalFollowups} followups / ${relevance.totalAppearances} appearances)`);
      const searchLog = (readMetrics())?.search_log || [];
      lines.push(`- Search log: ${searchLog.length}/${SEARCH_LOG_MAX} entries`);
      if (relevance.noiseList.length > 0) {
        lines.push(`- Noise candidates (high appearances, low conversion):`);
        for (const n of relevance.noiseList) {
          lines.push(`  - **${n.title}** (${n.conversion}% — ${n.followups}/${n.appearances})`);
        }
      } else {
        lines.push(`- Noise candidates: none yet (need learnings with >= 20 appearances)`);
      }
    } else {
      lines.push(`- No data yet. Search appearances will accumulate over time.`);
    }

    // L. Cluster & Duplicate Analysis (P7.2 — opt-in)
    if (duplicates) {
      lines.push("\n## Cluster & Duplicate Analysis (P7.2)");
      const clusterResult = detectClusters();
      const { clusters, stats } = clusterResult;

      lines.push(`- Learnings analyzed: ${stats.total_learnings}`);
      lines.push(`- Learnings in clusters: ${stats.in_clusters}`);
      lines.push(`- Clusters found: ${stats.clusters_found}`);
      lines.push(`  - Merge candidates: ${stats.merge_candidates}`);
      lines.push(`  - Distill candidates: ${stats.distill_candidates}`);
      lines.push(`  - Review candidates: ${stats.review_candidates}`);
      if (stats.avg_quality !== undefined) {
        lines.push(`  - Avg cluster quality: ${stats.avg_quality} (P12.2)`);
      }

      if (clusters.length > 0) {
        for (let ci = 0; ci < clusters.length; ci++) {
          const c = clusters[ci];
          lines.push(`\n### Cluster ${ci + 1} — ${c.suggested_action.toUpperCase()} (${c.size} learnings, max sim: ${c.max_similarity}, quality: ${c.quality_score || '?'})`);
          lines.push(`**Tags:** ${c.tags_union.join(", ")}`);
          for (let ti = 0; ti < c.titles.length; ti++) {
            lines.push(`- \`${c.slugs[ti]}\`: ${c.titles[ti]}`);
          }
          if (c.top_pairs.length > 0) {
            lines.push("**Most similar pairs:**");
            for (const p of c.top_pairs) {
              lines.push(`- ${p.slugA} <-> ${p.slugB} (combined: ${p.combined}, title: ${p.titleSim}, body: ${p.bodySim}, tags: ${p.tagOverlap})`);
            }
          }
        }
      } else {
        lines.push("- No clusters or duplicates detected.");
      }
    }

    // M. Quality Audit (P14.2 — opt-in)
    if (quality) {
      lines.push("\n## Quality Audit (P14.2)");
      const allLearnings = getAllLearnings();
      const qIssues = { weakTitle: [], missingTags: [], shortBody: [], emptyBody: [], typeMismatch: [], staleHighHits: [], duplicateTags: [] };

      // Type-aware body length thresholds
      const bodyMinByType = { warning: 30, pattern: 50, learning: 50, principle: 50, bridge: 40 };

      for (const l of allLearnings) {
        const title = l.title || "";
        const tags = l.tags || [];
        const body = (l.body || "").trim();
        const type = l.type || "learning";

        // Weak title: too short (<15 chars)
        if (title.length < 15) {
          qIssues.weakTitle.push({ slug: l.slug, title, reason: `${title.length} chars` });
        }

        // Missing tags: 0 or 1 tag (should have ≥2)
        if (tags.length < 2) {
          qIssues.missingTags.push({ slug: l.slug, title, tags: tags.length });
        }

        // Duplicate tags
        const uniqueTags = new Set(tags);
        if (uniqueTags.size < tags.length) {
          qIssues.duplicateTags.push({ slug: l.slug, title, dupes: tags.length - uniqueTags.size });
        }

        // Empty body
        const minBody = bodyMinByType[type] || 50;
        if (!body || body.length === 0) {
          qIssues.emptyBody.push({ slug: l.slug, title });
        }
        // Short body: type-aware threshold
        else if (body.length < minBody) {
          qIssues.shortBody.push({ slug: l.slug, title, len: body.length, min: minBody });
        }

        // Type mismatch: warning without semantic tag, bridge without valid connects
        if (type === "warning" && !tags.some(t => ["avoid", "warning", "error", "bug", "workaround"].includes(t))) {
          qIssues.typeMismatch.push({ slug: l.slug, title, reason: "warning without warning/avoid/error tag" });
        }
        if (type === "bridge") {
          const conn = Array.isArray(l.connects) ? l.connects : [];
          if (conn.length < 2) {
            qIssues.typeMismatch.push({ slug: l.slug, title, reason: "bridge without ≥2 connects" });
          } else if (new Set(conn).size < conn.length) {
            qIssues.typeMismatch.push({ slug: l.slug, title, reason: "bridge with duplicate connects" });
          }
        }
      }

      // Stale-but-high-hits mismatch (renamed from staleHighVitality for clarity)
      const _meta2 = readMeta();
      if (_meta2?.learnings) {
        const vMap = computeAllVitalities();
        for (const [slug, data] of Object.entries(_meta2.learnings)) {
          const vData = vMap.get(slug);
          if (vData && vData.zone === "stale" && (data.hit_count || 0) >= 10) {
            qIssues.staleHighHits.push({ slug, title: data.title || slug, hits: data.hit_count, zone: vData.zone });
          }
        }
      }

      // Report
      const totalIssues = Object.values(qIssues).reduce((s, arr) => s + arr.length, 0);
      lines.push(`- Learnings analyzed: ${allLearnings.length}`);
      lines.push(`- Quality issues found: **${totalIssues}**`);

      const sections = [
        ["weakTitle", "Weak titles (<15 chars)", (i) => `\`${i.slug.slice(0, 50)}\` — "${i.title}" (${i.reason})`],
        ["missingTags", "Missing tags (<2)", (i) => `\`${i.slug.slice(0, 50)}\` — "${i.title.slice(0, 50)}" (${i.tags} tags)`],
        ["duplicateTags", "Duplicate tags", (i) => `\`${i.slug.slice(0, 50)}\` — "${i.title.slice(0, 50)}" (${i.dupes} dupes)`],
        ["emptyBody", "Empty body", (i) => `\`${i.slug.slice(0, 50)}\` — "${i.title.slice(0, 50)}"`],
        ["shortBody", "Short body (type-aware)", (i) => `\`${i.slug.slice(0, 50)}\` — "${i.title.slice(0, 50)}" (${i.len}/${i.min} chars)`],
        ["typeMismatch", "Type mismatches", (i) => `\`${i.slug.slice(0, 50)}\` — ${i.reason}`],
        ["staleHighHits", "Stale but frequently accessed (≥10 hits)", (i) => `\`${i.slug.slice(0, 50)}\` — ${i.hits} hits, zone: ${i.zone}`]
      ];

      for (const [key, label, fmt] of sections) {
        const items = qIssues[key];
        if (items.length > 0) {
          lines.push(`\n### ${label} (${items.length})`);
          for (const item of items.slice(0, 15)) {
            lines.push(`- ${fmt(item)}`);
          }
          if (items.length > 15) lines.push(`- ... and ${items.length - 15} more`);
          issues.push(`${items.length} ${label.toLowerCase()}`);
        }
      }

      if (totalIssues === 0) {
        lines.push("- ✅ No quality issues found");
      }
    }

    // P10.4: Distillation metrics
    try {
      const distMetrics = computeDistillMetrics();
      const distStatus = getDistillStatus();
      lines.push("\n## Distillation Health");
      lines.push(`- Active notes: ${distMetrics.activeNotes} | Principle notes: ${distMetrics.principleNotes}`);
      lines.push(`- Ratio (active/principles): ${distMetrics.ratio ?? "N/A"}`);
      if (distMetrics.ratio !== null && distMetrics.ratio > 3.0) {
        lines.push(`- Ratio > 3.0 — consider running brain_distill action:plan`);
        issues.push("distillation ratio > 3.0");
      }
      lines.push(`- Queue: ${distStatus.pending} pending | ${distStatus.drafted} drafted | ${distStatus.approved} approved`);
      if (distStatus.lastPlanAt) lines.push(`- Last plan: ${distStatus.lastPlanAt}`);
    } catch { /* non-blocking */ }

    // P12.4: Distillation effectiveness measurement
    try {
      const eff = computeDistillEffectiveness();
      if (eff) {
        lines.push("\n## Distillation Effectiveness (P12.4)");

        // Principle retrieval
        const p = eff.principles;
        lines.push(`- Principles: ${p.count} | In searches: ${p.withAppearances} | Confirmed: ${p.withConfirmations}`);
        lines.push(`- Appearances: ${p.totalAppearances} | Followups: ${p.totalFollowups} | Confirmations: ${p.totalConfirmations}`);
        lines.push(`- Exposure conversion: ${(p.exposureConversion * 100).toFixed(1)}% | Adoption rate: ${(p.adoptionRate * 100).toFixed(1)}%`);
        if (p.stalePrinciples.length > 0) {
          lines.push(`- \u26a0\ufe0f ${p.stalePrinciples.length} stale principle(s) (21+ days, 0 appearances):`);
          for (const sp of p.stalePrinciples) {
            lines.push(`  - \`${sp.slug.slice(0, 45)}\` (${sp.ageDays}d old)`);
          }
          issues.push(`${p.stalePrinciples.length} stale principles`);
        }

        // Sources
        const s = eff.sources;
        lines.push(`- Archived sources: ${s.archived} | Noise reduction: ${(s.noiseReduction * 100).toFixed(0)}%`);
        if (s.archivedAppearances > 0) {
          lines.push(`- \u26a0\ufe0f Archived sources still appearing in searches (${s.archivedAppearances} times)`);
          issues.push("archived sources still appearing");
        }

        // Pipeline
        const pl = eff.pipeline;
        lines.push(`- Pipeline: ${pl.pending} pending | ${pl.drafted} drafted | ${pl.approved} approved | ${pl.rejected} rejected`);
        if (pl.approvalRate !== null) {
          lines.push(`- Approval rate: ${(pl.approvalRate * 100).toFixed(0)}%`);
        }
        if (pl.avgApprovedQuality !== null) {
          lines.push(`- Avg quality — approved: ${pl.avgApprovedQuality} | rejected: ${pl.avgRejectedQuality ?? "N/A"}`);
        }

        // Effectiveness score
        const e = eff.effectiveness;
        lines.push(`- Effectiveness: ${e.effectivenessScore} (raw: ${e.rawScore}, confidence: ${e.dataConfidence}, status: ${e.scoreStatus})`);
        lines.push(`- ${e.interpretation}`);
      }
    } catch { /* non-blocking */ }

    // P12.3: Principle confirmation stats
    try {
      const _meta = readMeta();
      const principles = Object.entries(_meta?.learnings || {})
        .filter(([, d]) => d.type === "principle")
        .map(([slug, d]) => ({
          slug,
          title: (d.title || slug).slice(0, 60),
          confirmations: d.confirmation_count || 0,
          lastConfirmed: d.last_confirmed || null,
          appearances: d.search_appearances || 0,
          followups: d.search_followup_hits || 0
        }))
        .sort((a, b) => b.confirmations - a.confirmations);

      if (principles.length > 0) {
        lines.push("\n## Principle Confirmation (P12.3)");
        const totalConf = principles.reduce((s, p) => s + p.confirmations, 0);
        const confirmed = principles.filter(p => p.confirmations > 0).length;
        lines.push(`- Principles: ${principles.length} | Confirmed: ${confirmed} | Total confirmations: ${totalConf}`);
        for (const p of principles) {
          const boost = (1.15 + 0.20 * (1 - Math.exp(-p.confirmations / 4))).toFixed(3);
          const lastConf = p.lastConfirmed ? ` (last: ${p.lastConfirmed.split("T")[0]})` : "";
          lines.push(`- \`${p.slug.slice(0, 45)}\` — ${p.confirmations} conf (boost: ${boost}x) | app: ${p.appearances}, fup: ${p.followups}${lastConf}`);
        }
        if (confirmed === 0) {
          lines.push("- ⚠️ No principles confirmed yet — confirmation requires search → followup attribution");
        }
        const overBoosted = principles.filter(p => p.confirmations > 15);
        if (overBoosted.length > 0) {
          lines.push(`- ⚠️ ${overBoosted.length} principle(s) with >15 confirmations — check for gaming/data skew`);
          issues.push(`${overBoosted.length} over-confirmed principles`);
        }
      }
    } catch { /* non-blocking */ }

    // ─── QW1: Top/Bottom 5 Learnings (by search utility) ────────────────────
    try {
      const metaEntries2 = Object.entries(meta?.learnings || {})
        .filter(([, d]) => !d.archived)
        .map(([slug, d]) => ({
          slug,
          title: (d.title || slug).slice(0, 55),
          hits: d.hit_count || 0,
          appearances: d.search_appearances || 0,
          followups: d.search_followup_hits || 0,
          vitality: vitalityMap.get(slug)?.vitality ?? 0,
          utility: (d.search_appearances || 0) * 2 + (d.search_followup_hits || 0) * 5 + (d.hit_count || 0)
        }));

      if (metaEntries2.length >= 10) {
        const sorted = metaEntries2.sort((a, b) => b.utility - a.utility);
        lines.push("\n## Top 5 Most Useful Learnings");
        for (const l of sorted.slice(0, 5)) {
          lines.push(`- **${l.title}** (utility:${l.utility} | app:${l.appearances} fup:${l.followups} hits:${l.hits} v:${l.vitality.toFixed(2)})`);
        }

        const bottom = sorted.filter(l => l.utility === 0);
        if (bottom.length > 0) {
          lines.push(`\n## Bottom Learnings (never used: ${bottom.length})`);
          const sample = bottom.slice(0, 5);
          for (const l of sample) {
            lines.push(`- **${l.title}** (v:${l.vitality.toFixed(2)})`);
          }
          if (bottom.length > 5) lines.push(`  ... and ${bottom.length - 5} more`);
        }
      }
    } catch { /* non-blocking */ }

    // ─── QW2: Graph Stats (components, orphans, degree, PageRank) ────────────
    try {
      if (relations?.concepts && Object.keys(relations.concepts).length > 0) {
        const concepts = relations.concepts;
        const conceptNames = Object.keys(concepts);
        const n = conceptNames.length;

        // Build adjacency list
        const adj = new Map();
        for (const name of conceptNames) adj.set(name, new Set());
        for (const [name, data] of Object.entries(concepts)) {
          for (const rel of (data.related_to || [])) {
            if (adj.has(rel)) { adj.get(name).add(rel); adj.get(rel).add(name); }
          }
          if (data.parent && adj.has(data.parent)) {
            adj.get(name).add(data.parent); adj.get(data.parent).add(name);
          }
          for (const child of (data.children || [])) {
            if (adj.has(child)) { adj.get(name).add(child); adj.get(child).add(name); }
          }
        }

        // Connected components via BFS
        const visited = new Set();
        const componentSizes = [];
        for (const node of conceptNames) {
          if (visited.has(node)) continue;
          const queue = [node];
          let size = 0;
          while (queue.length > 0) {
            const curr = queue.shift();
            if (visited.has(curr)) continue;
            visited.add(curr);
            size++;
            for (const neighbor of adj.get(curr) || []) {
              if (!visited.has(neighbor)) queue.push(neighbor);
            }
          }
          componentSizes.push(size);
        }
        componentSizes.sort((a, b) => b - a);

        // Degree stats
        let totalDegree = 0;
        let maxDegree = 0;
        let maxDegreeNode = "";
        let orphanNodes = 0;
        for (const [name, neighbors] of adj) {
          const deg = neighbors.size;
          totalDegree += deg;
          if (deg > maxDegree) { maxDegree = deg; maxDegreeNode = name; }
          if (deg === 0) orphanNodes++;
        }
        const avgDegree = n > 0 ? (totalDegree / n).toFixed(2) : 0;

        // PageRank top 5
        const prMap = getPageRankMap();
        const prSorted = [...prMap.entries()].sort((a, b) => b[1] - a[1]);

        lines.push("\n## Graph Analytics");
        lines.push(`- Nodes: ${n} | Edges: ${Math.floor(totalDegree / 2)}`);
        lines.push(`- Connected components: **${componentSizes.length}** (largest: ${componentSizes[0] || 0}, smallest: ${componentSizes[componentSizes.length - 1] || 0})`);
        lines.push(`- Orphan nodes (degree 0): **${orphanNodes}**`);
        lines.push(`- Avg degree: ${avgDegree} | Max degree: ${maxDegree} (${maxDegreeNode})`);
        if (prSorted.length > 0) {
          lines.push("- Top 5 PageRank:");
          for (const [concept, pr] of prSorted.slice(0, 5)) {
            lines.push(`  - **${concept}**: ${pr.toFixed(4)} (degree: ${adj.get(concept)?.size || 0})`);
          }
        }
        if (componentSizes.length > 10) {
          lines.push(`- ⚠️ ${componentSizes.length} disconnected components — consider adding bridge learnings`);
          issues.push(`Knowledge graph has ${componentSizes.length} disconnected components`);
        }
      }
    } catch { /* non-blocking */ }

    lines.push("");
    if (issues.length === 0) {
      lines.push("## Status: ✅ Healthy");
    } else {
      lines.push("## Status: ⚠️ Issues found");
      for (const issue of issues) lines.push(`- ${issue}`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }]
    };
  }
