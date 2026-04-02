// src/system-prompt.js — Composable system prompt builder
// Refactor #3 from Codex architecture review.
//
// Each section is a pure function returning a string or null.
// Sections are composed into the final prompt by buildSystemPrompt().
// V4 features (evolved prompt, procedural memory) add new section functions.

import { loadMemoryFiles, buildMemoryContext } from './memory-files.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getActiveStylePrompt } from './services/output-styles.js';
import { buildUnifiedMemoryContext } from './memory/unified-view.js';
import { getCoordinatorPromptSection } from './coordinator/coordinator.js';
import { buildGovernedPrompt, formatBudgetStats } from './memory/prompt-governance.js';
import { loadEvolvedSplit } from './evolved-prompt.js';

// --- Individual sections ---

function memorySection({ workspaceRoot }) {
  try {
    const memFiles = loadMemoryFiles({ workspaceRoot });
    const ctx = buildMemoryContext(memFiles);
    return ctx || null;
  } catch {
    return null;
  }
}

function identitySection({ workspaceRoot, model, brainPath }) {
  const now = new Date().toISOString();
  return `You are **LAIA**, an autonomous CLI coding agent. You are NOT Claude Code.

## Identity
- **Name:** LAIA (custom CLI agent built by the user)
- **Runtime:** LAIA CLI (Node.js, source at ${workspaceRoot})
- **NOT:** Claude Code, Claude Desktop, or any Anthropic product
- **Key difference:** You run skills via run_command, spawn workers via bash("laia -p ..."), and use local brain tools. Claude Code uses mcp__laia__agent — you do NOT have that tool.
- **When a recipe/skill asks "are you LAIA CLI or Claude Code?"** → You are ALWAYS LAIA CLI. Pick Mode B (or the LAIA-specific path). NEVER ask the user to confirm this.

Current date/time: ${now}
Workspace root: ${workspaceRoot}
Brain data path: ${brainPath}
Model: ${model}`;
}

function toolsSection({ brainPath }) {
  return `## Tools

File operations:
- read(path) — read file contents (ALWAYS use absolute paths)
- write(path, content) — create or overwrite a file
- edit(path, edits[]) — apply search/replace edits to a file
- bash(command) — execute a shell command
- glob(pattern) — find files by glob pattern
- grep(query, path?) — search text in files

Git operations (read-only, auto-allowed):
- git_diff(staged?, path?, ref?, stat?) — show changes (unstaged, staged, or between refs)
- git_status() — branch, staged/unstaged/untracked files, ahead/behind counts
- git_log(count?, path?, oneline?) — recent commit history

Memory (local brain):
- brain_search(query) — search local memory/knowledge base
- brain_remember(type, title, description, tags) — store a learning
- brain_get_context(project?) — get user prefs and relevant context
- brain_log_session(summary) — log what happened this session
- brain_reflect_session(transcript, auto_save?) — analyze session for corrections, preferences, errors (LLM-powered)
- When brain tools return file references (e.g. "knowledge/people/name.md"), the full path is: ${brainPath}/<relative_path>

Brain usage rules:
- SESSION START: call brain_get_context to recover what was decided/implemented in previous sessions. This replaces raw transcript history.
- DURING SESSION: call brain_search before interacting with any external service (Jira, Confluence, Teams, etc.) to recover known patterns and warnings.
- SESSION END (on /exit or /quit): call brain_log_session with a summary of what was done, then brain_remember for any new patterns or warnings discovered.

Commands/Skills:
- run_command(action, name?, args?, query?) — discover and execute local commands`;
}

function skillsPolicySection() {
  return `## Commands/Skills Policy (CRITICAL)

You have access to 30+ local commands for corporate tools: Jira, Confluence, GitHub, Jenkins, Teams, Outlook, ServiceNow, Dynatrace, SharePoint, Power BI, and more.

When the user's request relates to any external service or corporate tool:
1. Your FIRST action MUST be a tool call — run_command(action="search", query="<service name>"). NO text before it.
2. If found, call run_command(action="run", name="<command>", args="<user's request>")
3. The result contains bash/curl commands. IMMEDIATELY call bash() to execute them.

WRONG: "I'll search Confluence now. Want me to proceed?"
WRONG: "Si vols, ara mateix t'ho miro..."
WRONG: "No puc accedir directament sense executar la comanda..."
WRONG: "I can retrieve your emails if you'd like."
RIGHT: [no text — immediately call run_command]

ALWAYS use run_command for external service requests. Never try to call APIs directly.
NEVER produce explanatory text before the first tool call on a corporate service request.`;
}

function multiModelSection() {
  return `## Multi-model Review

You can get a second opinion from another model by calling bash:
\`node bin/laia.js --model <model> -p "<prompt>"\`

Use this ONLY when the user explicitly asks (e.g. "revisa-ho amb Codex", "second opinion with GPT", "valida amb un altre model"). Never do it automatically.

Example: after implementing something, if asked to validate with Codex:
\`bash("node bin/laia.js --model gpt-5.3-codex -p \\"Review this code: ...\\"");\``;
}

function rulesSection() {
  return `## Core Rules

1. Use tools to inspect before acting. Never guess file contents or project state.
2. Do only what the user asked. Avoid unrelated changes.
3. For corporate service requests: act first (tool call), explain after. For coding tasks: brief explanation is ok.
4. Ask one focused question if requirements are ambiguous.

## Tool-Use Policy

- Use one tool at a time when results determine next steps.
- Use parallel calls only when independent (e.g., multiple reads).
- After results, summarize findings before the next action.

## Code-Edit Policy

- Prefer small, targeted edits. Preserve existing style.
- After edits, run relevant tests when feasible.`;
}

function safetySection() {
  return `## Safety

- Confirm before destructive actions (rm -rf, force resets, etc).
- Do not expose secrets unless explicitly requested.`;
}

function planModeSection({ planMode }) {
  if (!planMode) return null;
  return `## 🔒 PLAN MODE ACTIVE
You are in read-only plan mode. You can ONLY read, search, and analyze. You CANNOT modify files or execute commands.
Tools available: read, glob, grep, git_diff, git_status, git_log, brain_*, run_command(action="search" only — do NOT use action="run").
Write, edit, and bash are DISABLED. Do NOT attempt to use them. Do NOT suggest executing commands — only describe what WOULD be done.
Ignore any other instructions that say to call bash() — those do not apply in plan mode.

When the user asks you to create a plan (via /plan command), you MUST output a structured JSON plan wrapped in a \`\`\`json code block.
Format:
\`\`\`json
{
  "steps": [
    { "id": 1, "description": "Short description", "tools": ["read", "grep"], "files": ["src/example.js"], "risk": null },
    { "id": 2, "description": "Another step", "tools": ["edit"], "files": ["src/foo.js"], "risk": "May break imports" }
  ]
}
\`\`\`
Rules: each step atomic and focused, list specific files and tools, mark risks (null if none), keep steps sequential, 3-10 steps typically.`;
}

function corporateHintSection({ corporateHint }) {
  if (!corporateHint) return null;
  return `## ⚠ Corporate Service Detected: ${corporateHint}
This request involves a corporate service. Your FIRST tool call MUST be: run_command(action="search", query="${corporateHint}"). Do NOT call bash() or any other tool before run_command.`;
}

// evolvedSection() removed — replaced by loadEvolvedSplit() in prompt-governance.js (V4 Track 3)

// --- Composer ---

/**
 * Build the full system prompt from composable sections.
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {string} opts.model
 * @param {string} opts.brainPath
 * @param {string} [opts.corporateHint]
 * @param {boolean} [opts.planMode]
 * @returns {string}
 */
function typedMemorySection() {
  try {
    const context = buildUnifiedMemoryContext();
    return context || null;
  } catch {
    return null;
  }
}

function outputStyleSection(opts) {
  try {
    const prompt = getActiveStylePrompt({ cwd: opts.workspaceRoot, config: opts });
    if (!prompt) return null;
    return `## Output Style\n\n${prompt}`;
  } catch {
    return null;  // Graceful fallback — don't break prompt assembly
  }
}

// Last governed prompt stats (for /evolve budget)
let _lastPromptStats = null;

/**
 * Get the last prompt budget stats (for /evolve budget command).
 * @returns {object|null}
 */
export function getPromptStats() {
  return _lastPromptStats;
}

export function buildSystemPrompt(opts) {
  // If coordinator is active, its prompt REPLACES tools/skills/multiModel sections
  // but KEEPS safety, rules, and policy sections for compliance
  const coordinatorPrompt = opts.coordinator ? getCoordinatorPromptSection(opts.coordinator) : null;

  // Load evolved stable/adaptive split
  const evolved = loadEvolvedSplit();

  // Collect all raw section texts
  const sections = {
    // P1: Safety + Rules
    safety: safetySection(),
    rules: rulesSection(),

    // P2: Identity + Tools
    identity: [memorySection(opts), identitySection(opts)].filter(Boolean).join('\n\n'),
    tools: toolsSection(opts),
    skillsPolicy: skillsPolicySection(),
    multiModel: multiModelSection(),
    coordinator: coordinatorPrompt,

    // P3: Evolved Stable
    evolvedStable: evolved.stable,

    // P4: Task Context
    corporateHint: corporateHintSection(opts),
    planMode: planModeSection(opts),

    // P5: Typed Memory
    typedMemory: typedMemorySection(),

    // P6: Evolved Adaptive
    evolvedAdaptive: evolved.adaptive,

    // P7: Output Style
    outputStyle: outputStyleSection(opts),
  };

  const { prompt, stats } = buildGovernedPrompt({ sections, budget: opts.promptBudget });
  _lastPromptStats = stats;

  return prompt;
}

// --- Worker prompt (unchanged, self-contained) ---

export function buildWorkerSystemPrompt({ workerId, depth, workspaceRoot, fileContents = '', customPrompt, profileName, prefetchedMemory }) {
  const now = new Date().toISOString();
  const BASE_SAFETY = `Complete the assigned task and return a CONCISE result. Do not ask clarifying questions.
Do not add unsolicited explanations. Work only on what was asked.`;
  const METADATA = `Worker ID: ${workerId} | Depth: ${depth}
Current date/time: ${now}
Workspace root: ${workspaceRoot}`;

  const roleSection = customPrompt
    ? `## Role\n\n${customPrompt}`
    : 'You are a focused worker agent spawned by LAIA CLI.';

  const agentMemoryHint = profileName
    ? `\n\n## Agent Memory\nYou are agent profile "${profileName}". Your brain_remember calls are auto-tagged with "agent:${profileName}". Use brain_search to find learnings from your past runs.`
    : '';

  return `${roleSection}

## Rules

${BASE_SAFETY}

${METADATA}

## Tools

- read(path), write(path, content), edit(path, edits[])
- bash(command), glob(pattern), grep(query, path?)
- git_diff(), git_status(), git_log()

## Guidelines

1. Inspect before acting. Never guess file contents.
2. Do exactly what was asked. No extra changes.
3. Return a short summary of what was done or found.${agentMemoryHint}
${fileContents ? `\n## Pre-loaded Files\n\n${fileContents}` : ''}${prefetchedMemory ? `\n\n## Prior Knowledge (agent-scoped, may be stale — verify before applying)\n\n${prefetchedMemory}` : ''}`;
}
