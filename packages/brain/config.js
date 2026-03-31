/**
 * Shared configuration constants for LAIA Brain.
 * BRAIN_PATH resolution, feature flags, directory constants.
 */

import * as fs from "fs";
import * as path from "path";
import { normPath } from "./utils.js";

export const BRAIN_PATH = (() => {
  const home = process.env.HOME || process.env.USERPROFILE;

  // ─── 1. Explicit env var: trust it unconditionally ──────────────────────────
  if (process.env.LAIA_BRAIN_PATH) {
    const p = normPath(process.env.LAIA_BRAIN_PATH);

    // Safety: reject if it looks like the code repo (has mcp-server/ dir)
    if (fs.existsSync(path.join(p, "mcp-server"))) {
      console.error(`FATAL: LAIA_BRAIN_PATH="${p}" points to the CODE repo (has mcp-server/), not the DATA repo.`);
      console.error(`Fix: set LAIA_BRAIN_PATH to your laia-data directory.`);
      process.exit(1);
    }

    // Auto-create index.json if missing (first run or fresh clone)
    const indexPath = path.join(p, "index.json");
    if (!fs.existsSync(indexPath)) {
      console.error(`   Path: ${p} (index.json missing, creating)`);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(indexPath, JSON.stringify({ version: "2.0", sessions: [] }, null, 2));
    }

    return p;
  }

  // ─── 2. Auto-detect from home directory ─────────────────────────────────────
  if (home) {
    const p = normPath(path.join(home, "laia-data"));
    if (fs.existsSync(path.join(p, "index.json"))) {
      return p;
    }
  }

  // ─── 3. No valid path found — fatal error ──────────────────────────────────
  console.error("FATAL: LAIA_BRAIN_PATH env var not set and no auto-detected brain data found.");
  console.error("Set LAIA_BRAIN_PATH to your laia-data directory in the MCP server config.");
  process.exit(1);
})();

export const GIT_SYNC_ENABLED = (process.env.BRAIN_GIT_SYNC || "true").toLowerCase() !== "false";

export const LEARNINGS_DIR = "memory/learnings";
export const NOTES_DIR = "memory/notes";

export const TODOS_FILE = "memory/todos.json";

export const TAVILY_API_KEY = process.env.TAVILY_API_KEY || null;
