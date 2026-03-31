/**
 * Tests for BM25 semantic search: stemming, trigrams, index, integration.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

// semantic.js → file-io.js → config.js needs BRAIN_PATH at import time
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-sem-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({ version: "2.0", sessions: [] }));

const { BM25Index, stem, trigrams, trigramSimilarity, buildSemanticIndex } = await import("../semantic.js");

const t = createSuite("semantic");

// ─── Stemming ────────────────────────────────────────────────────────────────

t.section("stem");

t.assert(stem("running") === "runn", `running → runn (got: ${stem("running")})`);
t.assert(stem("configuration") === "configur", `configuration → configur (got: ${stem("configuration")})`);
t.assert(stem("deployment") === "deploy", `deployment → deploy (got: ${stem("deployment")})`);
t.assert(stem("accessible") === "access", `accessible → access (got: ${stem("accessible")})`);
t.assert(stem("dangerous") === "danger", `dangerous → danger (got: ${stem("dangerous")})`);
t.assert(stem("effectively") === "effective", `effectively → effective (got: ${stem("effectively")})`);
t.assert(stem("cat") === "cat", "short words unchanged");
t.assert(stem("test") === "test", "4-char words unchanged");
t.assert(stem("tests") === "test", `tests → test (got: ${stem("tests")})`);
t.assert(stem("bass") === "bass", "words ending in ss unchanged");
// Catalan — basic
t.assert(stem("configuració") === "configura", `configuració → configura (got: ${stem("configuració")})`);

// Catalan — derivational -itz* family
t.assert(stem("actualització") === "actual", `actualització → actual (got: ${stem("actualització")})`);
t.assert(stem("actualitzacions") === "actual", `actualitzacions → actual (got: ${stem("actualitzacions")})`);
t.assert(stem("normalitzar") === "normal", `normalitzar → normal (got: ${stem("normalitzar")})`);
t.assert(stem("normalitzat") === "normal", `normalitzat → normal (got: ${stem("normalitzat")})`);
t.assert(stem("optimitzada") === "optim", `optimitzada → optim (got: ${stem("optimitzada")})`);

// Catalan — nominals: -cions/-sions/-ions
t.assert(stem("configuracions") === "configura", `configuracions → configura (got: ${stem("configuracions")})`);
t.assert(stem("connexions") === "connex", `connexions → connex (got: ${stem("connexions")})`);
t.assert(stem("connexió") === "connex", `connexió → connex (got: ${stem("connexió")})`);

// Catalan — nominals: -itat/-itats, -ments
t.assert(stem("disponibilitat") === "disponibil", `disponibilitat → disponibil (got: ${stem("disponibilitat")})`);
t.assert(stem("disponibilitats") === "disponibil", `disponibilitats → disponibil (got: ${stem("disponibilitats")})`);
t.assert(stem("desplegament") === "desplega", `desplegament → desplega (got: ${stem("desplegament")})`);
t.assert(stem("desplegaments") === "desplega", `desplegaments → desplega (got: ${stem("desplegaments")})`);

// Catalan — agent: -ador/-adors
t.assert(stem("processador") === "process", `processador → process (got: ${stem("processador")})`);
t.assert(stem("processadors") === "process", `processadors → process (got: ${stem("processadors")})`);

// Catalan — abstract: -isme/-ista
t.assert(stem("determinisme") === "determin", `determinisme → determin (got: ${stem("determinisme")})`);
t.assert(stem("analista") === "analista", `analista unchanged (short stem guard) (got: ${stem("analista")})`);
t.assert(stem("especialista") === "especial", `especialista → especial (got: ${stem("especialista")})`);

// Catalan — adjectival: -bles (plural)
t.assert(stem("configurable") === "configur", `configurable → configur (got: ${stem("configurable")})`);
t.assert(stem("disponibles") === "disponi", `disponibles → disponi (got: ${stem("disponibles")})`);

// Catalan — short words unchanged
t.assert(stem("codi") === "codi", "short Catalan word unchanged");
t.assert(stem("més") === "més", "short Catalan word unchanged");

// Catalan — -tat
t.assert(stem("qualitat") === "qual", `qualitat → qual (got: ${stem("qualitat")})`);

// ─── Trigrams ────────────────────────────────────────────────────────────────

t.section("trigrams");

t.assert(JSON.stringify(trigrams("hello")) === '["hel","ell","llo"]', "hello trigrams");
t.assert(JSON.stringify(trigrams("ab")) === '["ab"]', "short word returns self");
t.assert(trigrams("abc").length === 1, "3-char word = 1 trigram");

// ─── Trigram similarity ──────────────────────────────────────────────────────

t.section("trigramSimilarity");

t.assert(trigramSimilarity("postgres", "postgresql") > 0.5, "postgres ~ postgresql");
t.assert(trigramSimilarity("config", "configuration") > 0.3, "config ~ configuration");
t.assert(trigramSimilarity("hello", "world") < 0.2, "hello !~ world");
t.assert(trigramSimilarity("abc", "abc") === 1.0, "identical = 1.0");
t.assert(trigramSimilarity("confluence", "confuence") >= 0.4, "typo tolerance");

// ─── BM25 Index ──────────────────────────────────────────────────────────────

t.section("BM25Index basic");

{
  const idx = new BM25Index();
  idx.addDocument("doc1", "the quick brown fox jumps over the lazy dog");
  idx.addDocument("doc2", "a fast brown cat sits on a mat");
  idx.addDocument("doc3", "docker container deployment kubernetes");
  idx.finalize();

  t.assert(idx.N === 3, "3 documents indexed");
  t.assert(idx.built === true, "index is built");
  t.assert(idx.avgdl > 0, "avgdl computed");

  const results = idx.search(["fox"]);
  t.assert(results.size > 0, "search for 'fox' finds results");
  t.assert(results.get("doc1") > 0, "doc1 found for 'fox'");
  t.assert(!results.has("doc3"), "doc3 not found for 'fox'");

  const results2 = idx.search(["docker", "kubernetes"]);
  t.assert(results2.get("doc3") > 0, "doc3 found for docker+kubernetes");
  t.assert((results2.get("doc3") || 0) > (results2.get("doc1") || 0), "doc3 scores higher than doc1 for docker");
}

// ─── BM25 with stemming ─────────────────────────────────────────────────────

t.section("BM25Index stemming");

{
  const idx = new BM25Index();
  idx.addDocument("doc1", "error handling and exception management");
  idx.addDocument("doc2", "the errors were handled gracefully");
  idx.finalize();

  // "errors" should match "error" via stemming
  const results = idx.search(["errors"]);
  t.assert(results.has("doc1"), "stemming: 'errors' finds doc with 'error'");
  t.assert(results.has("doc2"), "stemming: 'errors' finds doc with 'errors'");
}

// ─── BM25 fuzzy matching ────────────────────────────────────────────────────

t.section("BM25Index fuzzy matching");

{
  const idx = new BM25Index();
  idx.addDocument("doc1", "postgresql database configuration and optimization");
  idx.addDocument("doc2", "python scripting for automation");
  idx.finalize();

  // "postgres" should fuzzy-match "postgresql"
  const results = idx.search(["postgres"]);
  t.assert(results.has("doc1"), "fuzzy: 'postgres' finds 'postgresql' doc");
}

// ─── BM25 IDF weighting ────────────────────────────────────────────────────

t.section("BM25Index IDF weighting");

{
  const idx = new BM25Index();
  idx.addDocument("doc1", "docker container docker image docker build");
  idx.addDocument("doc2", "docker setup guide");
  idx.addDocument("doc3", "kubernetes orchestration with special deployment");
  idx.finalize();

  // "special" appears in only 1 doc, "docker" in 2 → "special" has higher IDF
  const idfDocker = idx.idf.get("docker") || 0;
  const idfSpecial = idx.idf.get("special") || 0;
  t.assert(idfSpecial > idfDocker, `rare term 'special' has higher IDF (${idfSpecial.toFixed(2)}) than common 'docker' (${idfDocker.toFixed(2)})`);
}

// ─── buildSemanticIndex ──────────────────────────────────────────────────────

t.section("buildSemanticIndex");

{
  const learnings = [
    { slug: "ssl-fix", title: "SSL certificate fix", headline: "Zscaler proxy causes cert errors", tags: ["ssl", "zscaler"], body: "Use curl instead of requests for corporate proxy" },
    { slug: "docker-build", title: "Docker build patterns", headline: "Multi-stage builds reduce image size", tags: ["docker"], body: "Always use multi-stage builds in production" }
  ];
  const files = [
    { relPath: "memory/sessions/2026-01-01_test.md", content: "# Session about SSL and certificates\nFixed SSL issues with Zscaler" }
  ];

  const idx = buildSemanticIndex(learnings, files);
  t.assert(idx.N === 3, "3 docs indexed (2 learnings + 1 file)");
  t.assert(idx.built, "index finalized");

  // Search for certificate-related content
  const results = idx.search(["certificate", "ssl"]);
  t.assert(results.has("learning:ssl-fix"), "finds ssl-fix learning");
  t.assert(results.has("file:memory/sessions/2026-01-01_test.md"), "finds session file");
  t.assert((results.get("learning:ssl-fix") || 0) > (results.get("learning:docker-build") || 0),
    "ssl-fix scores higher than docker-build for ssl query");

  // Search for "proxy" — should match via body text
  const results2 = idx.search(["proxy"]);
  t.assert(results2.has("learning:ssl-fix"), "finds ssl-fix via body text 'proxy'");
}

// ─── Stop words filtering ────────────────────────────────────────────────────

t.section("BM25 stop words");

{
  const idx = new BM25Index();
  idx.addDocument("doc1", "the quick configuration for the deployment");
  idx.finalize();

  // "the" is a stop word — should not be in inverted index
  t.assert(!idx.invertedIndex.has("the"), "'the' not indexed (stop word)");
  t.assert(idx.invertedIndex.has("quick"), "'quick' is indexed");
  t.assert(idx.invertedIndex.has("configur"), "stemmed 'configur' is indexed");
}

// ─── Empty index ─────────────────────────────────────────────────────────────

t.section("BM25 edge cases");

{
  const idx = new BM25Index();
  idx.finalize();
  const results = idx.search(["anything"]);
  t.assert(results.size === 0, "empty index returns empty results");
}

{
  const idx = new BM25Index();
  idx.addDocument("doc1", "hello world");
  idx.finalize();
  const results = idx.search([]);
  t.assert(results.size === 0, "empty query returns empty results");
}

export const results = t.summary();
