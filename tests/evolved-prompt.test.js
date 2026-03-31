import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  compileEvolvedPrompt,
  parseLearningsFromBrainResult,
  getEvolvedVersion,
} from "../src/evolved-prompt.js";

// Use a temp dir for tests (we can't mock EVOLVED_DIR easily since it's a const,
// but we test the pure functions + parser)

describe("parseLearningsFromBrainResult", () => {
  it("parses standard format", () => {
    const text = `# Brain Learnings
Total: 2

- **Use curl for HTTP** [use-curl-for-http] (type:warning, vitality:0.95, hits:5)
  SSL proxy blocks Python requests
- **Conventional commits** [conventional-commits] (type:preference, vitality:0.80, hits:3)
  User prefers conventional commit format`;

    const result = parseLearningsFromBrainResult(text);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, "Use curl for HTTP");
    assert.equal(result[0].slug, "use-curl-for-http");
    assert.equal(result[0].type, "warning");
    assert.equal(result[0].vitality, 0.95);
    assert.equal(result[0].hit_count, 5);
    assert.ok(result[0].body.includes("SSL proxy"));

    assert.equal(result[1].type, "preference");
    assert.equal(result[1].hit_count, 3);
  });

  it("returns empty for null/empty input", () => {
    assert.deepEqual(parseLearningsFromBrainResult(null), []);
    assert.deepEqual(parseLearningsFromBrainResult(""), []);
  });

  it("handles missing body lines", () => {
    const text = `- **No body here** [no-body] (type:learning, vitality:0.50, hits:0)`;
    const result = parseLearningsFromBrainResult(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].body, "");
  });

  it("handles malformed meta gracefully", () => {
    const text = `- **Broken** [broken-slug] (type:)`;
    const result = parseLearningsFromBrainResult(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "learning");  // empty type falls back to 'learning'
  });

  it("handles multiple body lines", () => {
    const text = `- **Multi line** [multi] (type:pattern, vitality:0.70, hits:2)
  First line of body
  Second line of body
  Third line of body
- **Next entry** [next] (type:learning, vitality:0.50, hits:0)`;

    const result = parseLearningsFromBrainResult(text);
    assert.equal(result.length, 2);
    assert.ok(result[0].body.includes("First line"));
    assert.ok(result[0].body.includes("Second line"));
    assert.ok(result[0].body.includes("Third line"));
  });
});

describe("compileEvolvedPrompt", () => {
  it("compiles with mock brain functions", async () => {
    const mockGetLearnings = async () => {
      return `# Learnings
- **Catalan preferred** [catalan-preferred] (type:preference, vitality:0.90, hits:5)
  User prefers responses in Catalan
- **SSL blocks requests** [ssl-blocks] (type:warning, vitality:0.85, hits:4)
  Corporate proxy blocks Python requests
- **Deploy to Jenkins** [deploy-jenkins] (type:procedure, vitality:0.75, hits:1)
  Push to develop, wait CI, build with params`;
    };

    const result = await compileEvolvedPrompt(mockGetLearnings);
    assert.ok(result.version >= 1);
    assert.ok(result.files.length > 0);
    assert.ok(result.totalLines > 0);
  });
});
