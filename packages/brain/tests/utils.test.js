/**
 * Tests for utils.js — text processing, parsing, path handling.
 */

import {
  normPath, slugify, sanitizeTag, tokenize, stripHtml,
  parseLearningFrontmatter, isLearningFile, buildLearningMarkdown,
  extractTags, detectProjectFromPath, noteSlugFromPath, isHumanNote
} from "../utils.js";
import { createSuite } from "./harness.js";

const t = createSuite("utils");

// ─── normPath ────────────────────────────────────────────────────────────────

t.section("normPath");

t.assert(normPath("C:\\claude\\data") === "C:/claude/data", "Windows backslashes to forward slashes");
t.assert(normPath("/home/user/data") === "/home/user/data", "Unix paths unchanged");
t.assert(normPath("mixed\\path/here") === "mixed/path/here", "Mixed separators normalized");
t.assert(normPath("") === "", "Empty string");

// ─── slugify ─────────────────────────────────────────────────────────────────

t.section("slugify");

t.assert(slugify("Hello World") === "hello-world", "Basic slugify");
t.assert(slugify("Café résumé") === "cafe-resume", "Removes accents");
t.assert(slugify("foo--bar") === "foo-bar", "Collapses hyphens");
t.assert(slugify("  leading trailing  ") === "leading-trailing", "Trims spaces");
t.assert(slugify("special!@#chars$%^") === "specialchars", "Removes special chars");
t.assert(slugify("a".repeat(100)).length === 60, "Max 60 chars");
t.assert(slugify("") === "", "Empty string");

// ─── sanitizeTag ─────────────────────────────────────────────────────────────

t.section("sanitizeTag");

t.assert(sanitizeTag("Docker") === "docker", "Lowercase");
t.assert(sanitizeTag("#docker") === "docker", "Removes #");
t.assert(sanitizeTag("formació") === "formacio", "Removes accents");
t.assert(sanitizeTag("ci/cd") === "cicd", "Removes special chars");
t.assert(sanitizeTag("--leading--") === "leading", "Trims hyphens");
t.assert(sanitizeTag("3NF") === "3nf", "Numbers preserved");

// ─── tokenize ────────────────────────────────────────────────────────────────

t.section("tokenize");

t.assert(JSON.stringify(tokenize("hello world")) === '["hello","world"]', "Basic split");
t.assert(JSON.stringify(tokenize("Hello-World_Test")) === '["hello","world","test"]', "Split on separators, lowercase");
t.assert(tokenize("a").length === 0, "Single char filtered out (min length 2)");
t.assert(tokenize("").length === 0, "Empty string returns empty");
t.assert(tokenize(null).length === 0, "Null returns empty");
t.assert(tokenize("api capital").every(tk => tk.length >= 2), "All tokens >= 2 chars");
t.assert(!tokenize("capital").includes("api"), "'api' not substring-matched in 'capital'");
t.assert(tokenize("foo.bar,baz;qux").length === 4, "Splits on punctuation");

// ─── stripHtml ───────────────────────────────────────────────────────────────

t.section("stripHtml");

t.assert(stripHtml("<p>Hello</p>") === "Hello", "Strips paragraph tags");
t.assert(stripHtml("a<br/>b") === "a\nb", "br → newline");
t.assert(stripHtml("&amp; &lt; &gt;") === "& < >", "Decodes entities");
t.assert(stripHtml("&quot;hi&quot;") === '"hi"', "Decodes quotes");
t.assert(stripHtml("&nbsp;") === "", "nbsp → space → trimmed");
t.assert(stripHtml("<h1>Title</h1><p>Body</p>").includes("Title"), "Preserves text from headings");
t.assert(!stripHtml("<script>alert('x')</script>").includes("<script>"), "Strips script tags");
t.assert(stripHtml("a\n\n\n\nb") === "a\n\nb", "Collapses excess newlines");

// ─── parseLearningFrontmatter ────────────────────────────────────────────────

t.section("parseLearningFrontmatter");

const validMd = `---
title: "Test Learning"
headline: "A test headline"
type: pattern
created: 2026-01-01
tags: [docker, devops]
slug: test-learning
---

Body content here.`;

const parsed = parseLearningFrontmatter(validMd);
t.assert(parsed !== null, "Parses valid frontmatter");
t.assert(parsed.frontmatter.title === "Test Learning", "Extracts title");
t.assert(parsed.frontmatter.type === "pattern", "Extracts type");
t.assert(parsed.frontmatter.tags.length === 2, "Extracts tags array");
t.assert(parsed.frontmatter.tags[0] === "docker", "First tag correct");
t.assert(parsed.body === "Body content here.", "Extracts body");

t.assert(parseLearningFrontmatter(null) === null, "Null input → null");
t.assert(parseLearningFrontmatter("no frontmatter") === null, "No frontmatter → null");
t.assert(parseLearningFrontmatter("---\ntitle: x\n") === null, "Unclosed frontmatter → null");

const emptyTags = parseLearningFrontmatter("---\ntags: []\n---\nbody");
t.assert(emptyTags.frontmatter.tags.length === 0, "Empty tags array");

// ─── isLearningFile ──────────────────────────────────────────────────────────

t.section("isLearningFile");

t.assert(isLearningFile("memory/learnings/test.md") === true, "Valid learning path");
t.assert(isLearningFile("C:\\data\\memory\\learnings\\test.md") === true, "Windows learning path");
t.assert(isLearningFile("memory/learnings/_legacy/old.md") === false, "Legacy excluded");
t.assert(isLearningFile("memory/sessions/test.md") === false, "Sessions excluded");
t.assert(isLearningFile("memory/learnings/test.txt") === false, "Non-md excluded");

// ─── buildLearningMarkdown ───────────────────────────────────────────────────

t.section("buildLearningMarkdown");

const md = buildLearningMarkdown("Test Title", "warning", ["docker", "api"], "First line\nSecond line");
t.assert(md.includes('title: "Test Title"'), "Contains title in frontmatter");
t.assert(md.includes("type: warning"), "Contains type");
t.assert(md.includes("tags: [docker, api]"), "Contains tags");
t.assert(md.includes("#avoid"), "Warning type → #avoid tag");
t.assert(md.includes("First line\nSecond line"), "Contains body");

const patternMd = buildLearningMarkdown("Pattern", "pattern", [], "content");
t.assert(patternMd.includes("#pattern"), "Pattern type → #pattern tag");

const learningMd = buildLearningMarkdown("Learn", "learning", [], "content");
t.assert(learningMd.includes("#learning"), "Learning type → #learning tag");

// ─── extractTags ─────────────────────────────────────────────────────────────

t.section("extractTags");

t.assert(extractTags("docker build").includes("docker"), "Detects docker");
t.assert(extractTags("git commit push").includes("git"), "Detects git");
t.assert(extractTags("SELECT * FROM table").includes("sql"), "Detects SQL");
t.assert(extractTags("curl api endpoint").includes("api"), "Detects API");
t.assert(extractTags("nothing relevant here").length === 0, "No tags for irrelevant text");
t.assert(extractTags("deploy to production").includes("deployment"), "Detects deployment");
t.assert(extractTags("bearer token auth").includes("auth"), "Detects auth");

// ─── detectProjectFromPath ───────────────────────────────────────────────────

t.section("detectProjectFromPath");

t.assert(detectProjectFromPath(null) === null, "Null → null");
t.assert(detectProjectFromPath("") === null, "Empty → null");
t.assert(detectProjectFromPath("/home/user/my-project") === "my-project", "Linux: last folder");
t.assert(detectProjectFromPath("C:\\Users\\dev\\my-project") === "my-project", "Windows: last folder");
t.assert(detectProjectFromPath("/repos/bi-analytics-dashboard") === "bi-analytics-dashboard", "bi-* project priority");
t.assert(detectProjectFromPath("/repos/bi-data/src/main") === "bi-data", "bi-* matched mid-path");
t.assert(detectProjectFromPath("/repos/spark-engine") === "spark-engine", "*-engine project");

// ─── Summary ─────────────────────────────────────────────────────────────────

// ─── noteSlugFromPath ─────────────────────────────────────────────────────────

t.section("noteSlugFromPath");

t.assert(noteSlugFromPath("C:/brain/memory/notes/my-note.md", "C:/brain/memory/notes") === "my-note", "Root note: bare filename");
t.assert(noteSlugFromPath("C:/brain/memory/notes/docker/tips.md", "C:/brain/memory/notes") === "docker-tips", "Subfolder: folder-filename");
t.assert(noteSlugFromPath("C:/brain/memory/notes/docker/compose/multi.md", "C:/brain/memory/notes") === "docker-compose-multi", "Nested: all folders joined");
t.assert(noteSlugFromPath("/home/user/notes/git/rebase.md", "/home/user/notes") === "git-rebase", "Linux paths");

// ─── isHumanNote ──────────────────────────────────────────────────────────────

t.section("isHumanNote");

t.assert(isHumanNote("memory/notes/my-note.md") === true, "Notes path detected");
t.assert(isHumanNote("memory/notes/docker/tips.md") === true, "Nested notes path detected");
t.assert(isHumanNote("memory/learnings/some-learning.md") === false, "Learnings path not human");
t.assert(isHumanNote("knowledge/general/test.md") === false, "Knowledge path not human");

export const results = t.summary();
