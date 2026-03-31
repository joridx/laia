#!/usr/bin/env node

/**
 * Test runner — runs each test suite in an isolated subprocess.
 * This avoids the singleton BRAIN_PATH problem where all suites share the same
 * ESM module instance (and thus the same BRAIN_PATH from whichever loaded first).
 *
 * Run: node mcp-server/tests/run.js
 *
 * Note: retrieval.test.js is NOT included here — it needs real BRAIN_PATH data.
 * Run separately: LAIA_BRAIN_PATH=$HOME/laia-data node tests/retrieval.test.js
 */

import { execFile } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const suites = [
  "utils.test.js",
  "scoring.test.js",
  "integration.test.js",
  "sideeffects.test.js",
  "semantic.test.js",
  "gitsync-helpers.test.js",
  "database.test.js",
  "pagerank.test.js",
  "spreading.test.js",
  "embeddings.test.js",
  "llm.test.js",
  "distillation.test.js",
  "handler-contracts.test.js",
  "failure/empty-dir.test.js",
  "failure/json-corrupt.test.js",
  "index-consistency.test.js",
];

const totals = { passed: 0, failed: 0, crashed: 0 };

function runSuite(suiteName) {
  return new Promise((resolve) => {
    const suitePath = path.join(__dirname, suiteName);
    const child = execFile("node", [suitePath], {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      const output = stdout + stderr;

      // Parse results from harness summary line: [suite] X passed, Y failed, Z total
      const summaryMatch = output.match(/(\d+) passed, (\d+) failed, (\d+) total/);
      const passCount = summaryMatch ? parseInt(summaryMatch[1]) : 0;
      const failCount = summaryMatch ? parseInt(summaryMatch[2]) : 0;
      // Also count individual FAIL lines for detail
      const failLines = output.split("\n").filter(l => /^\s+FAIL:/.test(l));

      if (err && err.killed) {
        // Timeout
        console.log(`\n💀 ${suiteName} — TIMEOUT (60s)`);
        totals.crashed++;
        resolve({ suite: suiteName, passed: passCount, failed: failCount, crashed: true, reason: "timeout" });
      } else if (err && !err.code) {
        // Spawn error
        console.log(`\n💀 ${suiteName} — SPAWN ERROR: ${err.message}`);
        totals.crashed++;
        resolve({ suite: suiteName, passed: 0, failed: 0, crashed: true, reason: err.message });
      } else {
        const lines = output.split("\n");

        const crashed = /TypeError|ReferenceError|SyntaxError|Error:.*ENOENT/.test(output);
        if (crashed) {
          const errLine = lines.find(l => /TypeError|ReferenceError|SyntaxError|ENOENT/.test(l)) || "";
          console.log(`\n💀 ${suiteName} — CRASHED: ${errLine.trim()}`);
          console.log(`   (${passCount} passed, ${failCount} failed before crash)`);
          totals.crashed++;
        } else {
          if (failCount > 0) {
            console.log(`\n❌ ${suiteName} — ${passCount} passed, ${failCount} failed`);
            for (const fl of failLines) console.log(`   ${fl.trim()}`);
          } else {
            console.log(`✅ ${suiteName} — ${passCount} passed`);
          }
        }

        totals.passed += passCount;
        totals.failed += failCount;
        resolve({ suite: suiteName, passed: passCount, failed: failCount, crashed });
      }
    });
  });
}

console.log(`Running ${suites.length} test suites (isolated subprocesses)...\n`);

const results = [];
for (const suite of suites) {
  results.push(await runSuite(suite));
}

console.log(`\n${"=".repeat(60)}`);
console.log(`TOTAL: ${totals.passed} passed, ${totals.failed} failed, ${totals.crashed} crashed`);
console.log(`${"=".repeat(60)}`);

if (totals.crashed > 0) {
  console.log(`\n⚠️  ${totals.crashed} suite(s) crashed — tests may be incomplete.`);
}

process.exit(totals.failed > 0 || totals.crashed > 0 ? 1 : 0);
