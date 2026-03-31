/**
 * P12.1: Write-time consolidation tests
 * Tests classifyMergeAction, mergeLearningAppend, rebuildLearningFile
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("merge (P12.1)");

// ─── Setup: temporary BRAIN_PATH ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-merge-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

// Create directory structure
for (const dir of [
  "memory/sessions",
  "memory/learnings",
  "memory/projects",
  "knowledge/general",
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}

// Seed JSON files
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({
  version: "2.0", sessions: [], consolidation: {}
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({
  tag_hits: {}, search_hits: {}, total_queries: 0
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({
  concepts: {}
}, null, 2));

fs.writeFileSync(path.join(tmpDir, "memory/todos.json"), "[]");

// ─── Seed a test learning ──────────────────────────────────────────────────────

const EXISTING_SLUG = "jenkins-token-renewal";
const EXISTING_FILE = `memory/learnings/${EXISTING_SLUG}.md`;
const EXISTING_CONTENT = `---
title: "Jenkins token renewal process"
headline: "How to renew Jenkins API token when it expires"
type: warning
created: 2026-03-01
tags: [jenkins, auth, token]
slug: jenkins-token-renewal
---

Jenkins tokens expire every 90 days. Go to Jenkins > User > Configure > API Token > Generate.
Store in encrypted store with: node scripts/set-secret.js JENKINS_TOKEN <value>

#jenkins #auth #token #avoid
`;

fs.writeFileSync(path.join(tmpDir, EXISTING_FILE), EXISTING_CONTENT);

fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {
    [EXISTING_SLUG]: {
      title: "Jenkins token renewal process",
      file: EXISTING_FILE,
      type: "warning",
      tags: ["jenkins", "auth", "token"],
      hit_count: 5,
      created_date: "2026-03-01",
      last_accessed: "2026-03-15",
      stale: false
    }
  }
}, null, 2));

// ─── Import modules (after BRAIN_PATH is set) ─────────────────────────────────

const { classifyMergeAction, mergeLearningAppend } = await import("../learnings.js");
const { readFile, readJSON } = await import("../file-io.js");
const { parseLearningFrontmatter } = await import("../utils.js");

// ═══════════════════════════════════════════════════════════════════════════════
// classifyMergeAction
// ═══════════════════════════════════════════════════════════════════════════════

t.section("classifyMergeAction — basic cases");

t.assert(
  classifyMergeAction(null) === "warn_only",
  "null input returns warn_only"
);

t.assert(
  classifyMergeAction({ level: "block", similarity: 0.75 }) === "warn_only",
  "block-level never returns merge_safe"
);

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.40, tagOverlap: 0.30, embSim: null, source: "jaccard", slug: EXISTING_SLUG }) === "warn_only",
  "low similarity returns warn_only"
);

// ─── Criteria 1: LLM-verified ──────────────────────────────────────────────────

t.section("classifyMergeAction — Criteria 1: LLM-verified");

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.55, tagOverlap: 0.30, embSim: null, source: "llm", slug: EXISTING_SLUG }) === "merge_safe",
  "LLM source + sim >= 0.55 → merge_safe"
);

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.54, tagOverlap: 0.30, embSim: null, source: "llm", slug: EXISTING_SLUG }) === "warn_only",
  "LLM source + sim 0.54 (< 0.55) → warn_only"
);

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.60, tagOverlap: 0.30, embSim: null, source: "jaccard", slug: EXISTING_SLUG }) === "warn_only",
  "non-LLM source at 0.60 without tags → warn_only (criteria 1 requires source=llm)"
);

// ─── Criteria 2: Embedding + Jaccard ────────────────────────────────────────────

t.section("classifyMergeAction — Criteria 2: Embedding + Jaccard");

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.45, tagOverlap: 0.20, embSim: 0.82, source: "embedding", slug: EXISTING_SLUG }) === "merge_safe",
  "embSim >= 0.82 + Jaccard >= 0.45 → merge_safe"
);

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.44, tagOverlap: 0.20, embSim: 0.85, source: "embedding", slug: EXISTING_SLUG }) === "warn_only",
  "embSim 0.85 but Jaccard 0.44 (< 0.45) → warn_only"
);

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.50, tagOverlap: 0.20, embSim: 0.81, source: "embedding", slug: EXISTING_SLUG }) === "warn_only",
  "Jaccard 0.50 but embSim 0.81 (< 0.82) → warn_only"
);

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.50, tagOverlap: 0.20, embSim: null, source: "jaccard", slug: EXISTING_SLUG }) === "warn_only",
  "null embSim → criteria 2 never fires"
);

// ─── Criteria 3: Jaccard + tagOverlap ───────────────────────────────────────────

t.section("classifyMergeAction — Criteria 3: Jaccard + tagOverlap");

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.58, tagOverlap: 0.50, embSim: null, source: "jaccard", slug: EXISTING_SLUG }) === "merge_safe",
  "Jaccard >= 0.58 + tagOverlap >= 0.50 → merge_safe"
);

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.57, tagOverlap: 0.60, embSim: null, source: "jaccard", slug: EXISTING_SLUG }) === "warn_only",
  "Jaccard 0.57 (< 0.58) even with high tags → warn_only"
);

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.60, tagOverlap: 0.49, embSim: null, source: "jaccard", slug: EXISTING_SLUG }) === "warn_only",
  "Jaccard 0.60 but tagOverlap 0.49 (< 0.50) → warn_only"
);

// ─── MAX_MERGE_COUNT guard ──────────────────────────────────────────────────────

t.section("classifyMergeAction — MAX_MERGE_COUNT guard");

// Temporarily set merge_count to 5 on the existing learning
const metaBefore = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf8"));
metaBefore.learnings[EXISTING_SLUG].merge_count = 5;
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(metaBefore, null, 2));

// Force re-read by clearing any cache
const { invalidateJsonCache } = await import("../file-io.js");
invalidateJsonCache("learnings-meta.json");

t.assert(
  classifyMergeAction({ level: "warn", similarity: 0.65, tagOverlap: 0.70, embSim: 0.90, source: "llm", slug: EXISTING_SLUG }) === "warn_only",
  "merge_count=5 (MAX) → warn_only even with perfect scores"
);

// Reset merge_count
metaBefore.learnings[EXISTING_SLUG].merge_count = 0;
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(metaBefore, null, 2));
invalidateJsonCache("learnings-meta.json");

// ═══════════════════════════════════════════════════════════════════════════════
// mergeLearningAppend
// ═══════════════════════════════════════════════════════════════════════════════

t.section("mergeLearningAppend — successful merge");

const mergeResult = mergeLearningAppend(
  EXISTING_SLUG,
  {
    title: "Jenkins token auto-renewal via cron",
    description: "Set up a cron job to auto-renew Jenkins token before expiry using scripts/renew-jenkins.sh",
    type: "pattern",
    tags: ["jenkins", "cron", "automation"],
  },
  { similarity: 0.62, tagOverlap: 0.60, source: "jaccard", embSim: null }
);

t.assert(mergeResult.success === true, "merge returns success: true");
t.assert(mergeResult.slug === EXISTING_SLUG, "merge returns correct slug");
t.assert(mergeResult.mergeCount === 1, "merge count is 1 after first merge");
t.assert(mergeResult.mergeInfo.includes("Merged into"), "mergeInfo contains 'Merged into'");

// Verify file content
const mergedContent = readFile(EXISTING_FILE);
t.assert(mergedContent !== null, "merged file exists");

const parsed = parseLearningFrontmatter(mergedContent);
t.assert(parsed !== null, "merged file has valid frontmatter");

// Frontmatter checks
t.assert(parsed.frontmatter.merge_count === "1", "frontmatter merge_count is 1");
t.assert(parsed.frontmatter.last_merged !== undefined, "frontmatter has last_merged");
t.assert(parsed.frontmatter.type === "warning", "type preserved (warning > pattern)");

// Tags: union of [jenkins, auth, token] + [jenkins, cron, automation]
const tags = parsed.frontmatter.tags || [];
t.assert(tags.includes("jenkins"), "keeps existing tag: jenkins");
t.assert(tags.includes("auth"), "keeps existing tag: auth");
t.assert(tags.includes("token"), "keeps existing tag: token");
t.assert(tags.includes("cron"), "adds new tag: cron");
t.assert(tags.includes("automation"), "adds new tag: automation");
t.assert(tags.length === 5, `tag count is 5 (got ${tags.length})`);

// Body checks
t.assert(parsed.body.includes("## Merged Updates"), "body contains Merged Updates section");
t.assert(parsed.body.includes("Jenkins token auto-renewal via cron"), "body contains incoming title");
t.assert(parsed.body.includes("cron job to auto-renew"), "body contains incoming description");
t.assert(parsed.body.includes("0.62"), "body contains similarity score");
t.assert(parsed.body.includes("jaccard"), "body contains source");
t.assert(parsed.body.includes("Added tags:"), "body contains added tags");
t.assert(parsed.body.includes("cron"), "added tags include cron");

// Original content preserved
t.assert(parsed.body.includes("Jenkins tokens expire every 90 days"), "original content preserved");

// Meta checks
invalidateJsonCache("learnings-meta.json");
const metaAfter = readJSON("learnings-meta.json");
t.assert(metaAfter.learnings[EXISTING_SLUG].hit_count === 6, "hit_count incremented (5→6)");
t.assert(metaAfter.learnings[EXISTING_SLUG].merge_count === 1, "meta merge_count is 1");
t.assert(metaAfter.learnings[EXISTING_SLUG].tags.length === 5, "meta tags updated to 5");

// ─── Second merge — appends under existing Merged Updates section ───────────

t.section("mergeLearningAppend — second merge appends correctly");

const mergeResult2 = mergeLearningAppend(
  EXISTING_SLUG,
  {
    title: "Jenkins token stored in Windows credential manager",
    description: "On Windows, Jenkins token can also be stored in Windows Credential Manager for GUI access.",
    type: "learning",
    tags: ["jenkins", "windows", "credentials"],
  },
  { similarity: 0.55, tagOverlap: 0.50, source: "llm", embSim: null }
);

t.assert(mergeResult2.success === true, "second merge succeeds");
t.assert(mergeResult2.mergeCount === 2, "merge count is now 2");

const content2 = readFile(EXISTING_FILE);
const parsed2 = parseLearningFrontmatter(content2);

t.assert(parsed2.frontmatter.merge_count === "2", "frontmatter merge_count is 2");
t.assert(parsed2.frontmatter.type === "warning", "type still warning (warning > learning)");

// Should have both merge entries under single ## Merged Updates
const mergedUpdatesCount = (content2.match(/## Merged Updates/g) || []).length;
t.assert(mergedUpdatesCount === 1, `only one '## Merged Updates' section (got ${mergedUpdatesCount})`);

// Both merge entries present
const h3Count = (content2.match(/### 2026-/g) || []).length;
t.assert(h3Count === 2, `two ### date entries (got ${h3Count})`);

// New tags added
const tags2 = parsed2.frontmatter.tags || [];
t.assert(tags2.includes("windows"), "adds windows tag from second merge");
t.assert(tags2.includes("credentials"), "adds credentials tag from second merge");
t.assert(tags2.length === 7, `tag count is 7 after second merge (got ${tags2.length})`);

// ─── Type precedence ────────────────────────────────────────────────────────

t.section("mergeLearningAppend — type precedence");

// Create a new learning-type note to test type upgrade
const LEARNING_SLUG = "docker-compose-basics";
const LEARNING_FILE = `memory/learnings/${LEARNING_SLUG}.md`;
fs.writeFileSync(path.join(tmpDir, LEARNING_FILE), `---
title: "Docker compose basics"
headline: "How to use docker compose"
type: learning
created: 2026-03-10
tags: [docker, compose]
slug: docker-compose-basics
---

Use docker compose up -d to start services.

#docker #compose #learning
`);

invalidateJsonCache("learnings-meta.json");
const metaForType = readJSON("learnings-meta.json");
metaForType.learnings[LEARNING_SLUG] = {
  title: "Docker compose basics",
  file: LEARNING_FILE,
  type: "learning",
  tags: ["docker", "compose"],
  hit_count: 2,
  created_date: "2026-03-10",
  last_accessed: null,
  stale: false
};
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(metaForType, null, 2));
invalidateJsonCache("learnings-meta.json");

const typeResult = mergeLearningAppend(
  LEARNING_SLUG,
  {
    title: "Docker compose warning about volumes",
    description: "Never use host-mounted volumes in production docker compose files.",
    type: "warning",
    tags: ["docker", "volumes"],
  },
  { similarity: 0.60, tagOverlap: 0.50, source: "jaccard", embSim: null }
);

t.assert(typeResult.success === true, "type upgrade merge succeeds");

const typeParsed = parseLearningFrontmatter(readFile(LEARNING_FILE));
t.assert(typeParsed.frontmatter.type === "warning", "type upgraded from learning to warning");

// ─── Error cases ────────────────────────────────────────────────────────────

t.section("mergeLearningAppend — error cases");

const errResult1 = mergeLearningAppend(
  "nonexistent-slug",
  { title: "test", description: "test", type: "learning", tags: [] },
  { similarity: 0.60, source: "jaccard" }
);
t.assert(errResult1.success === false, "nonexistent slug returns failure");
t.assert(errResult1.reason.includes("not found"), "reason mentions not found");

// Create a learning with invalid content (no frontmatter)
const BAD_SLUG = "bad-format-learning";
const BAD_FILE = `memory/learnings/${BAD_SLUG}.md`;
fs.writeFileSync(path.join(tmpDir, BAD_FILE), "Just plain text, no frontmatter");

invalidateJsonCache("learnings-meta.json");
const metaForBad = readJSON("learnings-meta.json");
metaForBad.learnings[BAD_SLUG] = {
  title: "Bad format learning",
  file: BAD_FILE,
  type: "learning",
  tags: [],
  hit_count: 0,
  created_date: "2026-03-10",
  last_accessed: null,
  stale: false
};
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(metaForBad, null, 2));
invalidateJsonCache("learnings-meta.json");

const errResult2 = mergeLearningAppend(
  BAD_SLUG,
  { title: "test", description: "test", type: "learning", tags: [] },
  { similarity: 0.60, source: "jaccard" }
);
t.assert(errResult2.success === false, "unparseable file returns failure");
t.assert(errResult2.reason.includes("parse"), "reason mentions parse failure");

// ─── rebuildLearningFile roundtrip ──────────────────────────────────────────

t.section("rebuildLearningFile — roundtrip integrity");

// Read the twice-merged Jenkins file and verify it round-trips through parse
const finalContent = readFile(EXISTING_FILE);
const finalParsed = parseLearningFrontmatter(finalContent);
t.assert(finalParsed !== null, "final merged file parses successfully");
t.assert(finalParsed.frontmatter.title === "Jenkins token renewal process", "title preserved through rebuilds");
t.assert(finalParsed.frontmatter.slug === "jenkins-token-renewal", "slug preserved through rebuilds");
t.assert(finalParsed.frontmatter.created === "2026-03-01", "created date preserved");
t.assert(finalParsed.body.includes("Jenkins tokens expire every 90 days"), "original body intact after 2 merges");
t.assert(finalParsed.body.includes("cron job to auto-renew"), "first merge content intact");
t.assert(finalParsed.body.includes("Windows Credential Manager"), "second merge content intact");

// ─── Cleanup ────────────────────────────────────────────────────────────────

// Cleanup temp dir
fs.rmSync(tmpDir, { recursive: true, force: true });

// ─── Summary ────────────────────────────────────────────────────────────────

const { passed, failed } = t.summary();
if (failed > 0) process.exit(1);
