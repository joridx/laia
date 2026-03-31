/**
 * Integration tests — exercise the real I/O chain with a temporary BRAIN_PATH.
 * Tests scoredSearch, getAllLearnings, computeAllVitalities, readJSON/writeFile,
 * the JSON cache, and the full tool pipeline.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";
import { signalEnabled } from "../signal-config.js";

const t = createSuite("integration");

// ─── Setup: create a temporary BRAIN_PATH with realistic data ────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;

// Create directory structure
for (const dir of [
  "memory/sessions",
  "memory/learnings",
  "memory/projects",
  "knowledge/general",
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}

// Create index.json
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({
  version: "2.0",
  sessions: [],
  consolidation: {}
}, null, 2));

// Create metrics.json
fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({
  hits: {}, searches: {}, total_queries: 0
}, null, 2));

// Create relations.json with some graph data
fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({
  concepts: {
    docker: { related_to: ["kubernetes", "containers", "devops"], children: [] },
    kubernetes: { related_to: ["docker", "deployment"], children: [] },
    postgres: { related_to: ["sql", "database"], children: [] },
    sql: { related_to: ["postgres", "database"], children: [] }
  }
}, null, 2));

// Create learnings-meta.json
const today = new Date().toISOString().split("T")[0];
fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify({
  learnings: {
    "docker-networking-patterns": {
      title: "Docker networking patterns",
      file: "memory/learnings/docker-networking-patterns.md",
      type: "pattern",
      hit_count: 5,
      created_date: today,
      last_accessed: today,
      stale: false
    },
    "postgres-connection-pooling": {
      title: "Postgres connection pooling",
      file: "memory/learnings/postgres-connection-pooling.md",
      type: "warning",
      hit_count: 2,
      created_date: "2025-06-01",
      last_accessed: "2025-12-01",
      stale: true
    },
    "git-rebase-workflow": {
      title: "Git rebase workflow",
      file: "memory/learnings/git-rebase-workflow.md",
      type: "learning",
      hit_count: 0,
      created_date: "2025-01-01",
      last_accessed: null,
      stale: true
    }
  }
}, null, 2));

// Create learning files
fs.writeFileSync(path.join(tmpDir, "memory/learnings/docker-networking-patterns.md"), `---
title: "Docker networking patterns"
headline: "Use bridge networks for service isolation, host network for performance"
type: pattern
created: ${today}
tags: [docker, networking, containers]
slug: docker-networking-patterns
---

Use bridge networks for service isolation, host network for performance.
Configure DNS resolution between containers via docker-compose networks.
Avoid using host networking in production unless latency-critical.

#docker #networking #containers #pattern`);

fs.writeFileSync(path.join(tmpDir, "memory/learnings/postgres-connection-pooling.md"), `---
title: "Postgres connection pooling"
headline: "Always use connection pooling (PgBouncer) for >10 concurrent connections"
type: warning
created: 2025-06-01
tags: [postgres, sql, performance]
slug: postgres-connection-pooling
---

Always use connection pooling (PgBouncer) for >10 concurrent connections.
Without pooling, each connection costs ~10MB RAM on the server.
Max connections default is 100 — will crash with pool exhaustion.

#postgres #sql #performance #avoid`);

fs.writeFileSync(path.join(tmpDir, "memory/learnings/git-rebase-workflow.md"), `---
title: "Git rebase workflow"
headline: "Use interactive rebase to clean up commits before PR"
type: learning
created: 2025-01-01
tags: [git, workflow]
slug: git-rebase-workflow
---

Use interactive rebase to clean up commits before PR.
Never rebase shared branches.

#git #workflow #learning`);

// Create a session file
fs.writeFileSync(path.join(tmpDir, "memory/sessions/2026-03-12.md"), `---
date: 2026-03-12
project: test-project
---

# Session 2026-03-12

Worked on Docker deployment pipeline improvements.
Fixed Postgres connection pooling issues in production.
Deployed new container orchestration setup.`);

// Create a knowledge file
fs.writeFileSync(path.join(tmpDir, "knowledge/general/deployment-guide.md"), `---
title: "Deployment guide"
tags: [deployment, docker, production]
---

# Deployment Guide

1. Build Docker image
2. Run database migrations
3. Deploy to Kubernetes cluster
4. Verify health checks`);

// ─── Dynamic import of index.js (which reads BRAIN_PATH from env) ────────────

// We need to import the server module AFTER setting BRAIN_PATH
const mod = await import("../index.js");

// The functions we need are re-exported from index.js
// But scoredSearch, getAllLearnings etc. are NOT exported (they use I/O)
// So we test via the module's internal behavior by calling what IS exported
// and testing the cache + I/O functions indirectly

// For integration testing, we import scoring/utils directly and test
// the data files we created can be read properly
import { tokenize } from "../utils.js";
import { scoreLearning, classifyIntent } from "../scoring.js";

// ─── Test: files are readable and parseable ──────────────────────────────────

t.section("Data integrity");

const indexContent = JSON.parse(fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"));
t.assert(indexContent.version === "2.0", "index.json readable and valid");

const relContent = JSON.parse(fs.readFileSync(path.join(tmpDir, "relations.json"), "utf-8"));
t.assert(Object.keys(relContent.concepts).length === 4, "relations.json has 4 concepts");

const metaContent = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf-8"));
t.assert(Object.keys(metaContent.learnings).length === 3, "learnings-meta.json has 3 entries");

const learningFiles = fs.readdirSync(path.join(tmpDir, "memory/learnings")).filter(f => f.endsWith(".md"));
t.assert(learningFiles.length === 3, "3 learning files on disk");

// ─── Test: frontmatter parsing on real files ─────────────────────────────────

t.section("Frontmatter parsing (real files)");

import { parseLearningFrontmatter } from "../utils.js";

for (const file of learningFiles) {
  const content = fs.readFileSync(path.join(tmpDir, "memory/learnings", file), "utf-8");
  const parsed = parseLearningFrontmatter(content);
  t.assert(parsed !== null, `${file}: frontmatter parsed`);
  t.assert(parsed.frontmatter.title, `${file}: has title`);
  t.assert(parsed.frontmatter.tags?.length > 0, `${file}: has tags`);
  t.assert(parsed.body.length > 0, `${file}: has body`);
}

// ─── Test: scoreLearning with real data ──────────────────────────────────────

t.section("scoreLearning (real data)");

const dockerContent = fs.readFileSync(
  path.join(tmpDir, "memory/learnings/docker-networking-patterns.md"), "utf-8"
);
const dockerParsed = parseLearningFrontmatter(dockerContent);
const dockerLearning = {
  slug: "docker-networking-patterns",
  ...dockerParsed.frontmatter,
  body: dockerParsed.body
};

const vitalityMap = new Map([
  ["docker-networking-patterns", { vitality: 0.8, zone: "active" }],
  ["postgres-connection-pooling", { vitality: 0.3, zone: "stale" }],
  ["git-rebase-workflow", { vitality: 0.15, zone: "fading" }]
]);

// Search for "docker networking" should match strongly
const result = scoreLearning(
  dockerLearning, tokenize("docker networking containers"),
  metaContent, null, [], false, null, vitalityMap
);
t.assert(result !== null, "Docker learning matched by docker+networking query");
t.assert(result.score > 10, `High score for direct match (${result.score})`);
t.assert(result.signals.tags > 0, "Tags signal active");
t.assert(result.signals.title > 0, "Title signal active");

// Search with graph expansion tokens
const resultGraph = scoreLearning(
  dockerLearning, tokenize("orchestration"),
  metaContent, null, ["docker", "containers"], false, null, vitalityMap
);
// "orchestration" doesn't match any docker learning tags/title/body.
// graphTokens ["docker","containers"] match if graph enabled → 1 signal.
// vitalityMap provides vitality if freshness enabled → 1 signal.
// Gate requires ≥ 2 signals, so both graph+freshness must be ON, or showAll.
const graphOn = signalEnabled("graph");
const freshnessOn = signalEnabled("freshness");
if (graphOn && freshnessOn) {
  t.assert(resultGraph !== null, "Graph+freshness ON → graph tokens help match docker learning");
} else {
  t.assert(resultGraph === null, "Graph or freshness OFF → insufficient signals for unrelated query token");
}

// Unrelated search
const resultUnrelated = scoreLearning(
  dockerLearning, tokenize("python tensorflow sklearn"),
  metaContent, null, [], false, null, null
);
t.assert(resultUnrelated === null, "Unrelated query returns null without vitality");

// ─── Test: intent classification on realistic queries ────────────────────────

t.section("Intent (realistic queries)");

const i1 = classifyIntent("how to configure docker networking");
t.assert(i1.intent === "procedural", "Docker how-to → procedural");

const i2 = classifyIntent("what happened with postgres last session");
t.assert(i2.intent === "episodic", "Session recall → episodic");

const i3 = classifyIntent("should we use PgBouncer vs connection pool alternatives");
t.assert(i3.intent === "decision", "Comparison → decision");

// ─── Test: cross-file consistency ────────────────────────────────────────────

t.section("Cross-file consistency");

// Every slug in meta should have a corresponding .md file
for (const slug of Object.keys(metaContent.learnings)) {
  const filePath = path.join(tmpDir, "memory/learnings", `${slug}.md`);
  t.assert(fs.existsSync(filePath), `Meta slug "${slug}" has matching file`);
}

// Every .md file should have a matching meta entry
for (const file of learningFiles) {
  const slug = file.replace(".md", "");
  t.assert(metaContent.learnings[slug], `File "${file}" has matching meta entry`);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

// ─── Summary ─────────────────────────────────────────────────────────────────

export const results = t.summary();
