/**
 * Retrieval evaluation harness — measures recall@k, precision@k, and MRR on real brain data.
 *
 * Each test case defines a query and a set of expected slugs that should appear
 * in the top-k results. Recall@k = found / expected, Precision@k = found / k,
 * MRR = mean reciprocal rank of first relevant result per query.
 *
 * Requires LAIA_BRAIN_PATH to point to real brain data.
 * Run: LAIA_BRAIN_PATH=$HOME/laia-data node tests/retrieval.test.js
 */

import * as fs from "fs";
import { createSuite } from "./harness.js";

const t = createSuite("retrieval");

// ─── Verify we have real data ──────────────────────────────────────────────────
const brainPath = process.env.LAIA_BRAIN_PATH;
if (!brainPath || !fs.existsSync(brainPath)) {
  console.error("LAIA_BRAIN_PATH not set or not found. This test needs real brain data.");
  console.error("Run: LAIA_BRAIN_PATH=<your-brain-data-path> node tests/retrieval.test.js");
  process.exit(1);
}

const { scoredSearch } = await import("../search.js");

// ─── Test cases: [query, expectedSlugs[], k, minRecall] ─────────────────────
// expectedSlugs: learnings that MUST appear in top-k results
// recall@k = found / expected (how many relevant items we retrieved)
// precision@k = found / k (what fraction of top-k is relevant)
// MRR = mean(1/rank of first expected slug found per query)

const testCases = [
  // === Domain-specific queries ===
  {
    name: "Jenkins connection and auth",
    query: "jenkins API token authentication",
    expectedSlugs: [
      "connexio-a-jenkins-allianz-epac-toolchain",
      "jenkins-usar-object-id-entra-id-com-a-usuari-api",
      "jenkins-token-auto-renewal-jenkinstokenpy-update-secrets",
    ],
    k: 10,
    minRecall: 0.66,
  },
  {
    name: "Dynatrace logs DQL",
    query: "dynatrace DQL logs query",
    expectedSlugs: [
      "dynatrace-dql-logs-via-playwright-setup-complet",
      "dynatrace-logs-require-storagelogsread-permission",
    ],
    k: 10,
    minRecall: 0.5,
  },
  {
    name: "Binary engine COBOL Parquet",
    query: "binary engine COBOL parquet conversion",
    expectedSlugs: [
      "binary-engine-estructura-de-paths-al-container",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "Teams MCP messaging",
    query: "teams send message MCP",
    expectedSlugs: [
      "teamssendmessage-usar-conversationid-no-chatid",
      "teams-mcp-eliminat-en-favor-del-skill-teams",
    ],
    k: 10,
    minRecall: 0.5,
  },
  {
    name: "Git merge conflicts brain data",
    query: "git merge conflict JSON brain-data",
    expectedSlugs: [
      "brain-data-json-merge-conflicts-resolution-patterns-and-pitf",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "SQLite corruption recovery",
    query: "SQLite corruption self-healing database",
    expectedSlugs: [
      "sqlite-two-layer-self-healing-for-corruption",
      "sqlite-corruption-error-messages-from-better-sqlite3",
    ],
    k: 10,
    minRecall: 0.5,
  },
  {
    name: "Confluence page update",
    query: "confluence update page content",
    expectedSlugs: [
      "confluence-update-via-curl-amb-payload-json-extern",
      "confluence-use-ensureasciitrue-encodingutf-8-for-payload-jso",
    ],
    k: 10,
    minRecall: 0.5,
  },
  {
    name: "Data Vault hashing",
    query: "data vault hash key computation",
    expectedSlugs: [
      "hashing-in-data-vault-20-resum-complet",
      "computing-hash-keys-pipeline-practic",
    ],
    k: 10,
    minRecall: 0.5,
  },
  {
    name: "Jira ticket creation",
    query: "jira create ticket REST API IBLRDM",
    expectedSlugs: [
      "jira-iblrdm-crear-tickets-via-quickcreateissuejspa-no-rest-a",
      "jira-iblrdmiblidm-no-es-poden-crear-tickets-via-rest-apinnel",
    ],
    k: 10,
    minRecall: 0.5,
  },
  {
    name: "Copilot API models",
    query: "copilot business API models GPT",
    expectedSlugs: [
      "copilot-business-api-access-to-32-models-via-oauth-token-exc",
      "copilot-api-endpoint-routing-codex-models-use-responses-othe",
    ],
    k: 10,
    minRecall: 0.5,
  },
  // === Warning/pattern queries ===
  {
    name: "Brain path configuration warning",
    query: "BRAIN_PATH MCP configuration env var",
    expectedSlugs: [
      "brainpath-mcp-no-es-recarrega-mid-session",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "Python Windows path issues",
    query: "python windows python3 command not found",
    expectedSlugs: [
      "entorns-de-treball-multi-pc",
    ],
    k: 20,
    minRecall: 0.0,  // optional — query is inherently ambiguous
  },
  // === Cross-domain queries ===
  {
    name: "Secrets management encryption",
    query: "secrets encryption AES openssl credentials",
    expectedSlugs: [
      "gestio-de-credencials-amb-fitxers-env",
    ],
    k: 15,
    minRecall: 1.0,
  },
  {
    name: "MCP tool consolidation diet",
    query: "MCP tool diet consolidation reduce",
    expectedSlugs: [
      "p56-mcp-tool-diet-consolidar-tools-redueix-token-tax-fixa-pe",
      "fusionar-tools-mcp-afegir-parametre-opcional-vs-tool-nou",
    ],
    k: 10,
    minRecall: 0.5,
  },
  // === Harder queries: short, ambiguous, cross-domain ===
  {
    name: "Short query: jenkins token",
    query: "jenkins token API",
    expectedSlugs: [
      "connexio-a-jenkins-allianz-epac-toolchain",
      "jenkins-usar-object-id-entra-id-com-a-usuari-api",
    ],
    k: 10,
    minRecall: 0.5,
  },
  {
    name: "Short query: sqlite",
    query: "sqlite",
    expectedSlugs: [
      "sqlite-two-layer-self-healing-for-corruption",
      "sqlite-corruption-error-messages-from-better-sqlite3",
    ],
    k: 10,
    minRecall: 0.5,
  },
  {
    name: "Ambiguous: token (multi-domain)",
    query: "token expired renew",
    expectedSlugs: [
      "jenkins-token-auto-renewal-jenkinstokenpy-update-secrets",
    ],
    k: 15,
    minRecall: 1.0,
  },
  {
    name: "Catalan query: merge conflicts",
    query: "resoldre merge conflicts brain",
    expectedSlugs: [
      "brain-data-json-merge-conflicts-resolution-patterns-and-pitf",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // === P14.2 Phase 2: expanded gold query set (35 new queries) ===
  // --- Docker ---
  {
    name: "Docker containers networking",
    query: "docker container networking volumes",
    expectedSlugs: [
      "docker-complete-reference-guide-containers-networking-storag",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "Docker UTC timezone issue",
    query: "docker container UTC time localdate",
    expectedSlugs: [
      "binary-engine-localdatenow-usa-utc-dins-del-contenidor-docke",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Outlook email ---
  {
    name: "Send email from Claude Code",
    query: "enviar email outlook claude code win32com",
    expectedSlugs: [
      "enviar-emails-via-outlook-com-des-de-claude-code",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "Outlook inbox bulk cleanup",
    query: "outlook inbox cleanup bulk delete triage",
    expectedSlugs: [
      "outlook-com-bulk-cleanup-3-pass-strategy-for-inbox-triage",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- ServiceNow ---
  {
    name: "ServiceNow catalog item problems",
    query: "servicenow catalog item AMC admin rights",
    expectedSlugs: [
      "catalog-item-amc-gen2-admin-rights-te-problemes-amb-seleccio",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "AZBoost login cookies",
    query: "azboost login cookies playwright navigation",
    expectedSlugs: [
      "azboost-login-captura-cookies-massa-aviat-cal-navegar-a-navp",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- GitHub Actions CI ---
  {
    name: "CI builds failed binary engine",
    query: "CI build failed binary engine main branch",
    expectedSlugs: [
      "3-binary-engine-ci-builds-failed-on-main-2026-03-20",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "Synapse CI/CD GitHub Actions",
    query: "synapse CI CD multi environment github actions",
    expectedSlugs: [
      "cicd-per-synapse-multi-entorn-amb-github-actions",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Brain search internals ---
  {
    name: "BM25 rescue mechanism",
    query: "BM25 rescue search pipeline gate",
    expectedSlugs: [
      "bm25-rescue-mechanism-per-search-pipelines-amb-gates",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "FTS5 query sanitization",
    query: "FTS5 match syntax sanitize query",
    expectedSlugs: [
      "fts5-match-syntax-sempre-sanititzar-queries-dusuari",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Embeddings ---
  {
    name: "ONNX embeddings local",
    query: "embeddings ONNX MiniLM local brain",
    expectedSlugs: [
      "memory-ts-embeddings-minilm-requereixen-80mb-onnx",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Ollama / LLM ---
  {
    name: "Ollama workers fallback",
    query: "ollama workers automatic fallback brain",
    expectedSlugs: [
      "claudia-workers-usen-ollama-automaticament-via-brain-tools",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "API agnostic providers",
    query: "api agnostic providers package claude copilot ollama",
    expectedSlugs: [
      "api-agnostic-providers-package-implemented-and-integrated-in",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Claudia CLI ---
  {
    name: "Claudia swarm parallelism",
    query: "claudia swarm parallel workers native",
    expectedSlugs: [
      "claudia-cli-swarm-natiu-per-parallelisme-no-mcpclaudiaagent",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "Claudia ANSI box drawing",
    query: "ANSI padding box drawing banner claudia",
    expectedSlugs: [
      "ansi-aware-padding-for-box-drawing-banners",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Security ---
  {
    name: "Path traversal file-io guard",
    query: "path traversal assertSafePath file-io security",
    expectedSlugs: [
      "assertsafepath-guard-per-file-io-amb-paths-relatius",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "Chrome cookies antivirus",
    query: "chrome cookies database antivirus python access",
    expectedSlugs: [
      "chrome-cookies-db-antivirus-salta-si-saccedeix-des-de-python",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Distillation ---
  {
    name: "Brain distill timeout",
    query: "brain distill generate timeout silent failure",
    expectedSlugs: [
      "braindistill-generate-fallava-silenciosament-per-timeout-cop",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- DB2 ---
  {
    name: "DB2 ccancelglobal validation",
    query: "ccancelglobal DB2 validated dev agent",
    expectedSlugs: [
      "ccancelglobal-validated-in-db2-dev-2026-03-16",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "DB2 ccancelglobal edge case",
    query: "ccancelglobal cap 100 edge case empty agents",
    expectedSlugs: [
      "ccancelglobal-cap-at-100-edge-case-for-agents-with-near-empt",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Synapse / Posicion Grafica ---
  {
    name: "Synapse ADP triggers database",
    query: "ADP triggers stop database off synapse",
    expectedSlugs: [
      "adp-triggers-can-stop-when-database-is-off",
    ],
    k: 10,
    minRecall: 1.0,
  },
  {
    name: "Agent traspassos Synapse table",
    query: "agentestraspasos synapse TDPCOREIM table",
    expectedSlugs: [
      "agentestraspasos-table-synapse-tdpcoreim",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Actuarial platform ---
  {
    name: "Actuarial platform pipeline internals",
    query: "actuarial platform pipeline internals aitana",
    expectedSlugs: [
      "aitana-fabuel-investiga-internals-actuarialplatform-pipeline",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- BI / Power BI ---
  {
    name: "BI posicion grafica project",
    query: "BI AZT ADP posicion grafica project overview",
    expectedSlugs: [
      "bi-azt-adp-posicion-grafica-project-overview",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- PPM / Resource assignments ---
  {
    name: "PPM resource assignments missing",
    query: "resource assignments ServiceNow PPM no existeixen",
    expectedSlugs: [
      "a-16-mar-2026-segueixen-sense-existir-resource-assignments-r",
    ],
    k: 15,
    minRecall: 0.0,  // exploratory: slug has no PPM keyword
  },
  // --- GitHub access ---
  {
    name: "Access public GitHub repos",
    query: "accedir repos github publics access",
    expectedSlugs: [
      "accedir-a-repos-github-publics",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Credentials / env vars ---
  {
    name: "Credentials env files management",
    query: "credencials fitxers env gestió secrets",
    expectedSlugs: [
      "gestio-de-credencials-amb-fitxers-env",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Cross-platform Linux setup ---
  {
    name: "GenAI Lab Linux cross-platform",
    query: "genai lab linux setup cross platform fallback",
    expectedSlugs: [
      "genai-lab-linux-setup-cross-platform-paths-fallback-config-d",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- SQLite migration ---
  {
    name: "SQLite additive migration pattern",
    query: "sqlite additive migration CREATE TABLE IF NOT EXISTS accumulated",
    expectedSlugs: [
      "additive-sqlite-migration-for-accumulated-state",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Teams AI channels ---
  {
    name: "Teams AI Claude channels",
    query: "teams channels AI claude allianz",
    expectedSlugs: [
      "canals-teams-sobre-aiclaude-a-allianz",
    ],
    k: 10,
    minRecall: 1.0,
  },
  // --- Harder: fuzzy, synonyms, paraphrase ---
  {
    name: "Fuzzy: timeout on LLM operations",
    query: "LLM call takes too long hangs timeout",
    expectedSlugs: [
      "braindistill-generate-fallava-silenciosament-per-timeout-cop",
    ],
    k: 15,
    minRecall: 0.5,
  },
  {
    name: "Paraphrase: reduce tool count",
    query: "too many tools reduce overhead consolidate MCP",
    expectedSlugs: [
      "p56-mcp-tool-diet-consolidar-tools-redueix-token-tax-fixa-pe",
    ],
    k: 15,
    minRecall: 0.0,  // exploratory: paraphrase without exact keywords
  },
  {
    name: "Synonym: send mail programmatically",
    query: "send mail programmatically windows automation outlook",
    expectedSlugs: [
      "enviar-emails-via-outlook-com-des-de-claude-code",
    ],
    k: 15,
    minRecall: 0.0,  // exploratory: synonym without keyword overlap
  },
  {
    name: "Catalan: com enviar correus",
    query: "com enviar correus electrònics des de codi",
    expectedSlugs: [
      "enviar-emails-via-outlook-com-des-de-claude-code",
    ],
    k: 15,
    minRecall: 0.0,  // exploratory: Catalan paraphrase
  },
  {
    name: "Mixed lang: Jenkins auth allianz toolchain",
    query: "jenkins connexió autenticació allianz toolchain",
    expectedSlugs: [
      "connexio-a-jenkins-allianz-epac-toolchain",
    ],
    k: 10,
    minRecall: 1.0,
  },
];

// ─── Run evaluation ────────────────────────────────────────────────────────────

// P14.2: Import vitality for stale-hit and vitality metrics
const { classifyVitalityZone } = await import("../scoring.js");
const { computeAllVitalities } = await import("../learnings.js");
const { readJSON } = await import("../file-io.js");

t.section("Recall@k + MRR evaluation on real brain data");

let totalExpected = 0;
let totalFound = 0;
let totalCases = 0;
let mrrSum = 0;
const results = [];

// P14.2: vitality map for stale-hit detection
const meta = readJSON("learnings-meta.json");
const vitalityMap = meta ? computeAllVitalities() : new Map();

for (const tc of testCases) {
  const { learnings } = await scoredSearch(tc.query, "learnings", null, false);
  const topK = learnings.slice(0, tc.k);
  const top3 = learnings.slice(0, 3);
  const top5 = learnings.slice(0, 5);
  const topSlugs = new Set(topK.map(l => l.slug));
  const slugRanks = new Map(topK.map((l, i) => [l.slug, i + 1]));

  const found = tc.expectedSlugs.filter(s => topSlugs.has(s));
  const recall = found.length / tc.expectedSlugs.length;
  const precision = found.length / tc.k;

  // P14.2: precision@3 and precision@5
  const foundIn3 = tc.expectedSlugs.filter(s => new Set(top3.map(l => l.slug)).has(s)).length;
  const foundIn5 = tc.expectedSlugs.filter(s => new Set(top5.map(l => l.slug)).has(s)).length;
  const precision3 = top3.length > 0 ? foundIn3 / Math.min(3, tc.expectedSlugs.length) : 0;
  const precision5 = top5.length > 0 ? foundIn5 / Math.min(5, tc.expectedSlugs.length) : 0;

  // P14.2: stale-hit rate and avg vitality of top-5
  let staleHits = 0;
  let vitalitySum = 0;
  let vitalityCount = 0;
  for (const l of top5) {
    const vObj = vitalityMap.get(l.slug);
    const v = vObj?.vitality ?? 0.5;
    const zone = vObj?.zone || classifyVitalityZone(v);
    vitalitySum += v;
    vitalityCount++;
    if (zone === "fading" || zone === "archived") staleHits++;
  }
  const staleRate = vitalityCount > 0 ? staleHits / vitalityCount : 0;
  const avgVitality = vitalityCount > 0 ? vitalitySum / vitalityCount : 0;

  // MRR: reciprocal rank of first expected slug found
  let reciprocalRank = 0;
  for (const slug of tc.expectedSlugs) {
    const rank = slugRanks.get(slug);
    if (rank) {
      reciprocalRank = Math.max(reciprocalRank, 1 / rank);
    }
  }
  mrrSum += reciprocalRank;

  totalExpected += tc.expectedSlugs.length;
  totalFound += found.length;
  totalCases++;

  const pass = recall >= tc.minRecall;
  t.assert(pass, `${tc.name}: recall=${recall.toFixed(2)} p@3=${precision3.toFixed(2)} p@5=${precision5.toFixed(2)} RR=${reciprocalRank.toFixed(2)} stale=${staleRate.toFixed(2)} (found ${found.length}/${tc.expectedSlugs.length} in top-${tc.k})`);

  results.push({
    name: tc.name,
    recall,
    precision,
    precision3,
    precision5,
    reciprocalRank,
    staleRate,
    avgVitality,
    found: found.length,
    expected: tc.expectedSlugs.length,
    k: tc.k,
    pass,
    missing: tc.expectedSlugs.filter(s => !topSlugs.has(s)),
  });
}

// ─── Summary metrics (P14.2 enhanced, bucketed per Codex review) ─────────────

t.section("Retrieval metrics summary (P14.2)");

// Bucket classification: gated (minRecall > 0), exploratory (minRecall === 0)
const gated = results.filter((_, i) => testCases[i].minRecall > 0);
const exploratory = results.filter((_, i) => testCases[i].minRecall === 0);

function bucketMetrics(bucket) {
  if (bucket.length === 0) return null;
  const found = bucket.reduce((s, r) => s + r.found, 0);
  const expected = bucket.reduce((s, r) => s + r.expected, 0);
  return {
    count: bucket.length,
    recall: found / (expected || 1),
    p3: bucket.reduce((s, r) => s + r.precision3, 0) / bucket.length,
    p5: bucket.reduce((s, r) => s + r.precision5, 0) / bucket.length,
    mrr: bucket.reduce((s, r) => s + r.reciprocalRank, 0) / bucket.length,
    stale: bucket.reduce((s, r) => s + r.staleRate, 0) / bucket.length,
    vitality: bucket.reduce((s, r) => s + r.avgVitality, 0) / bucket.length,
    passRate: bucket.filter(r => r.pass).length / bucket.length,
    found, expected,
  };
}

const all = bucketMetrics(results);
const gm = bucketMetrics(gated);
const em = bucketMetrics(exploratory);

if (!all || all.count === 0) {
  console.log("  No results to evaluate.");
  const { passed, failed } = t.summary();
  process.exit(failed > 0 ? 1 : 0);
}

console.log(`  === Overall (${all.count} cases) ===`);
console.log(`  Recall@k:    ${all.recall.toFixed(3)} (${all.found}/${all.expected})`);
console.log(`  Precision@3: ${all.p3.toFixed(3)}`);
console.log(`  Precision@5: ${all.p5.toFixed(3)}`);
console.log(`  MRR:         ${all.mrr.toFixed(3)}`);
console.log(`  Stale rate:  ${all.stale.toFixed(3)}`);
console.log(`  Avg vitality: ${all.vitality.toFixed(3)}`);
console.log(`  Pass rate:   ${(all.passRate * 100).toFixed(1)}%`);

if (gm) {
  console.log(``);
  console.log(`  === Gated (${gm.count} cases, minRecall > 0) ===`);
  console.log(`  Recall@k:    ${gm.recall.toFixed(3)} (${gm.found}/${gm.expected})`);
  console.log(`  Precision@3: ${gm.p3.toFixed(3)}`);
  console.log(`  MRR:         ${gm.mrr.toFixed(3)}`);
  console.log(`  Pass rate:   ${(gm.passRate * 100).toFixed(1)}%`);
}

if (em && em.count > 0) {
  console.log(``);
  console.log(`  === Exploratory (${em.count} cases, minRecall = 0) ===`);
  console.log(`  Recall@k:    ${em.recall.toFixed(3)} (${em.found}/${em.expected}) [non-blocking]`);
  console.log(`  MRR:         ${em.mrr.toFixed(3)} [trend-only]`);
}

// P14.2: Regression gates (overall + gated bucket)
t.assert(all.recall >= 0.6, `Recall gate: >= 0.6 (got ${all.recall.toFixed(3)})`);
t.assert(all.mrr >= 0.3, `MRR gate: >= 0.3 (got ${all.mrr.toFixed(3)})`);
t.assert(all.passRate >= 0.75, `Pass rate gate: >= 75% (got ${(all.passRate * 100).toFixed(1)}%)`);
t.assert(all.stale <= 0.3, `Stale rate gate: <= 30% (got ${(all.stale * 100).toFixed(1)}%)`);
t.assert(all.vitality >= 0.3, `Vitality gate: avg >= 0.3 (got ${all.vitality.toFixed(3)})`);
if (gm) {
  t.assert(gm.passRate >= 0.90, `Gated pass rate: >= 90% (got ${(gm.passRate * 100).toFixed(1)}%)`);
}
// Show failures in detail
const failures = results.filter(r => !r.pass);
if (failures.length > 0) {
  console.log("\n  Failed cases:");
  for (const f of failures) {
    console.log(`    ${f.name}: recall=${f.recall.toFixed(2)}, missing: ${f.missing.join(", ")}`);
  }
}

const { passed, failed } = t.summary();
process.exit(failed > 0 ? 1 : 0);
