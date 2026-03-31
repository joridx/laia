/**
 * Auto-maintenance for LAIA Brain.
 * Prune stale learnings, consolidate old sessions, archive fading learnings,
 * cluster detection (P7.2), cluster quality scoring (P12.2).
 */

import * as fs from "fs";
import * as path from "path";
import { BRAIN_PATH, LEARNINGS_DIR, NOTES_DIR } from "./config.js";
import { readFile, writeFile, readJSON } from "./file-io.js";
import { parseLearningFrontmatter, slugify, sanitizeTag, tokenize, normPath, noteSlugFromPath } from "./utils.js";
import { getAllLearnings, computeAllVitalities } from "./learnings.js";
import { classifyVitalityZone, COLD_TO_ARCHIVE_DAYS } from "./scoring.js";
import { metaRepo, metricsRepo } from "./database.js";
import { readMetaStable, readMetricsStable } from "./meta-io.js";

// ─── P14.1: Read helpers (delegated to meta-io.js) ───
function _readMeta() { return readMetaStable(); }
function _readMetrics() { return readMetricsStable(); }
// ─── Prune ────────────────────────────────────────────────────────────────────

export function performPrune(daysThreshold = 60, vitalityMap = null) {
  const meta = _readMeta();
  if (!meta || !meta.learnings || Object.keys(meta.learnings).length === 0) return null;

  const today = new Date().toISOString().split("T")[0];

  if (!vitalityMap) vitalityMap = computeAllVitalities();

  const activeEntries = [];
  const staleEntries = [];
  let alreadyStale = 0;

  for (const [slug, data] of Object.entries(meta.learnings)) {
    // Skip human notes: explicit maintenance flag or file path under notes/ (P3.2)
    if (data.maintenance === "manual" || (data.file && data.file.startsWith("memory/notes/"))) continue;

    if (data.stale) {
      alreadyStale++;
      continue;
    }

    const vData = vitalityMap.get(slug);
    const zone = vData?.zone || "active";

    if (zone === "stale" || zone === "cold" || zone === "fading" || zone === "archived") {
      // V2: Track cold_since for cold → archived transition
      if (zone === "cold" && !meta.learnings[slug].cold_since) {
        meta.learnings[slug].cold_since = today;
      }
      meta.learnings[slug].stale = true;
      meta.learnings[slug].stale_date = today;
      meta.learnings[slug].vitality = vData?.vitality ?? 0;
      meta.learnings[slug].vitality_zone = zone;
      staleEntries.push({ slug, zone, vitality: vData?.vitality, ...data });
    } else {
      activeEntries.push({ slug, zone, vitality: vData?.vitality, ...data });
    }
  }

  if (staleEntries.length > 0) {
    writeFile("learnings-meta.json", JSON.stringify(meta, null, 2));
  }

  const metrics = _readMetrics() || {};
  metrics.last_prune = today;
  writeFile("metrics.json", JSON.stringify(metrics, null, 2));

  return {
    active: activeEntries.length,
    newlyStale: staleEntries.length,
    alreadyStale,
    total: activeEntries.length + staleEntries.length + alreadyStale,
    activeEntries,
    staleEntries
  };
}

// ─── Consolidate sessions ─────────────────────────────────────────────────────

export function performConsolidate(daysThreshold = 30) {
  const sessionsDir = path.join(BRAIN_PATH, "memory", "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  const files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith(".md") && !f.includes("_consolidated"));

  const now = new Date();
  const threshold = new Date(now.getTime() - daysThreshold * 24 * 60 * 60 * 1000);
  const today = now.toISOString().split("T")[0];

  const monthlyGroups = {};
  for (const file of files) {
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const fileDate = new Date(dateMatch[1]);
    if (fileDate < threshold) {
      const month = dateMatch[1].slice(0, 7);
      if (!monthlyGroups[month]) monthlyGroups[month] = [];
      monthlyGroups[month].push(file);
    }
  }

  if (Object.keys(monthlyGroups).length === 0) return null;

  const backupDir = path.join(sessionsDir, `_backup_${today}_${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  let consolidated = 0;
  for (const [month, sessionFiles] of Object.entries(monthlyGroups)) {
    let consolidatedContent = `# Consolidated Sessions: ${month}\n\n`;
    consolidatedContent += `**Sessions consolidated:** ${sessionFiles.length}\n`;
    consolidatedContent += `**Consolidation date:** ${today}\n\n`;
    consolidatedContent += `---\n\n`;

    for (const file of sessionFiles.sort()) {
      const content = readFile(`memory/sessions/${file}`);
      if (!content) continue;

      const titleMatch = content.match(/# (?:Session|Sessió): (?:\d{4}-\d{2}-\d{2} - )?(.+)/);
      const tagsMatch = content.match(/\*\*Tags\*\*:? (.+)/);
      const summaryMatch = content.match(/## (?:Summary|Resum)[^\n]*\n([\s\S]*?)(?=\n##|$)/);

      consolidatedContent += `## ${file.replace(".md", "")}\n`;
      if (titleMatch) consolidatedContent += `**Project:** ${titleMatch[1].trim()}\n`;
      if (tagsMatch) consolidatedContent += `**Tags:** ${tagsMatch[1].trim()}\n`;
      if (summaryMatch) {
        const summary = summaryMatch[1].trim().slice(0, 500);
        consolidatedContent += `**Summary:** ${summary}${summaryMatch[1].length > 500 ? "..." : ""}\n`;
      }
      consolidatedContent += "\n---\n\n";

      fs.renameSync(path.join(sessionsDir, file), path.join(backupDir, file));
      consolidated++;
    }

    writeFile(`memory/sessions/${month}_consolidated.md`, consolidatedContent);
  }

  const index = readJSON("index.json");
  if (index) {
    index.consolidation = index.consolidation || {};
    index.consolidation.last_run = today;
    index.consolidation.sessions_consolidated = (index.consolidation.sessions_consolidated || 0) + consolidated;
    index.consolidation.stats = index.consolidation.stats || {};
    index.consolidation.stats.total_files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".md")).length;
    writeFile("index.json", JSON.stringify(index, null, 2));
  }

  const metrics = _readMetrics() || {};
  metrics.last_consolidation = today;
  writeFile("metrics.json", JSON.stringify(metrics, null, 2));

  // Cleanup old backups (>90 days)
  cleanupOldBackups(sessionsDir, 90);

  return { consolidated, months: Object.keys(monthlyGroups).sort() };
}

// ─── Cleanup old backup directories ──────────────────────────────────────────

export function cleanupOldBackups(dir, maxAgeDays = 90) {
  if (!fs.existsSync(dir)) return 0;
  const now = Date.now();
  const threshold = maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith("_backup_")) continue;
    const match = entry.match(/_backup_(\d{4}-\d{2}-\d{2})_/);
    if (!match) continue;
    const backupDate = new Date(match[1]).getTime();
    if (now - backupDate > threshold) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      cleaned++;
    }
  }
  return cleaned;
}

// ─── Archive stale learnings ──────────────────────────────────────────────────

export function performArchiveLearnings(vitalityMap = null) {
  const meta = _readMeta();
  if (!meta?.learnings) return null;

  if (!vitalityMap) vitalityMap = computeAllVitalities();
  const staleSlugs = Object.entries(meta.learnings)
    .filter(([slug, d]) => {
      if (d.archived) return false;
      if (d.maintenance === "manual" || (d.file && d.file.startsWith("memory/notes/"))) return false; // P3.2
      if (!d.stale) return false;
      // V2: Principles are exempt from auto-archive (stay cold)
      if (d.type === "principle") return false;
      const vData = vitalityMap.get(slug);
      const zone = vData?.zone || d.vitality_zone;
      // V2: cold → archived after COLD_TO_ARCHIVE_DAYS idle
      if (zone === "cold") {
        if (!d.cold_since) return false;
        const coldDays = (Date.now() - new Date(d.cold_since).getTime()) / (1000 * 60 * 60 * 24);
        return coldDays >= COLD_TO_ARCHIVE_DAYS;
      }
      return zone === "fading" || zone === "archived";
    })
    .map(([slug, data]) => ({ slug, ...data }));

  if (staleSlugs.length === 0) return null;

  const learningsDir = path.join(BRAIN_PATH, LEARNINGS_DIR);
  const archiveDir = path.join(learningsDir, "_archive");
  const today = new Date().toISOString().split("T")[0];
  const backupDir = path.join(archiveDir, `_backup_${today}_${Date.now()}`);

  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const monthlyGroups = {};
  for (const entry of staleSlugs) {
    const month = (entry.created_date || today).slice(0, 7);
    if (!monthlyGroups[month]) monthlyGroups[month] = [];
    monthlyGroups[month].push(entry);
  }

  let archived = 0;
  for (const [month, entries] of Object.entries(monthlyGroups)) {
    let archiveContent = `# Archived Learnings: ${month}\n\n`;
    archiveContent += `**Archived on:** ${today}\n`;
    archiveContent += `**Learnings:** ${entries.length}\n\n---\n\n`;

    for (const entry of entries) {
      const srcPath = path.join(learningsDir, `${entry.slug}.md`);
      if (!fs.existsSync(srcPath)) continue;

      const content = readFile(`${LEARNINGS_DIR}/${entry.slug}.md`);
      const parsed = parseLearningFrontmatter(content);
      const fm = parsed?.frontmatter || {};

      archiveContent += `### ${fm.title || entry.slug}\n`;
      if (fm.headline) archiveContent += `> ${fm.headline}\n`;
      archiveContent += `- **Type:** ${fm.type || "learning"}\n`;
      archiveContent += `- **Tags:** ${(fm.tags || []).join(", ")}\n`;
      archiveContent += `- **Created:** ${fm.created || entry.created_date || "unknown"}\n`;
      archiveContent += `- **Hit count:** ${entry.hit_count || 0}\n\n`;

      fs.renameSync(srcPath, path.join(backupDir, `${entry.slug}.md`));

      meta.learnings[entry.slug].archived = true;
      meta.learnings[entry.slug].archived_date = today;
      archived++;
    }

    const archiveRelPath = `${LEARNINGS_DIR}/_archive/${month}_archived.md`;
    const existing = readFile(archiveRelPath);
    if (existing) {
      writeFile(archiveRelPath, existing + "\n---\n\n" + archiveContent);
    } else {
      writeFile(archiveRelPath, archiveContent);
    }
  }

  if (archived > 0) {
    // Clean broken subsumes: remove references to archived slugs from master entries
    const archivedSlugSet = new Set(staleSlugs.map(s => s.slug));
    for (const [, data] of Object.entries(meta.learnings)) {
      if (data.subsumes) {
        data.subsumes = data.subsumes.filter(s => !archivedSlugSet.has(s));
        if (data.subsumes.length === 0) delete data.subsumes;
      }
    }

    writeFile("learnings-meta.json", JSON.stringify(meta, null, 2));

    const metrics = _readMetrics() || {};
    metrics.last_archive_learnings = today;
    metrics.total_archived_learnings = (metrics.total_archived_learnings || 0) + archived;
    writeFile("metrics.json", JSON.stringify(metrics, null, 2));
  }

  // Cleanup old backups (>90 days)
  cleanupOldBackups(archiveDir, 90);

  return { archived, months: Object.keys(monthlyGroups).sort() };
}

// ─── Clean broken subsumes references ─────────────────────────────────────────

/**
 * Remove subsumes references that point to non-existent learnings.
 * Called during maintenance or manually after merges.
 * Returns count of cleaned references.
 */
export function cleanBrokenSubsumes() {
  const meta = _readMeta();
  if (!meta?.learnings) return 0;

  let cleaned = 0;
  for (const [, data] of Object.entries(meta.learnings)) {
    if (!data.subsumes) continue;
    const before = data.subsumes.length;
    data.subsumes = data.subsumes.filter(s => s in meta.learnings);
    if (data.subsumes.length === 0) delete data.subsumes;
    cleaned += before - (data.subsumes?.length || 0);
  }

  if (cleaned > 0) {
    writeFile("learnings-meta.json", JSON.stringify(meta, null, 2));
  }
  return cleaned;
}

// ─── Cluster detection (P7.2) ─────────────────────────────────────────────────

/**
 * Jaccard similarity between two Sets.
 */
function jaccardSets(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Detect clusters of similar learnings for deduplication and distillation.
 *
 * Phase 1: Tag-based grouping (>= 2 shared tags)
 * Phase 2: Content-based similarity (Jaccard on title + headline + body tokens)
 * Phase 3: Connected components via union-find → clusters with suggested actions
 *
 * Returns: { clusters: [...], stats: { ... } }
 */
export function detectClusters({ minSimilarity = 0.35, clusterThreshold: clusterThresholdOpt, maxResults = 30 } = {}) {
  const allLearnings = getAllLearnings();
  if (allLearnings.length < 2) {
    return { clusters: [], stats: { total_learnings: allLearnings.length, in_clusters: 0, clusters_found: 0 } };
  }

  // Filter out archived learnings
  const meta = _readMeta();
  const archivedSlugs = new Set(
    Object.entries(meta?.learnings || {})
      .filter(([, d]) => d.archived)
      .map(([slug]) => slug)
  );
  const learnings = allLearnings.filter(l => !archivedSlugs.has(l.slug));
  if (learnings.length < 2) {
    return { clusters: [], stats: { total_learnings: learnings.length, in_clusters: 0, clusters_found: 0 } };
  }

  // Precompute token sets per learning
  const items = learnings.map(l => {
    const tags = new Set((l.tags || []).map(sanitizeTag));
    const titleTokens = new Set(tokenize(l.title || ""));
    // Body tokens: headline + body, capped at 150 unique tokens for efficiency
    const bodyText = [l.headline, l.body].filter(Boolean).join(" ");
    const bodyTokens = new Set(tokenize(bodyText).slice(0, 150));
    return { slug: l.slug, title: l.title || l.slug, type: l.type, tags, titleTokens, bodyTokens };
  });

  // Compute pairwise similarities and find edges
  const edges = []; // { i, j, titleSim, bodySim, tagOverlap, combined }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];

      // Tag overlap count
      let tagOverlap = 0;
      for (const t of a.tags) {
        if (b.tags.has(t)) tagOverlap++;
      }

      // Title Jaccard
      const titleSim = jaccardSets(a.titleTokens, b.titleTokens);

      // Body Jaccard (content-based — catches clusters with inconsistent tags)
      const bodySim = jaccardSets(a.bodyTokens, b.bodyTokens);

      // Combined score: three independent signals
      // - Title Jaccard: strong for duplicates (same topic, same words)
      // - Body Jaccard: catches content overlap (emergent clusters without tags)
      // - Tag overlap: topical relatedness (2+ shared tags = strong signal)
      const tagScore = tagOverlap >= 3 ? 0.35 : tagOverlap >= 2 ? 0.25 : tagOverlap * 0.05;
      const combined = Math.max(
        titleSim * 0.35 + bodySim * 0.45 + Math.min(tagScore, 0.20),  // content-weighted
        tagScore + titleSim * 0.10 + bodySim * 0.10                    // tag-weighted (for different vocabulary, same topic)
      );

      if (combined >= minSimilarity) {
        edges.push({
          i, j,
          titleSim: +titleSim.toFixed(3),
          bodySim: +bodySim.toFixed(3),
          tagOverlap,
          combined: +combined.toFixed(3)
        });
      }
    }
  }

  if (edges.length === 0) {
    return { clusters: [], stats: { total_learnings: learnings.length, in_clusters: 0, clusters_found: 0 } };
  }

  // Union-Find to build connected components
  const parent = items.map((_, idx) => idx);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function unite(a, b) { parent[find(a)] = find(b); }

  // Union-find threshold: higher than edge threshold to avoid mega-clusters.
  // Edges capture "possibly related", union-find connects "confidently related".
  const clusterThreshold = clusterThresholdOpt ?? Math.max(minSimilarity + 0.05, 0.40);
  for (const edge of edges) {
    if (edge.combined >= clusterThreshold) {
      unite(edge.i, edge.j);
    }
  }

  // Group by connected component
  const components = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(i);
  }

  // Build cluster output (only components with >= 2 members)
  const clusters = [];
  for (const [, indices] of components) {
    if (indices.length < 2) continue;

    const indexSet = new Set(indices);
    const clusterEdges = edges.filter(e => indexSet.has(e.i) && indexSet.has(e.j));
    const similarities = clusterEdges.map(e => e.combined);
    const avgSim = similarities.length > 0
      ? +(similarities.reduce((s, v) => s + v, 0) / similarities.length).toFixed(3)
      : 0;
    const maxSim = similarities.length > 0 ? +Math.max(...similarities).toFixed(3) : 0;

    const slugs = indices.map(i => items[i].slug);
    const titles = indices.map(i => items[i].title);
    const tagsUnion = [...new Set(indices.flatMap(i => [...items[i].tags]))].sort();

    // Suggest action based on cluster characteristics
    let action;
    if (maxSim >= 0.65) {
      action = "merge";       // Near-duplicates → merge into one
    } else if (indices.length >= 5) {
      action = "distill";     // Large cluster → distill into principle
    } else {
      action = "review";      // Moderate similarity → human review
    }

    clusters.push({
      slugs, titles, tags_union: tagsUnion,
      size: indices.length,
      avg_similarity: avgSim,
      max_similarity: maxSim,
      suggested_action: action,
      top_pairs: clusterEdges
        .sort((a, b) => b.combined - a.combined)
        .slice(0, 5)
        .map(e => ({
          slugA: items[e.i].slug, slugB: items[e.j].slug,
          combined: e.combined, titleSim: e.titleSim, bodySim: e.bodySim, tagOverlap: e.tagOverlap
        }))
    });
  }

  // Sort: merge candidates first, then by max_similarity descending
  const actionOrder = { merge: 0, distill: 1, review: 2 };

  // P12.2: Compute quality score for each cluster (reuse meta from line 325)
  for (const cluster of clusters) {
    cluster.quality_score = clusterQualityScore(cluster.slugs, meta);
  }

  clusters.sort((a, b) =>
    (actionOrder[a.suggested_action] - actionOrder[b.suggested_action]) ||
    (b.quality_score - a.quality_score) ||
    (b.max_similarity - a.max_similarity)
  );

  const allClusters = clusters;
  const limitedClusters = allClusters.slice(0, maxResults);

  return {
    clusters: limitedClusters,
    stats: {
      total_learnings: learnings.length,
      in_clusters: new Set(allClusters.flatMap(c => c.slugs)).size,
      clusters_found: allClusters.length,
      merge_candidates: allClusters.filter(c => c.suggested_action === "merge").length,
      distill_candidates: allClusters.filter(c => c.suggested_action === "distill").length,
      review_candidates: allClusters.filter(c => c.suggested_action === "review").length,
      avg_quality: allClusters.length > 0
        ? +(allClusters.reduce((s, c) => s + c.quality_score, 0) / allClusters.length).toFixed(3)
        : 0,
      shown: limitedClusters.length
    }
  };
}

// ─── P12.2: Cluster quality scoring ──────────────────────────────────────────

/**
 * Compute quality score for a cluster based on member learnings' metadata.
 * Score 0..1 (normalized). Higher = more valuable to distill.
 *
 * Signals (per note, normalized 0..1):
 *   - Source:     0.2 (notes/) or 0.4 (learnings/) — softer split per Codex review
 *   - Usage:      min((hit_count + search_appearances) / 25, 1) × 0.3
 *   - Type bonus: warning=0.15, pattern=0.10, learning=0.05, principle=0.02
 *
 * Cluster score = 0.7 × avg_member + 0.3 × max_member
 *   (hybrid: prevents 1 gem in noise from being dropped)
 */
export function clusterQualityScore(slugs, meta) {
  if (!slugs || slugs.length === 0) return 0;
  if (!meta || !meta.learnings) return 0;

  const TYPE_BONUS = { principle: 0.02, warning: 0.15, pattern: 0.10, learning: 0.05 };
  const scores = [];

  for (const slug of slugs) {
    const data = meta?.learnings?.[slug] || {};
    let s = 0;

    // Signal 1: Source (operational vs imported)
    const isNote = data.file?.includes("notes/");
    s += isNote ? 0.2 : 0.4;

    // Signal 2: Usage (hit_count + search_appearances, combined)
    const usage = (data.hit_count || 0) + (data.search_appearances || 0);
    s += Math.min(usage / 25, 1) * 0.3;

    // Signal 3: Type bonus
    s += TYPE_BONUS[data.type] || 0.05;

    scores.push(Math.min(s, 1)); // Clamp to 1.0
  }

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const max = Math.max(...scores);

  // Hybrid: avg-weighted with max guard (Codex fix #3)
  return +(0.7 * avg + 0.3 * max).toFixed(3);
}

// Minimum quality threshold for distillation candidates
export const MIN_CLUSTER_QUALITY = 0.25;

// ─── Obsidian sync: detect orphan learnings (P3.2) ──────────────────────────

/**
 * Scan memory/learnings/ for .md files not in learnings-meta.json.
 * These are likely created externally (e.g. Obsidian).
 * Parses frontmatter, fills defaults, and adds to meta.
 * Returns count of newly indexed learnings.
 */
export function syncOrphanLearnings() {
  const meta = _readMeta();
  if (!meta || !meta.learnings) return 0;

  const today = new Date().toISOString().split("T")[0];
  let indexed = 0;
  const newSlugs = []; // Track newly indexed slugs for SQLite dual-write

  // Helper to index a single file (or refresh existing human note if title was slug-derived)
  function indexFile(relPath, slug, isHuman, implicitTags) {
    const existing = meta.learnings[slug];
    if (existing && !(isHuman && existing.title === slug.replace(/-/g, " "))) return; // already indexed (refresh slug-derived titles)

    const content = readFile(relPath);
    if (!content) return;

    const parsed = parseLearningFrontmatter(content);
    const fm = parsed?.frontmatter || {};

    const title = fm.title || slug.replace(/-/g, " ");
    const type = fm.type || "learning";
    // Handle tags as string or array (hand-edited Obsidian notes may use comma-separated string)
    const rawTags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(",").map(t => t.trim()) : [];
    const fmTags = rawTags.map(sanitizeTag).filter(Boolean);
    const tags = [...new Set([...fmTags, ...implicitTags])];
    const created = fm.created || today;

    const entry = {
      title: title.length > 120 ? title.slice(0, 117) + "..." : title,
      file: relPath,
      type,
      tags,
      hit_count: existing?.hit_count || 0,
      created_date: typeof created === "string" ? created : (existing?.created_date || today),
      last_accessed: existing?.last_accessed || null,
      stale: false
    };

    // Human notes get protected metadata
    if (isHuman) {
      entry.source = fm.source || "human";
      entry.maintenance = fm.maintenance || "manual";
    }

    meta.learnings[slug] = entry;
    newSlugs.push(slug);
    indexed++;
  }

  // 1. Scan memory/learnings/ (flat — AI notes)
  const learningsDir = path.join(BRAIN_PATH, LEARNINGS_DIR);
  if (fs.existsSync(learningsDir)) {
    for (const f of fs.readdirSync(learningsDir)) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue;
      const slug = f.replace(".md", "");
      indexFile(`${LEARNINGS_DIR}/${f}`, slug, false, []);
    }
  }

  // 2. Scan memory/notes/ (recursive — human notes)
  const notesDir = path.join(BRAIN_PATH, NOTES_DIR);
  if (fs.existsSync(notesDir)) {
    const notesDirNorm = normPath(notesDir);
    (function walk(d, depth, folderTags) {
      if (depth > 5) return;
      for (const entry of fs.readdirSync(d)) {
        if (entry.startsWith("_") || entry.startsWith(".")) continue;
        const fp = path.join(d, entry);
        let stat;
        try { stat = fs.lstatSync(fp); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          // Subfolder name becomes an implicit tag
          const folderTag = sanitizeTag(entry);
          walk(fp, depth + 1, folderTag ? [...folderTags, folderTag] : folderTags);
          continue;
        }
        if (!entry.endsWith(".md")) continue;
        // Include subfolder in slug to avoid collision with learnings/
        const slug = noteSlugFromPath(normPath(fp), notesDirNorm);
        const relPath = normPath(fp).replace(normPath(BRAIN_PATH) + "/", "");
        indexFile(relPath, slug, true, folderTags);
      }
    })(notesDir, 0, []);
  }

  if (indexed > 0) {
    writeFile("learnings-meta.json", JSON.stringify(meta, null, 2));
    // P14.1 dual-write: sync only newly indexed entries to SQLite
    for (const slug of newSlugs) {
      metaRepo.upsertMeta(slug, meta.learnings[slug]);
    }
  }

  return indexed;
}

// ─── Legacy migration (SUNSET: remove after 2026-06-01) ──────────────────────

export function migrateLearningsToStructured() {
  const dir = path.join(BRAIN_PATH, LEARNINGS_DIR);

  const hasLegacy = ["what_fails.md", "what_works.md", "patterns.md"].some(f =>
    fs.existsSync(path.join(dir, f))
  );
  if (!hasLegacy) return 0;

  const legacyFiles = {
    "what_fails.md": "warning",
    "what_works.md": "pattern",
    "patterns.md": "learning"
  };

  const today = new Date().toISOString().split("T")[0];
  let migrated = 0;

  for (const [filename, defaultType] of Object.entries(legacyFiles)) {
    const content = readFile(`${LEARNINGS_DIR}/${filename}`);
    if (!content) continue;

    const parts = content.split(/\n(?=### )/);

    for (const part of parts) {
      const headingMatch = part.match(/^### (.+)/);
      if (!headingMatch) continue;

      const heading = headingMatch[1];
      const tags = [...heading.matchAll(/#([\w-]+)/g)].map(m => m[1]);
      const title = heading.replace(/#[\w-]+/g, "").trim();
      const slug = slugify(title);
      if (!slug) continue;

      let type = defaultType;
      if (tags.includes("avoid")) type = "warning";
      else if (tags.includes("pattern")) type = "pattern";

      const bodyLines = part.split("\n").slice(1);
      const body = bodyLines.join("\n").trim();

      let headline = title;
      const errorLine = bodyLines.find(l => /\*\*(Error|Problema)\*\*/.test(l));
      const stratLine = bodyLines.find(l => /\*\*(Estratègia|Strategy|Observació)\*\*/.test(l));
      if (errorLine) {
        headline = errorLine.replace(/^[-*]\s*\*\*\w+\*\*:\s*/, "").trim();
      } else if (stratLine) {
        headline = stratLine.replace(/^[-*]\s*\*\*\w+\*\*:\s*/, "").trim();
      } else {
        const firstLine = bodyLines.find(l => l.trim() && !l.startsWith("- **Added") && !l.startsWith("#"));
        if (firstLine) {
          headline = firstLine.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim().slice(0, 150);
        }
      }

      const contentTags = tags.filter(t => t !== "avoid" && t !== "pattern" && t !== "learning").map(sanitizeTag);

      let fileContent = `---\n`;
      fileContent += `title: "${title.replace(/"/g, '\\"')}"\n`;
      fileContent += `headline: "${headline.replace(/"/g, '\\"')}"\n`;
      fileContent += `type: ${type}\n`;
      fileContent += `created: ${today}\n`;
      fileContent += `tags: [${contentTags.join(", ")}]\n`;
      fileContent += `slug: ${slug}\n`;
      fileContent += `---\n\n`;
      fileContent += body + "\n";
      fileContent += `\n${contentTags.map(t => `#${t}`).join(" ")}\n`;

      writeFile(`${LEARNINGS_DIR}/${slug}.md`, fileContent);
      migrated++;
    }

    const legacyDir = path.join(BRAIN_PATH, LEARNINGS_DIR, "_legacy");
    if (!fs.existsSync(legacyDir)) fs.mkdirSync(legacyDir, { recursive: true });
    const srcPath = path.join(BRAIN_PATH, LEARNINGS_DIR, filename);
    if (fs.existsSync(srcPath)) {
      fs.renameSync(srcPath, path.join(legacyDir, filename));
    }
  }

  if (migrated > 0) {
    const meta = _readMeta();
    if (meta?.learnings) {
      for (const [slug, data] of Object.entries(meta.learnings)) {
        data.file = `${LEARNINGS_DIR}/${slug}.md`;
      }
      writeFile("learnings-meta.json", JSON.stringify(meta, null, 2));
    }
  }

  return migrated;
}
