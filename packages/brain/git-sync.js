/**
 * Git sync helpers for LAIA Brain.
 * Pull/push orchestration, smart JSON merge strategies for conflict resolution.
 */

import * as path from "path";
import { execFileSync } from "child_process";
import { BRAIN_PATH, GIT_SYNC_ENABLED } from "./config.js";
import { writeFile, invalidateAllContentCaches } from "./file-io.js";

// ─── Git execution ────────────────────────────────────────────────────────────

export function gitExec(args, timeoutMs = 30000) {
  if (typeof args === "string") throw new Error("gitExec requires an array of args, not a string");
  try {
    const stdout = execFileSync("git", args, {
      cwd: BRAIN_PATH,
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    return {
      ok: false,
      stdout: (e.stdout || "").trim(),
      stderr: (e.stderr || e.message || "").trim()
    };
  }
}

export function gitIsRepo() {
  if (!GIT_SYNC_ENABLED) return { isRepo: false, hasRemote: false, reason: "GIT_SYNC_ENABLED=false" };
  const rev = gitExec(["rev-parse", "--is-inside-work-tree"]);
  if (!rev.ok) return { isRepo: false, hasRemote: false, reason: "not a git repo" };
  const remote = gitExec(["remote"]);
  return { isRepo: true, hasRemote: remote.ok && remote.stdout.length > 0, reason: null };
}

function getGitVersion(file, stage) {
  const r = gitExec(["show", `:${stage}:${file}`]);
  return r.ok ? r.stdout : null;
}

// ─── Merge strategies per JSON file type ──────────────────────────────────────

function mergeMetrics(base, ours, theirs) {
  const result = { ...ours };
  for (const key of Object.keys(theirs)) {
    if (!(key in result)) { result[key] = theirs[key]; continue; }
    if (typeof theirs[key] === "number" && typeof result[key] === "number") {
      const baseVal = (base && typeof base[key] === "number") ? base[key] : 0;
      result[key] = baseVal + (result[key] - baseVal) + (theirs[key] - baseVal);
    } else if (typeof theirs[key] === "string" && key.includes("last_")) {
      result[key] = result[key] > theirs[key] ? result[key] : theirs[key];
    } else if (typeof theirs[key] === "object" && !Array.isArray(theirs[key])) {
      result[key] = mergeMetrics(base?.[key], result[key], theirs[key]);
    }
  }
  return result;
}

function mergeRelations(base, ours, theirs) {
  const result = JSON.parse(JSON.stringify(ours));
  if (!result.concepts) result.concepts = {};
  const theirsConcepts = theirs?.concepts || {};
  for (const [name, data] of Object.entries(theirsConcepts)) {
    if (!result.concepts[name]) {
      result.concepts[name] = data;
    } else {
      const existing = result.concepts[name];
      existing.related_to = [...new Set([...(existing.related_to || []), ...(data.related_to || [])])];
      existing.children = [...new Set([...(existing.children || []), ...(data.children || [])])];
      if (data.parent && !existing.parent) existing.parent = data.parent;
    }
  }
  return result;
}

function mergeLearningsMeta(base, ours, theirs) {
  const result = JSON.parse(JSON.stringify(ours));
  if (!result.learnings) result.learnings = {};
  const theirsLearnings = theirs?.learnings || {};
  const baseLearnings = base?.learnings || {};
  for (const [slug, data] of Object.entries(theirsLearnings)) {
    if (!result.learnings[slug]) {
      result.learnings[slug] = data;
    } else {
      const r = result.learnings[slug];
      const b = baseLearnings[slug] || {};
      const baseHits = b.hit_count || 0;
      r.hit_count = baseHits + ((r.hit_count || 0) - baseHits) + ((data.hit_count || 0) - baseHits);
      if (data.last_accessed && (!r.last_accessed || data.last_accessed > r.last_accessed)) {
        r.last_accessed = data.last_accessed;
      }
      if (data.created_date && (!r.created_date || data.created_date < r.created_date)) {
        r.created_date = data.created_date;
      }
      if (r.stale && !data.stale) r.stale = false;
      if (r.archived && !data.archived) r.archived = false;
    }
  }
  return result;
}

function mergeIndex(base, ours, theirs) {
  const result = JSON.parse(JSON.stringify(ours));
  const oursSessions = result.sessions || [];
  const theirsSessions = theirs?.sessions || [];
  const seenFiles = new Set(oursSessions.map(s => s.file));
  for (const s of theirsSessions) {
    if (!seenFiles.has(s.file)) {
      oursSessions.push(s);
      seenFiles.add(s.file);
    }
  }
  result.sessions = oursSessions.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (theirs?.updated && (!result.updated || theirs.updated > result.updated)) {
    result.updated = theirs.updated;
  }
  if (theirs?.inline_tags && theirs.inline_tags > (result.inline_tags || 0)) {
    result.inline_tags = theirs.inline_tags;
  }
  if (theirs?.consolidation?.last_run) {
    if (!result.consolidation || theirs.consolidation.last_run > (result.consolidation.last_run || "")) {
      result.consolidation = theirs.consolidation;
    }
  }
  return result;
}

/**
 * Validate that a merged JSON result conforms to expected schema.
 * Returns false if the structure is invalid (prevents corrupt data from being written).
 */
export function validateMergedJson(basename, obj) {
  if (obj === null || obj === undefined || typeof obj !== "object") return false;
  if (basename === "metrics.json") {
    return typeof obj === "object" && !Array.isArray(obj);
  }
  if (basename === "relations.json") {
    return typeof obj.concepts === "object" && obj.concepts !== null && !Array.isArray(obj.concepts);
  }
  if (basename === "learnings-meta.json") {
    return typeof obj.learnings === "object" && obj.learnings !== null && !Array.isArray(obj.learnings);
  }
  if (basename === "index.json") {
    return Array.isArray(obj.sessions);
  }
  return true; // unknown files: accept any object
}

export function mergeJsonFile(file, base, ours, theirs) {
  try {
    const bObj = base ? JSON.parse(base) : null;
    const oObj = JSON.parse(ours);
    const tObj = JSON.parse(theirs);
    const basename = path.basename(file);
    let result;
    if (basename === "metrics.json") result = mergeMetrics(bObj, oObj, tObj);
    else if (basename === "relations.json") result = mergeRelations(bObj, oObj, tObj);
    else if (basename === "learnings-meta.json") result = mergeLearningsMeta(bObj, oObj, tObj);
    else if (basename === "index.json") result = mergeIndex(bObj, oObj, tObj);
    else result = oObj;

    if (!validateMergedJson(basename, result)) {
      console.error(`Merge schema validation failed for ${basename}`);
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

function resolveJsonConflicts(files) {
  const resolved = [];
  const failed = [];
  for (const file of files) {
    if (file.endsWith(".json")) {
      const base = getGitVersion(file, 1);
      const ours = getGitVersion(file, 2);
      const theirs = getGitVersion(file, 3);
      if (!ours || !theirs) { failed.push(file); continue; }
      const merged = mergeJsonFile(file, base, ours, theirs);
      if (merged) {
        writeFile(file, JSON.stringify(merged, null, 2));
        gitExec(["add", file]);
        resolved.push(file);
      } else {
        failed.push(file);
      }
    } else if (file.endsWith(".md")) {
      gitExec(["checkout", "--theirs", file]);
      gitExec(["add", file]);
      resolved.push(file);
    } else {
      failed.push(file);
    }
  }
  return { resolved, failed };
}

// ─── Orchestrators ────────────────────────────────────────────────────────────

export function performGitPull() {
  const repo = gitIsRepo();
  if (!repo.isRepo) return { pulled: false, syncReport: null };
  if (!repo.hasRemote) return { pulled: false, syncReport: null };

  const stashResult = gitExec(["stash", "--include-untracked"]);
  const didStash = stashResult.ok && !stashResult.stdout.includes("No local changes");

  const pull = gitExec(["pull", "--no-rebase"], 60000);

  if (pull.ok) {
    if (didStash) {
      const popResult = gitExec(["stash", "pop"]);
      if (!popResult.ok) console.error(`Git Sync: stash pop failed after pull: ${popResult.stderr.slice(0, 100)}`);
    }
    const upToDate = pull.stdout.includes("Already up to date") || pull.stdout.includes("Already up-to-date");
    if (!upToDate) invalidateAllContentCaches();
    return {
      pulled: !upToDate,
      syncReport: upToDate ? "Git Sync: already up to date" : "Git Sync: pulled latest changes"
    };
  }

  if (pull.stderr.includes("CONFLICT") || pull.stderr.includes("Merge conflict")) {
    const lsConflicts = gitExec(["diff", "--name-only", "--diff-filter=U"]);
    const conflictFiles = lsConflicts.ok ? lsConflicts.stdout.split("\n").filter(Boolean) : [];

    if (conflictFiles.length > 0) {
      const { resolved, failed } = resolveJsonConflicts(conflictFiles);

      if (failed.length === 0) {
        const commitResult = gitExec(["commit", "-m", "Auto-merge: resolved conflicts (git-sync)"]);
        if (!commitResult.ok) {
          const abortResult = gitExec(["merge", "--abort"]);
          if (didStash && abortResult.ok) gitExec(["stash", "pop"]);
          return {
            pulled: false,
            syncReport: `Git Sync: auto-merge commit failed (${commitResult.stderr.slice(0, 80)})`
          };
        }
        if (didStash) {
          const popResult = gitExec(["stash", "pop"]);
          if (!popResult.ok) console.error(`Git Sync: stash pop failed after merge: ${popResult.stderr.slice(0, 100)}`);
        }
        return {
          pulled: true,
          syncReport: `Git Sync: pulled with auto-merge (resolved: ${resolved.join(", ")})`
        };
      } else {
        const abortResult = gitExec(["merge", "--abort"]);
        if (didStash && abortResult.ok) gitExec(["stash", "pop"]);
        return {
          pulled: false,
          syncReport: `Git Sync: merge aborted — unresolvable conflicts: ${failed.join(", ")}`
        };
      }
    }
  }

  if (didStash) {
    const popResult = gitExec(["stash", "pop"]);
    if (!popResult.ok) console.error(`Git Sync: stash pop failed: ${popResult.stderr.slice(0, 100)}`);
  }
  const reason = pull.stderr.includes("Could not resolve host") || pull.stderr.includes("unable to access")
    ? "network unavailable"
    : pull.stderr.slice(0, 100);
  return { pulled: false, syncReport: `Git Sync: pull failed (${reason})` };
}

export function performGitPush(msg) {
  const repo = gitIsRepo();
  if (!repo.isRepo) return { committed: false, pushed: false, syncReport: null };

  gitExec(["add", "-A"]);

  const status = gitExec(["status", "--porcelain"]);
  if (!status.ok || status.stdout.length === 0) {
    return { committed: false, pushed: false, syncReport: null };
  }

  const commitMsg = msg || `Brain sync: ${new Date().toISOString().split("T")[0]}`;
  const commit = gitExec(["commit", "-m", commitMsg]);
  if (!commit.ok) {
    return { committed: false, pushed: false, syncReport: `Git Sync: commit failed` };
  }

  if (!repo.hasRemote) {
    return { committed: true, pushed: false, syncReport: "Git Sync: committed (no remote)" };
  }

  const push = gitExec(["push"], 60000);
  if (push.ok) {
    return { committed: true, pushed: true, syncReport: "Git Sync: committed and pushed" };
  }

  const pullResult = performGitPull();
  if (pullResult.pulled) {
    const retryPush = gitExec(["push"], 60000);
    if (retryPush.ok) {
      return { committed: true, pushed: true, syncReport: "Git Sync: committed, pulled, and pushed" };
    }
  }

  return {
    committed: true,
    pushed: false,
    syncReport: `Git Sync: committed but push failed (${push.stderr.slice(0, 80)})`
  };
}
