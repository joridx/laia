/**
 * P12.3: Confirmation scoring tests
 * Tests getTypePrior (saturating curve, edge cases), checkSearchAttribution
 * confirmation increment, and integration with search scoring.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createSuite } from "./harness.js";

const t = createSuite("confirmation-scoring (P12.3)");

// ─── Setup ────────────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-conf-test-"));
process.env.LAIA_BRAIN_PATH = tmpDir;
process.env.BRAIN_GIT_SYNC = "false";

for (const dir of [
  "memory/sessions", "memory/learnings", "memory/projects",
  "memory/todos", "knowledge/general"
]) {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
}
fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify({ version: "2.0", sessions: [], consolidation: {} }));
fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({ tag_hits: {}, search_hits: {}, total_queries: 0 }));
fs.writeFileSync(path.join(tmpDir, "relations.json"), JSON.stringify({ concepts: {} }));
fs.writeFileSync(path.join(tmpDir, "memory/todos.json"), "[]");

// Seed learnings-meta with a principle and a learning
const metaData = {
  version: "1.0",
  learnings: {
    "test-principle-a": {
      title: "Test Principle A",
      file: "memory/learnings/test-principle-a.md",
      type: "principle",
      tags: ["test"],
      hit_count: 5,
      search_appearances: 10,
      search_followup_hits: 2,
      confirmation_count: 0,
      last_confirmed: null,
      created_date: "2026-03-20"
    },
    "test-principle-b": {
      title: "Test Principle B with confirmations",
      file: "memory/learnings/test-principle-b.md",
      type: "principle",
      tags: ["test"],
      hit_count: 20,
      search_appearances: 30,
      search_followup_hits: 8,
      confirmation_count: 7,
      last_confirmed: "2026-03-19T10:00:00.000Z",
      created_date: "2026-03-15"
    },
    "test-learning": {
      title: "Test Learning",
      file: "memory/learnings/test-learning.md",
      type: "learning",
      tags: ["test"],
      hit_count: 3,
      search_appearances: 5,
      search_followup_hits: 1,
      created_date: "2026-03-20"
    }
  }
};

fs.writeFileSync(path.join(tmpDir, "learnings-meta.json"), JSON.stringify(metaData, null, 2));

// Create corresponding .md files
for (const [slug, data] of Object.entries(metaData.learnings)) {
  const content = `---\ntitle: "${data.title}"\ntype: ${data.type}\ntags: [${data.tags.join(", ")}]\ncreated: ${data.created_date}\nslug: ${slug}\n---\n\n${data.title} body content.\n`;
  fs.writeFileSync(path.join(tmpDir, data.file), content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// getTypePrior — unit tests
// ═══════════════════════════════════════════════════════════════════════════════

const { getTypePrior, TYPE_PRIOR } = await import("../scoring.js");

t.section("getTypePrior — static types unchanged");

t.assert(getTypePrior("pattern", {}) === 1.05, "pattern stays 1.05");
t.assert(getTypePrior("warning", {}) === 1.0, "warning stays 1.0");
t.assert(getTypePrior("learning", {}) === 1.0, "learning stays 1.0");
t.assert(getTypePrior("unknown_type", {}) === 1.0, "unknown type defaults to 1.0");

t.section("getTypePrior — principle base (0 confirmations)");

t.assert(getTypePrior("principle", null) === 1.15, "null meta → base 1.15");
t.assert(getTypePrior("principle", undefined) === 1.15, "undefined meta → base 1.15");
t.assert(getTypePrior("principle", {}) === 1.15, "empty meta → base 1.15");
t.assert(getTypePrior("principle", { confirmation_count: 0 }) === 1.15, "c=0 → base 1.15");

t.section("getTypePrior — saturating curve");

const c1 = getTypePrior("principle", { confirmation_count: 1 });
const c2 = getTypePrior("principle", { confirmation_count: 2 });
const c5 = getTypePrior("principle", { confirmation_count: 5 });
const c10 = getTypePrior("principle", { confirmation_count: 10 });
const c20 = getTypePrior("principle", { confirmation_count: 20 });
const c50 = getTypePrior("principle", { confirmation_count: 50 });

t.assert(c1 > 1.15, `c=1 (${c1}) > base 1.15`);
t.assert(c2 > c1, `c=2 (${c2}) > c=1 (${c1})`);
t.assert(c5 > c2, `c=5 (${c5}) > c=2 (${c2})`);
t.assert(c10 > c5, `c=10 (${c10}) > c=5 (${c5})`);
t.assert(c20 > c10, `c=20 (${c20}) > c=10 (${c10})`);

// Saturation: c=50 barely above c=20
const satDiff = c50 - c20;
t.assert(satDiff < 0.005, `saturation: c50-c20 diff=${satDiff.toFixed(4)} < 0.005`);

// Asymptote ≈ 1.35
t.assert(c50 < 1.36, `c=50 (${c50}) < 1.36 (asymptote ~1.35)`);
t.assert(c50 > 1.34, `c=50 (${c50}) > 1.34`);

// Marginal returns decrease (per unit)
const marginal_0_1 = c1 - getTypePrior("principle", { confirmation_count: 0 });
const marginal_9_10 = c10 - getTypePrior("principle", { confirmation_count: 9 });
t.assert(marginal_0_1 > marginal_9_10, `diminishing returns: Δ(0→1)=${marginal_0_1.toFixed(4)} > Δ(9→10)=${marginal_9_10.toFixed(4)}`);

t.section("getTypePrior — edge cases (Codex must-fix #1)");

// String coercion
t.assert(getTypePrior("principle", { confirmation_count: "5" }) === c5, "string '5' coerced correctly");

// Negative clamped to 0
t.assert(getTypePrior("principle", { confirmation_count: -3 }) === 1.15, "negative → base 1.15");

// NaN → base
t.assert(getTypePrior("principle", { confirmation_count: NaN }) === 1.15, "NaN → base 1.15");

// Garbage string → base
t.assert(getTypePrior("principle", { confirmation_count: "abc" }) === 1.15, "garbage string → base 1.15");

// Infinity → clamped (exp(-Infinity/4)=0, result = 1.35)
const infResult = getTypePrior("principle", { confirmation_count: Infinity });
t.assert(infResult <= 1.36, `Infinity → capped at ~1.35: ${infResult}`);

// ═══════════════════════════════════════════════════════════════════════════════
// checkSearchAttribution — confirmation_count increment
// ═══════════════════════════════════════════════════════════════════════════════

t.section("checkSearchAttribution — confirmation increment");

const { checkSearchAttribution, _seedAttributionCache } = await import("../learnings.js");

// Seed the attribution cache (simulates search results that were shown)
_seedAttributionCache("test-principle-a", Date.now());
_seedAttributionCache("test-learning", Date.now());

// Trigger attribution (simulates user accessing results)
checkSearchAttribution(["test-principle-a", "test-learning"]);

// Read meta and verify
const afterMeta = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf8"));

// Principle should have confirmation_count incremented
t.assert(afterMeta.learnings["test-principle-a"].confirmation_count === 1,
  "principle confirmation_count incremented to 1");
t.assert(afterMeta.learnings["test-principle-a"].last_confirmed !== null,
  "principle last_confirmed set");
t.assert(afterMeta.learnings["test-principle-a"].search_followup_hits === 3,
  "principle followup_hits also incremented (was 2, now 3)");

// Learning should NOT have confirmation_count
t.assert(afterMeta.learnings["test-learning"].confirmation_count === undefined,
  "learning does NOT get confirmation_count");
t.assert(afterMeta.learnings["test-learning"].search_followup_hits === 2,
  "learning followup_hits incremented (was 1, now 2)");

// Dedup: second call should not increment (cache consumed)
checkSearchAttribution(["test-principle-a"]);
const afterDedup = JSON.parse(fs.readFileSync(path.join(tmpDir, "learnings-meta.json"), "utf8"));
t.assert(afterDedup.learnings["test-principle-a"].confirmation_count === 1,
  "dedup: confirmation_count still 1 after second call");

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: getTypePrior with real meta
// ═══════════════════════════════════════════════════════════════════════════════

t.section("getTypePrior — real meta integration");

// test-principle-a now has 1 confirmation
const priorA = getTypePrior("principle", afterMeta.learnings["test-principle-a"]);
t.assert(priorA > 1.15, `principle A with 1 conf: ${priorA} > 1.15`);

// test-principle-b has 7 confirmations from seed
const priorB = getTypePrior("principle", afterMeta.learnings["test-principle-b"]);
t.assert(priorB > priorA, `principle B (7 conf: ${priorB}) > principle A (1 conf: ${priorA})`);

// test-learning stays 1.0
const priorL = getTypePrior("learning", afterMeta.learnings["test-learning"]);
t.assert(priorL === 1.0, `learning prior stays 1.0: ${priorL}`);

// ─── Cleanup ────────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ─── Summary ────────────────────────────────────────────────────────────────

const { passed, failed } = t.summary();
if (failed > 0) process.exit(1);
