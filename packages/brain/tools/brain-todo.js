/**
 * Tool: brain_todo
 * Manage TODOs: add, list, or update tasks across sessions.
 */

import { z } from "zod";

import { readTodos, writeTodos } from "../todos.js";
import { performGitPush } from "../git-sync.js";
import { sanitizeTag } from "../utils.js";
import { zCoercedArray } from "./shared.js";

export const name = "brain_todo";
export const description = "Manage TODOs: add, list, or update tasks across sessions.";
export const schema = {
  action: z.enum(["add", "list", "update"]).describe("Action: add, list, or update"),
  // add params
  text: z.string().optional().describe("Task text (required for add)"),
  // update params
  id: z.string().optional().describe("TODO id (required for update)"),
  // shared params
  status: z.enum(["pending", "in_progress", "done", "cancelled", "expired", "all"]).optional().describe("Status (filter for list, new value for update)"),
  owner: z.enum(["user", "laia", "both", "all"]).optional().describe("Owner"),
  project: z.string().optional().describe("Project name"),
  tags: zCoercedArray(z.string()).optional().describe("Tags"),
  priority: z.enum(["high", "normal", "low"]).optional().describe("Priority"),
  due: z.string().optional().describe("Due date (YYYY-MM-DD)"),
  expires: z.string().optional().describe("Auto-expire date (YYYY-MM-DD). TODO auto-marks as 'expired' after this date. Use for transient reminders."),
  // list-only
  tag: z.string().optional().describe("Filter by single tag (list only)"),
  include_done: z.boolean().optional().describe("Include done/cancelled (list only)")
};

export async function handler({ action, text, id, status, owner, project, tags, priority, due, expires, tag, include_done }) {

  // ── AUTO-EXPIRE: mark expired TODOs before any action ──
  {
    const todos = readTodos();
    const today = new Date().toISOString().split("T")[0];
    let changed = false;
    for (const t of todos) {
      if (t.expires && t.status === "pending" && t.expires < today) {
        t.status = "expired";
        t.done_at = today;
        changed = true;
      }
    }
    if (changed) writeTodos(todos);
  }

  // ── ADD ──
  if (action === "add") {
    if (!text) return { content: [{ type: "text", text: "Error: text is required for add" }] };
    const todos = readTodos();
    const now = new Date().toISOString();
    const todoId = `todo-${Date.now()}`;
    const todo = {
      id: todoId, text,
      owner: owner || "both", project: project || null,
      tags: (tags || []).map(sanitizeTag), priority: priority || "normal",
      status: "pending", created: now.split("T")[0], due: due || null, expires: expires || null, done_at: null
    };
    todos.push(todo);
    writeTodos(todos);
    const syncResult = performGitPush(`Todo added: ${text.slice(0, 50)}`);
    let response = `✓ TODO added: ${todoId}\n- ${text}\n- Owner: ${todo.owner}, Priority: ${todo.priority}`;
    if (todo.project) response += `\n- Project: ${todo.project}`;
    if (todo.due) response += `\n- Due: ${todo.due}`;
    if (todo.expires) response += `\n- Expires: ${todo.expires}`;
    if (syncResult.syncReport) response += `\n${syncResult.syncReport}`;
    return { content: [{ type: "text", text: response }] };
  }

  // ── LIST ──
  if (action === "list") {
    const todos = readTodos();
    const filterStatus = status || "pending";
    const filterOwner = owner || "all";
    let filtered = todos;
    if (filterStatus !== "all") {
      filtered = filtered.filter(t => t.status === filterStatus);
    } else if (!include_done) {
      filtered = filtered.filter(t => t.status !== "done" && t.status !== "cancelled" && t.status !== "expired");
    }
    if (filterOwner !== "all") {
      filtered = filtered.filter(t => t.owner === filterOwner || t.owner === "both");
    }
    if (project) {
      const p = project.toLowerCase();
      filtered = filtered.filter(t => t.project && t.project.toLowerCase().includes(p));
    }
    if (tag) {
      const tg = sanitizeTag(tag);
      filtered = filtered.filter(todo => (todo.tags || []).includes(tg));
    }
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    filtered.sort((a, b) => {
      const pDiff = (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
      if (pDiff !== 0) return pDiff;
      return (a.created || "").localeCompare(b.created || "");
    });
    if (filtered.length === 0) {
      return { content: [{ type: "text", text: `No TODOs found (status=${filterStatus}, owner=${filterOwner}${project ? `, project=${project}` : ""}${tag ? `, tag=${tag}` : ""})` }] };
    }
    const byProject = new Map();
    for (const t of filtered) {
      const key = t.project || "(global)";
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(t);
    }
    let output = `# TODOs (${filtered.length})\n\n`;
    for (const [proj, items] of byProject) {
      output += `## ${proj}\n`;
      for (const t of items) {
        const icon = t.priority === "high" ? "🔴" : t.priority === "low" ? "⚪" : "🟡";
        const statusIcon = t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : t.status === "cancelled" ? "❌" : t.status === "expired" ? "⏰" : "⬜";
        output += `${statusIcon} ${icon} ${t.text}`;
        const meta = [];
        if (t.owner !== "both") meta.push(`@${t.owner}`);
        if (t.due) meta.push(`due:${t.due}`);
        if (t.expires) meta.push(`expires:${t.expires}`);
        if (t.tags?.length) meta.push(t.tags.map(tg => `#${tg}`).join(" "));
        if (meta.length) output += ` _(${meta.join(", ")})_`;
        output += `\n  id: ${t.id} | created: ${t.created}`;
        if (t.done_at) output += ` | done: ${t.done_at}`;
        output += "\n";
      }
      output += "\n";
    }
    return { content: [{ type: "text", text: output }] };
  }

  // ── UPDATE ──
  if (action === "update") {
    if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }] };
    const todos = readTodos();
    const idx = todos.findIndex(t => t.id === id);
    if (idx === -1) return { content: [{ type: "text", text: `Error: TODO not found: ${id}` }] };
    const todo = todos[idx];
    const changes = [];
    if (status !== undefined && status !== "all") {
      changes.push(`status: ${todo.status} → ${status}`);
      todo.status = status;
      if (status === "done" || status === "cancelled") todo.done_at = new Date().toISOString().split("T")[0];
    }
    if (text !== undefined) { todo.text = text; changes.push("text updated"); }
    if (priority !== undefined) { changes.push(`priority: ${todo.priority} → ${priority}`); todo.priority = priority; }
    if (owner !== undefined && owner !== "all") { changes.push(`owner: ${todo.owner} → ${owner}`); todo.owner = owner; }
    if (project !== undefined) { todo.project = project; changes.push(`project: ${project}`); }
    if (due !== undefined) { todo.due = due; changes.push(`due: ${due}`); }
    if (expires !== undefined) { todo.expires = expires; changes.push(`expires: ${expires}`); }
    if (tags !== undefined) { todo.tags = tags.map(sanitizeTag); changes.push(`tags: ${todo.tags.join(", ")}`); }
    if (changes.length === 0) return { content: [{ type: "text", text: `No changes specified for ${id}` }] };
    todos[idx] = todo;
    writeTodos(todos);
    const syncResult = performGitPush(`Todo updated: ${id}`);
    let response = `✓ TODO updated: ${id}\n- ${changes.join("\n- ")}`;
    if (syncResult.syncReport) response += `\n${syncResult.syncReport}`;
    return { content: [{ type: "text", text: response }] };
  }

  return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
}
