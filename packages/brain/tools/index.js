/**
 * Tool registry — imports all tool modules and registers them with the MCP server.
 */

import * as brainGetContext from "./brain-get-context.js";
import * as brainSearch from "./brain-search.js";
import * as brainGetLearnings from "./brain-get-learnings.js";
import * as brainRemember from "./brain-remember.js";
import * as brainLogSession from "./brain-log-session.js";
import * as brainCheckAction from "./brain-check-action.js";
import * as brainUpdateProject from "./brain-update-project.js";
import * as brainIngestConfluence from "./brain-ingest-confluence.js";
import * as brainTodo from "./brain-todo.js";
import * as brainHealth from "./brain-health.js";
import * as brainDistill from "./brain-distill.js";
import * as brainWebSearch from "./brain-web-search.js";
import * as brainIndexNotes from "./brain-index-notes.js";
import * as brainFeedback from "./brain-feedback.js";
import * as brainReflectSession from "./brain-reflect-session.js";
import * as brainCompileEvolved from "./brain-compile-evolved.js";

/**
 * All tool modules — registered in order matching original index.js.
 */
export const allTools = [
  brainGetContext,
  brainSearch,
  brainGetLearnings,
  brainRemember,
  brainLogSession,
  brainCheckAction,
  brainUpdateProject,
  brainIngestConfluence,
  brainTodo,
  brainHealth,
  brainDistill,
  brainWebSearch,
  brainIndexNotes,
  brainFeedback,
  brainReflectSession,
  brainCompileEvolved,
];

/**
 * Register all tools with the MCP server via safeTool wrapper.
 * @param {Function} safeTool - The error-handling wrapper from index.js
 */
export function registerAllTools(safeTool) {
  for (const tool of allTools) {
    safeTool(tool.name, tool.description, tool.schema, tool.handler);
  }
}
