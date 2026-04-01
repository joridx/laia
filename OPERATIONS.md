# LAIA — Operations Manual

> **LAIA** (Local AI Agent) — CLI coding agent with self-evolving memory.
> Version 2.0 · Node.js 24+ · Last updated: 2026-04-01

---

## Table of Contents

1. [Installation & Setup](#installation--setup)
2. [Running LAIA](#running-laia)
3. [CLI Options](#cli-options)
4. [Slash Commands Reference](#slash-commands-reference)
5. [LLM Tools (Agent Capabilities)](#llm-tools-agent-capabilities)
6. [Model Routing](#model-routing)
7. [Permission System](#permission-system)
8. [Memory & Brain](#memory--brain)
9. [LAIA.md Hierarchy](#laiamd-hierarchy)
10. [Sessions](#sessions)
11. [Skills & Custom Commands](#skills--custom-commands)
12. [Agent Profiles & Swarm](#agent-profiles--swarm)
13. [Output Styles](#output-styles)
14. [Tips System](#tips-system)
15. [Git Integration](#git-integration)
16. [MCP Server Mode](#mcp-server-mode)
17. [Environment Variables](#environment-variables)
18. [File Structure](#file-structure)
19. [Troubleshooting](#troubleshooting)

---

## Installation & Setup

```bash
# Clone
git clone https://github.com/joridx/laia.git
cd laia
npm install

# Link globally (optional)
npm link
# or:
ln -s $(pwd)/bin/laia.js ~/.local/bin/laia

# Verify
laia --version
```

### Requirements

| Requirement | Notes |
|-------------|-------|
| **Node.js 24+** | ESM modules required |
| **GitHub Copilot Business** | Default LLM provider (via Copilot API) |
| **gh CLI** | Optional — needed for `/review` command |
| **git** | Optional — needed for `/commit`, auto-commit, git tools |
| AWS Bedrock / Ollama | Alternative providers (via `--genai`) |

---

## Running LAIA

```bash
# Interactive REPL (default)
laia

# One-shot mode (execute and exit)
laia -p "explain this codebase"
laia "explain this codebase"          # positional alias

# One-shot with JSON output (for piping)
laia -p "list all TODO items" --json

# Override model
laia -m gpt-5.3-codex -p "review this code"

# Read-only plan mode
laia --plan

# With specific reasoning effort
laia --effort max -p "architect a new auth system"

# Fork from a saved session
laia --fork my-session

# As MCP server (expose agent tool via stdio)
laia --mcp
```

---

## CLI Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--prompt <text>` | `-p` | One-shot prompt | _(interactive)_ |
| `--model <id>` | `-m` | Override model | `claude-opus-4.6` |
| `--json` | | JSON output (one-shot) | `false` |
| `--swarm` | | Enable swarm mode (parallel agents) | `true` |
| `--no-swarm` | | Disable swarm mode | |
| `--mcp` | | Run as MCP server over stdio | `false` |
| `--mcp-stdout-policy <mode>` | | `strict` or `redirect` | `strict` |
| `--auto-commit` | | Git auto-commit after each turn | `false` |
| `--plan` | | Read-only mode (no write/edit/bash) | `false` |
| `--effort <level>` | | Reasoning effort: `low`, `medium`, `high`, `max` | _(none)_ |
| `--fork <name\|id>` | | Fork a saved session | |
| `--genai <agent>` | | Use GenAI Lab backend: `sonnet`, `claude`, `gpt-5`, `o3`, `o4-mini` | |
| `--verbose` | | Verbose logging | `false` |
| `--help` | `-h` | Show help | |
| `--version` | `-v` | Show version | |

---

## Slash Commands Reference

All commands start with `/` and can be typed in the REPL.

### 📦 Session

| Command | Description | Usage |
|---------|-------------|-------|
| `/save [name]` | Save current session | `/save my-feature` |
| `/load [name\|autosave]` | Restore a session | `/load my-feature` or `/load autosave` |
| `/sessions` | List all saved sessions | `/sessions` |
| `/fork [name]` | Fork current session (new ID, same history) | `/fork experiment` |
| `/clear` | Clear conversation history | `/clear` |
| `/compact` | Compact history (summarize to save context) | `/compact` |

### 🔧 Config

| Command | Description | Usage |
|---------|-------------|-------|
| `/model [id\|auto]` | Change model mid-session | `/model gpt-5.3-codex` or `/model auto` |
| `/effort <level>` | Set reasoning effort | `/effort low`, `/effort high`, `/effort max` |
| `/plan` | Enter read-only mode (no writes) | `/plan` |
| `/execute` | Back to normal mode (writes allowed) | `/execute` |
| `/tokens` | Show token usage & context stats | `/tokens` |
| `/style [name\|list\|off]` | Set/list output styles | `/style concise`, `/style list`, `/style off` |

### 🔀 Git

| Command | Description | Usage |
|---------|-------------|-------|
| `/commit` | Generate commit from staged/unstaged changes | `/commit` |
| `/review [PR#]` | Code review a Pull Request (requires `gh`) | `/review 42` or `/review` (list PRs) |
| `/autocommit` | Toggle git auto-commit after each turn | `/autocommit` |

### 📎 Files

| Command | Description | Usage |
|---------|-------------|-------|
| `/attach <path>` | Attach file to context (persists across turns) | `/attach src/main.js` |
| `/detach [path\|all]` | Detach file from context | `/detach src/main.js` or `/detach all` |
| `/attached` | List currently attached files | `/attached` |

### 🤖 Agents

| Command | Description | Usage |
|---------|-------------|-------|
| `/agents [show\|validate\|create]` | Manage agent profiles | `/agents show reviewer` |
| `/swarm` | Toggle swarm mode (parallel workers) | `/swarm` |
| `/coordinator [on\|off\|status]` | Toggle coordinator mode (4-phase orchestration) | `/coordinator on` |

### 🎯 Skills

| Command | Description | Usage |
|---------|-------------|-------|
| `/skills` | List all available skills | `/skills` |
| `/<skill-name> [args]` | Execute a skill by name | `/jira search "auth bug"` |

### ⚙️ System

| Command | Description | Usage |
|---------|-------------|-------|
| `/help` | Show all commands | `/help` |
| `/tip` | Show a random contextual tip | `/tip` |
| `/debug [issue]` | Diagnose session issues (reads logs) | `/debug brain not connecting` |
| `/undo` | Revert last turn's file changes | `/undo` |
| `/reflect [auto]` | Reflect on session (brain LLM analysis) | `/reflect` or `/reflect auto` |
| `/exit` | Exit LAIA (triggers brain session log) | `/exit` |
| `/quit` | Exit LAIA (alias) | `/quit` |

---

## LLM Tools (Agent Capabilities)

These are the tools the LLM can invoke during a turn. Users don't call these directly.

### Tier 1 — Auto-allowed (no confirmation)

| Tool | Description |
|------|-------------|
| `read(path)` | Read file contents with line numbers |
| `glob(pattern)` | Find files by glob pattern |
| `grep(query, path?)` | Search text/regex in files |
| `git_diff(...)` | Show git changes (unstaged, staged, between refs) |
| `git_status()` | Branch, staged/unstaged/untracked files |
| `git_log(...)` | Recent commit history |
| `brain_search(query)` | Search brain memory/knowledge |
| `brain_get_context(project?)` | Get user prefs and relevant context |
| `run_command(action, ...)` | Discover and execute local skills/commands |

### Tier 2 — Session-allowed (ask once, then remember)

| Tool | Description |
|------|-------------|
| `write(path, content)` | Create or overwrite a file |
| `edit(path, edits[])` | Apply search/replace edits to a file |
| `bash(command)` | Execute a shell command |
| `brain_remember(type, title, description, tags)` | Store a learning in brain |
| `agent(prompt, ...)` | Spawn a worker agent for a subtask |

### Tier 3 — Always confirm (reserved)

Reserved for future high-risk operations.

---

## Model Routing

LAIA includes automatic per-turn model routing when set to `/model auto`:

| Trigger | Model | Reason |
|---------|-------|--------|
| Corporate keywords (Jira, Confluence, Teams...) | `gpt-5.3-codex` | Best for corporate tool integration |
| Coding keywords (debug, fix, refactor...) | `claude-opus-4.6` | Best for code analysis |
| Images in input | `gpt-5.3-codex` | Vision support |
| Quick/simple queries | `gpt-5-mini` | Cost-effective |
| Default | Configured model | Fallback |

### Available Models

| Alias | Model ID |
|-------|----------|
| `codex` | `gpt-5.3-codex` |
| `claude` | `claude-opus-4.6` |
| `mini` | `gpt-5-mini` |

Change model: `/model claude`, `/model codex`, `/model auto`

---

## Permission System

Three-tier system protecting against unintended actions:

| Tier | Tools | Behavior |
|------|-------|----------|
| **Auto** | read, glob, grep, git_*, brain_search, brain_get_context, run_command | Always allowed, no prompt |
| **Session** | write, edit, bash, brain_remember, agent | Asks once per tool per session → `[y/a/N]` |
| **Confirm** | _(reserved)_ | Would ask every time |

When prompted: **y** = yes (this time), **a** = allow all (this tool, rest of session), **N** = deny.

In **plan mode** (`/plan` or `--plan`), write/edit/bash are blocked entirely.

---

## Memory & Brain

LAIA's brain is a local MCP server with SQLite + full-text search + embeddings.

### Brain Data Location

```
~/laia-data/
├── memory/
│   ├── learnings/          # Individual learning files (.md)
│   └── sessions/           # Session logs (.md)
├── knowledge/              # Knowledge base files
├── learnings-meta.json     # Learning metadata (vitality, access count)
├── metrics.json            # Quality tracking
└── relations.json          # Knowledge graph
```

### Brain Tools

| Tool | Description |
|------|-------------|
| `brain_search(query)` | Full-text + semantic search across learnings/knowledge |
| `brain_remember(type, title, description, tags)` | Store new learning (types: learning, pattern, warning, principle) |
| `brain_get_context(project?)` | Get relevant context for current project |
| `brain_log_session(summary)` | Log session summary (auto on /exit) |
| `brain_reflect_session(transcript, auto_save?)` | LLM-powered session analysis |

### Brain Lifecycle

1. **Session start** → `brain_get_context()` recovers prior decisions
2. **During session** → `brain_search()` before external service calls
3. **Session end** (`/exit`) → `brain_log_session()` + `brain_remember()` for new patterns

### Evolved Prompt

The brain auto-compiles learnings into prompt sections at `~/.laia/evolved/`:

```
~/.laia/evolved/
├── user-preferences.md      # User prefs extracted from learnings
├── task-patterns.md          # Common workflows and procedures
├── error-recovery.md         # Warnings and pitfalls
├── domain-knowledge.md       # Domain-specific knowledge
├── _stable.json              # Stable entries (manually confirmed, never expire)
└── _adaptive.json            # Adaptive entries (expire after 30 days)
```

---

## LAIA.md Hierarchy

Memory files loaded into the system prompt (lowest → highest priority):

| Level | Path | Notes |
|-------|------|-------|
| **User** | `~/.laia/LAIA.md` | Personal preferences, global rules |
| **Project** | `./LAIA.md` or `./.laia/LAIA.md` | Project-specific instructions |
| **Managed** | `~/.laia/LAIA-managed.md` | Corporate policy (immutable by agent) |

Limits: **50KB per file**, **100KB total**. Files are deduplicated by resolved path.

---

## Sessions

### Auto-save

LAIA auto-saves after each turn. Restore with `/load autosave`.

### Named Sessions

```
/save my-feature          # Save with name
/load my-feature          # Restore
/sessions                 # List all saved sessions
/fork my-feature          # Fork: new ID, same history
```

### Session Files

Saved to `~/.laia/sessions/` as JSON with full conversation history.

---

## Skills & Custom Commands

### Built-in Skills

Skills are loaded from `~/.laia/commands/*.md` (legacy) and `~/.laia/skills/*/SKILL.md` (V3).

View available skills: `/skills`

### Creating a Skill

Create `~/.laia/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Does something useful
schema: 1
invocation: user
arguments: true
argument-hint: "<query>"
allowed-tools: []
---

Your prompt template here. Use $ARGUMENTS for user input.
```

### Frontmatter Fields

| Field | Required | Description | Default |
|-------|----------|-------------|---------|
| `name` | ✅ | Skill name (used as `/name`) | |
| `description` | ✅ | Short description | |
| `schema` | | Schema version | `1` |
| `invocation` | | `user` or `auto` | `user` |
| `context` | | `main` or `isolated` | `main` |
| `arguments` | | Accept arguments? | `true` |
| `argument-hint` | | Hint for autocomplete | `""` |
| `allowed-tools` | | Restrict tools for this skill | `[]` (all) |

---

## Coordinator Mode

Coordinator mode transforms LAIA into a multi-agent orchestrator following a 4-phase workflow inspired by Claude Code's coordinator architecture.

### Activation

```
/coordinator on       # Activate
/coordinator off      # Deactivate
/coordinator status   # Show phase, workers, history
```

### The 4 Phases

| Phase | Who | What |
|-------|-----|------|
| **1. Research** | Parallel workers | Investigate codebase from multiple angles. Read-only. |
| **2. Synthesis** | Coordinator (LLM) | Read findings, formulate precise implementation specs |
| **3. Implementation** | Workers with specs | Make changes, run tests, commit |
| **4. Verification** | Fresh workers | Verify with fresh eyes, check edge cases |

### The Synthesis Rule

After research workers report back, the coordinator **must synthesize** before spawning implementation workers. This means:

- Read all findings
- Understand the full picture
- Include file paths, line numbers, exact specs in the worker prompt

**Bad:** `agent({ prompt: "Fix the bug we discussed" })` — worker has no context.
**Good:** `agent({ prompt: "Fix null pointer in src/auth.ts:42. Add null check before user.id." })`

### Worker Tracking

The coordinator automatically tracks:
- Each worker's status (running/completed/failed/cancelled)
- Phase transitions
- Worker results (capped at 5KB each, 100 workers max with FIFO eviction)

### What Changes in Coordinator Mode

| Aspect | Normal | Coordinator |
|--------|--------|-------------|
| System prompt | Tools + skills + rules | Coordinator prompt + rules + safety |
| Primary tool | All tools | Mostly `agent` (for delegation) |
| LLM role | Direct executor | Orchestrator |
| Worker results | Returned inline | Tracked + synthesized |

---

## Agent Profiles & Swarm

### Agent Profiles

Create YAML profiles at `~/.laia/agents/<name>.yml`:

```yaml
name: reviewer
description: Expert code reviewer
model: claude-opus-4.6
maxSteps: 5
allowedTools:
  - read
  - grep
  - glob
prompt: |
  You are an expert code reviewer. Focus on correctness,
  performance, and security.
```

### Commands

```
/agents                    # List all profiles
/agents show reviewer      # Show profile details
/agents validate           # Validate all profiles
/agents create my-agent    # Create from template
```

### Swarm Mode

Toggle with `/swarm`. When enabled, the `agent()` tool spawns parallel workers:

- Each worker gets its own context, tools, and optional profile
- Workers run in-process with configurable `allowedTools`
- Results aggregated by the main agent

---

## Output Styles

Control how LAIA formats responses by creating `.md` files.

### Location

| Path | Scope |
|------|-------|
| `~/.laia/output-styles/*.md` | User-global styles |
| `.laia/output-styles/*.md` | Project-specific (overrides user) |

### Creating a Style

Create `~/.laia/output-styles/concise.md`:

```markdown
---
name: concise
description: Short, direct responses without fluff
---
Be extremely concise. Use bullet points. No introductions or conclusions.
Skip pleasantries. Answer in the minimum words possible.
```

### Commands

```
/style list                # List available styles
/style concise             # Activate a style
/style off                 # Deactivate
```

### Bundled Styles

| Style | Description |
|-------|-------------|
| `concise` | Short, direct, bullet points |
| `detailed` | Thorough with examples and alternatives |

Active style is injected as an `## Output Style` section in the system prompt.

---

## Tips System

Contextual tips shown during spinner waits (after 3 seconds).

### 20 Bundled Tips

Tips cover: session management, tools, brain/memory, git, multi-model, debugging.

### Manual Tip

Type `/tip` to see a random tip anytime.

### Custom Tips

Add custom tips to `~/.laia/tips.json`:

```json
[
  { "id": "my-tip", "content": "💡 Remember to run tests before committing!" }
]
```

Custom tips are merged with bundled tips. Each tip is shown at most once per session before the pool resets.

---

## Git Integration

### Auto-commit

```bash
laia --auto-commit            # Enable from CLI
/autocommit                    # Toggle in REPL
```

When enabled, LAIA automatically commits file changes after each turn using `git commit --only` (isolated commit, no staged interference).

### /commit

Generates a commit message by analyzing:
- `git status` — current state
- `git diff HEAD` — all changes
- `git branch --show-current` — branch name
- `git log --oneline -10` — recent commit style

Then stages and commits via LLM-generated bash commands.

### /review

Reviews Pull Requests using GitHub CLI:

```
/review           # List open PRs
/review 42        # Full code review of PR #42
```

Requires `gh` CLI installed and authenticated.

### Git Tools (LLM-accessible)

| Tool | Description |
|------|-------------|
| `git_diff()` | Unstaged changes |
| `git_diff(staged: true)` | Staged changes |
| `git_diff(ref: "main")` | Diff against branch |
| `git_diff(stat: true)` | File-level stats only |
| `git_status()` | Full status |
| `git_log(count: 20)` | Last 20 commits |

### /undo

Reverts all file changes from the last turn. Maintains a 10-turn stack with conflict detection.

---

## MCP Server Mode

Run LAIA as an MCP server over stdio:

```bash
laia --mcp
```

Exposes a single `agent` tool that other MCP clients can invoke to delegate tasks to LAIA.

### Stdout Policy

| Mode | Description |
|------|-------------|
| `strict` | (default) No stdout leaks from tools — MCP-safe |
| `redirect` | Tool stdout redirected to stderr — visible but safe |

```bash
laia --mcp --mcp-stdout-policy redirect
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LAIA_BRAIN_PATH` | Brain data directory | `~/laia-data` |
| `LAIA_MODEL` | Default model | `claude-opus-4.6` |
| `LAIA_OUTPUT_STYLE` | Active output style name | _(none)_ |
| `CLAUDE_BRAIN_PATH` | _(deprecated)_ Legacy alias for `LAIA_BRAIN_PATH` | |

---

## File Structure

```
~/.laia/                        # LAIA config directory
├── LAIA.md                     # User-level memory file
├── LAIA-managed.md             # Corporate policy (optional)
├── evolved/                    # Auto-compiled prompt sections
│   ├── user-preferences.md
│   ├── task-patterns.md
│   ├── error-recovery.md
│   └── domain-knowledge.md
├── agents/                     # Agent profiles (*.yml)
├── skills/                     # V3 skills (*/SKILL.md)
├── commands/                   # Legacy commands (*.md)
├── output-styles/              # Output style definitions (*.md)
│   ├── concise.md
│   └── detailed.md
├── tips.json                   # Custom tips (optional)
├── sessions/                   # Saved sessions
└── logs/                       # Session logs (*.jsonl)
    └── tool-stats/             # Per-session tool usage stats

~/laia-data/                    # Brain data (git repo)
├── memory/
│   ├── learnings/              # Learning files (.md)
│   └── sessions/               # Session logs (.md)
├── knowledge/                  # Knowledge base files
├── learnings-meta.json
├── metrics.json
└── relations.json
```

---

## Troubleshooting

### LAIA won't start

```bash
node --version    # Must be 24+
laia --version    # Check installation
laia --verbose    # Verbose mode for debug output
```

### Brain not connecting

```bash
/debug brain not connecting
# or check logs:
ls -la ~/.laia/logs/
tail -20 ~/.laia/logs/$(ls -t ~/.laia/logs/*.jsonl | head -1)
```

### Model errors (rate limits, auth)

```bash
/tokens                    # Check usage
/model codex               # Switch to another model
/debug rate limit          # Self-diagnose
```

### Permission issues

If tools are being blocked unexpectedly:
- Check plan mode: `/execute` to exit read-only mode
- Reset session permissions: `/clear` then re-allow
- Check `~/.laia/LAIA-managed.md` for corporate policy restrictions

### Git integration issues

```bash
gh auth status             # Check gh CLI auth
git status                 # Check repo state
/review                    # Will show preflight error if gh missing
```

### Session recovery

```bash
/sessions                  # List saved sessions
/load autosave             # Restore last auto-save
/fork my-backup            # Fork before risky operations
```
