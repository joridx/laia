// src/phase3/bundled-skills.js — Bundled skills (shipped with LAIA)
// Inspired by Claude Code's src/skills/bundled/
// These are registered at startup and available as slash commands.

// ─── /batch — Parallel work orchestration ────────────────────────────────────

const BATCH_PROMPT = `# Batch: Parallel Work Orchestration

You are orchestrating a large, parallelizable change across this codebase.

## User Instruction

$ARGUMENTS

## Phase 1: Research and Plan

1. **Understand the scope.** Launch research workers (read-only) to investigate what this instruction touches. Find all files, patterns, and call sites.

2. **Decompose into independent units.** Break the work into 5–20 self-contained units. Each unit must:
   - Be independently implementable (no shared state with siblings)
   - Be mergeable on its own
   - Be roughly uniform in size

   Scale the count to the actual work: few files → ~5; hundreds → ~20.

3. **Write the plan.** Present:
   - Summary of findings
   - Numbered list of work units with title, files, and description
   - Worker instructions template

4. **Get user approval** before proceeding.

## Phase 2: Spawn Workers

After plan approval, spawn one background agent per work unit. All agents run in parallel.

For each agent, the prompt must be fully self-contained:
- The overall goal (user's instruction)
- This unit's specific task (files, change description)
- Codebase conventions discovered during research
- Instructions: implement → run tests → commit

## Phase 3: Track Progress

After launching, render a status table:

| # | Unit | Status | Notes |
|---|------|--------|-------|
| 1 | <title> | running | — |

As workers complete, update the table. When all done, render final summary.
`;

// ─── /simplify — Code review and cleanup ─────────────────────────────────────

const SIMPLIFY_PROMPT = `# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

Run \`git diff\` (or \`git diff HEAD\`) to see what changed. If no git changes, review the most recently modified files.

## Phase 2: Launch Three Review Agents in Parallel

Launch all three concurrently. Pass each agent the full diff.

### Agent 1: Code Reuse Review
- Search for existing utilities that could replace newly written code
- Flag any new function that duplicates existing functionality
- Flag inline logic that could use an existing utility

### Agent 2: Code Quality Review
- Redundant state, parameter sprawl, copy-paste patterns
- Leaky abstractions, stringly-typed code
- Unnecessary comments (keep only non-obvious WHY)

### Agent 3: Efficiency Review
- Unnecessary work, missed concurrency, hot-path bloat
- Memory: unbounded data structures, missing cleanup
- Overly broad operations (reading entire files when only a portion needed)

## Phase 3: Fix Issues

Aggregate findings from all three agents. Fix each issue directly.
When done, summarize what was fixed (or confirm code was clean).
`;

// ─── /verify — Verify recent changes work ────────────────────────────────────

const VERIFY_PROMPT = `# Verify: Check Recent Changes

Verify that recent code changes work correctly.

## Steps

1. **Identify changes**: Run \`git diff HEAD\` to see what changed.

2. **Run tests**: Find and run the project's test suite:
   - Check package.json scripts (test, test:unit, test:e2e)
   - Check Makefile targets
   - Common commands: npm test, bun test, pytest, go test, cargo test

3. **Check types**: Run type checker if available (tsc --noEmit, mypy, etc.)

4. **Verify behavior**: If tests pass, try a quick smoke test:
   - Build the project if applicable
   - Run a representative command or start the dev server briefly

5. **Report**: Summarize:
   - ✅ Tests passing (X/Y)
   - ✅/❌ Type check
   - ✅/❌ Build
   - Any issues found

If you find issues, fix them and re-verify.
`;

// ─── /init — Generate LAIA.md for a project ──────────────────────────────────

const INIT_PROMPT = `# Initialize LAIA.md

Generate a LAIA.md file for this project based on codebase analysis.

## Steps

1. **Analyze the project**:
   - Read package.json, Cargo.toml, pyproject.toml, go.mod, etc.
   - Check for README.md, CONTRIBUTING.md
   - Identify language, framework, build system, test runner
   - Look at directory structure
   - Check for existing CI/CD config (.github/workflows, Jenkinsfile, etc.)

2. **Check for existing LAIA.md**:
   - If ./LAIA.md or ./.laia/LAIA.md already exists, show its current content
   - Ask the user if they want to overwrite, merge, or cancel
   - If overwriting, create a backup at LAIA.md.bak first

3. **Generate LAIA.md** with sections:
   - Project description (1-2 lines)
   - Tech stack
   - Build commands (build, test, lint, format)
   - Project structure overview
   - Coding conventions (from linter config, existing code style)
   - Any special instructions for the AI agent

4. **Write to ./LAIA.md** (or ./.laia/LAIA.md if .laia/ exists)

5. **Ask user** if they want to customize anything.
`;

// ─── /skillify — Capture session as a skill ──────────────────────────────────
// NOTE: skillify uses a dynamic prompt built at invocation time via
// src/skills/skillify.js, which injects session messages and user description.
// The static SKILLIFY_PROMPT below is the FALLBACK when no session context
// is available (e.g. fresh session with 0 turns).

const SKILLIFY_PROMPT = `# Skillify: Capture a Workflow as a Reusable Skill

You are creating a new reusable LAIA skill.

Since there is no session context yet, interview the user to understand:
1. What process/workflow they want to automate
2. What the inputs and steps are
3. What the success criteria are
4. Where to save it (personal ~/.laia/skills/ or project laia-skills/)

Then generate a SKILL.md with frontmatter and write it to disk.

Use this format:

\`\`\`markdown
---
name: <kebab-case-name>
description: <one-line description>
schema: 1
invocation: user
context: main
arguments: true
argument-hint: "<what to pass>"
allowed-tools: [<tools needed>]
intent-keywords: [<keywords for auto-invoke>]
---

# <Skill Name>

## Goal
<What this skill achieves and when to use it>

## Steps

### 1. <Step Name>
<Detailed instructions>
**Success:** <How to verify this step succeeded>

### 2. <Step Name>
...

## Notes
- <Edge cases, warnings, preferences>
\`\`\`

After writing, confirm and remind the user to invoke with \`/<name>\`.
`;

// ─── Registration ────────────────────────────────────────────────────────────

export const BUNDLED_SKILLS = [
  {
    name: 'batch',
    description: 'Orchestrate parallel work across the codebase (5-20 workers)',
    prompt: BATCH_PROMPT,
    requiresArgs: true,
    argHint: '<instruction describing the batch change>',
  },
  {
    name: 'simplify',
    description: 'Review changed code for reuse, quality, and efficiency, then fix issues',
    prompt: SIMPLIFY_PROMPT,
    requiresArgs: false,
    argHint: '[additional focus area]',
  },
  {
    name: 'verify',
    description: 'Verify recent code changes work correctly (tests, types, build)',
    prompt: VERIFY_PROMPT,
    requiresArgs: false,
    argHint: '[specific area to verify]',
  },
  {
    name: 'init',
    description: 'Generate LAIA.md for this project based on codebase analysis',
    prompt: INIT_PROMPT,
    requiresArgs: false,
    argHint: '',
  },
  {
    name: 'skillify',
    description: "Capture this session's repeatable process into a SKILL.md",
    prompt: SKILLIFY_PROMPT,
    requiresArgs: false,
    argHint: '[description of process to capture]',
  },
];

/**
 * Get a bundled skill by name.
 */
export function getBundledSkill(name) {
  return BUNDLED_SKILLS.find(s => s.name === name) || null;
}

/**
 * Expand a bundled skill with arguments.
 */
export function expandBundledSkill(skill, args = '') {
  let prompt = skill.prompt;
  if (args) {
    const trimmed = args.slice(0, 10_000).trim(); // Guard rail: max 10KB args
    prompt = prompt.replaceAll('$ARGUMENTS', trimmed);
  } else {
    prompt = prompt.replaceAll('$ARGUMENTS', '(no specific instruction provided)');
  }
  return prompt;
}
