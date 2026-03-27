# Claudia

**Autonomous CLI coding agent powered by GitHub Copilot Business API.**

An open-source, single-developer alternative to Claude Code — built from scratch in Node.js with zero-dependency philosophy. Uses your existing Copilot Business license to access Claude, GPT, and Codex models through a unified agentic interface.

```
claudia                        # Interactive REPL
claudia -p "fix the bug"       # One-shot mode
claudia --plan                 # Read-only plan mode
claudia --swarm -p "refactor"  # Multi-agent mode
```

---

## Why Claudia?

| | Claude Code | Claudia |
|---|:-:|:-:|
| License cost | Anthropic API key ($$$) | **Copilot Business** (included) |
| Models | Claude only | **Claude + GPT-5.3 + Codex** (auto-routed) |
| Corporate tools | Limited MCPs | **38 built-in skills** (Jira, Confluence, Teams, Outlook, Jenkins, Dynatrace...) |
| Memory | CLAUDE.md files | **Persistent brain** with auto-learn, decay, clustering |
| Multi-agent | ❌ | **Swarm mode** with parallel workers |
| Auto model routing | ❌ | **Per-turn routing** based on intent |
| Undo | Limited | **10-turn undo stack** with conflict detection |
| Cost tracking | ❌ | **Per-turn & session token tracking** |
| Agent profiles | ❌ | **YAML profiles** with per-agent model/tools/prompt |

---

## Quick Start

### Prerequisites

- **Node.js 24+** (ESM required)
- **GitHub Copilot Business** license (active)
- **Git Bash** on Windows (ships with Git for Windows)

### Install

```bash
git clone https://github.developer.allianz.io/jordi-tribo/claudia.git
cd claudia
npm install
npm link          # makes 'claudia' available globally
```

### First run

```bash
claudia
# Copilot token exchange happens automatically
# Type your first prompt and go
```

---

## Architecture

```
bin/claudia.js          Entry point (CLI args, mode dispatch)
│
├── src/repl.js         Interactive REPL (readline, spinner, tab-complete)
├── src/agent.js        One-shot mode (single prompt → result)
├── src/mcp-server.js   MCP server mode (expose agent tool via stdio)
│
├── src/llm.js          LLM client (SSE streaming, /responses + /chat/completions)
├── src/router.js       Per-turn model auto-router (corporate/coding/quick)
├── src/config.js       Configuration loader
├── src/context.js      Context window management + auto-compaction
├── src/system-prompt.js  System prompt builder (5-level CLAUDE.md hierarchy)
│
├── src/tools/          Built-in tools (14 total)
│   ├── read.js         File reading
│   ├── write.js        File creation/overwrite
│   ├── edit.js         Search/replace with fuzzy matching
│   ├── bash.js         Shell execution (Git Bash)
│   ├── glob.js         File pattern matching
│   ├── grep.js         Text search
│   ├── git.js          Git operations (diff, status, log)
│   ├── brain.js        Memory tools (search, remember, context)
│   ├── command.js      Skill discovery and execution
│   ├── outlook.js      Outlook email/calendar (13 tools via MCP)
│   ├── agent.js        Spawn worker agents (swarm mode)
│   └── index.js        Registry + bootstrap
│
├── src/brain/client.js    Brain MCP client (lazy init)
├── src/outlook/client.js  Outlook MCP client (lazy init)
├── src/skills.js          Skill loader (V3: directories + legacy flat files)
├── src/profiles.js        Agent profile loader (YAML)
├── src/session.js         Session persistence (save/load/fork)
├── src/permissions.js     3-tier permission system
├── src/render.js          Markdown rendering for terminal
├── src/diff.js            Unified diff preview (colorized)
├── src/undo.js            10-turn undo stack
├── src/git-commit.js      Git auto-commit
├── src/paste.js           Clipboard paste handling
├── src/attach.js          File attachment manager
├── src/swarm.js           Multi-agent orchestration
├── src/logger.js          Structured logging
├── src/memory-files.js    CLAUDE.md hierarchy loader
├── src/user-profile.js    User preferences
│
└── packages/providers/    @claude/providers (shared package)
    └── src/providers.js   Multi-provider registry (Copilot, Anthropic, Azure, GenAI Lab)
```

### Lines of Code

| Component | LOC |
|-----------|----:|
| Core (`src/*.js`) | 4,629 |
| Tools (`src/tools/*.js`) | 1,163 |
| MCP clients (`src/brain/`, `src/outlook/`) | 214 |
| Provider package | 301 |
| Entry point | 80 |
| **Total source** | **~6,400** |
| Tests (17 files) | ~700 |

---

## Features

### 🤖 Multi-Model Auto-Router

Every prompt is automatically routed to the best model:

```
"update the Jira ticket"     → claude-opus-4.6     (corporate tools)
"fix the null pointer"       → gpt-5.3-codex       (coding)
"yes" / "ok"                 → gpt-4.1-mini         (quick acknowledgments)
```

The router uses keyword detection, tool-call stickiness, and domain history. Override anytime with `--model` or `/model`.

### 🧠 Persistent Brain

A local MCP server that provides:
- **Auto-learn**: patterns, warnings, and learnings saved across sessions
- **Semantic search**: BM25 + embedding hybrid with graph expansion
- **Decay system**: active → stale → cold → archived (type-aware idle thresholds)
- **LLM-powered**: auto-tags, query expansion, distillation (via Copilot → Bedrock fallback)

```
brain_search("jira sprint")       → finds known patterns
brain_remember(type, title, ...)  → saves for future sessions
brain_get_context(project)        → loads relevant context at session start
```

### 📧 Outlook Integration

13 native tools for email and calendar via Playwright MCP server:

| Tool | Function |
|------|----------|
| `outlook_check_auth` | Verify session |
| `outlook_get_emails` | List inbox/sent/drafts |
| `outlook_search_emails` | Search by query/sender/subject |
| `outlook_read_email` | Read full email content |
| `outlook_get_unread_count` | Unread counter |
| `outlook_get_schedule` | Calendar events by date |
| `outlook_find_contact` | Lookup by name |
| `outlook_compose_draft` | Create draft |
| `outlook_reply_email` | Reply (saved as draft) |
| `outlook_forward_email` | Forward (saved as draft) |
| `outlook_send_draft` | Send with safety gate |
| `outlook_get_draft` | Read draft |
| `outlook_update_draft` | Modify draft |

### 🔧 38 Corporate Skills

Pre-built integrations for enterprise tools:

| Category | Skills |
|----------|--------|
| **Project Management** | Jira (tickets, sprints, JQL, Tempo worklogs), Confluence (read, search, create, update) |
| **DevOps** | Jenkins (builds, console), GitHub Enterprise (repos, PRs, code search), SonarQube |
| **Monitoring** | Dynatrace (problems, entities, metrics, DQL logs, health workflow, exception grouping, correlationID tracing, body stitching) |
| **Communication** | Teams (send messages, channels), Outlook (13 tools), OneNote |
| **Cloud & Infra** | Azure, SharePoint, ControlM, ServiceNow, Flexera |
| **Data** | PostgreSQL, Power BI |
| **Identity** | GIAM/LRP (access requests via Playwright) |
| **Productivity** | Daily briefing (7 parallel workers), PDF reader, PPT generator (Allianz branded) |
| **Social** | LinkedIn (profile, feed) |

Skills are Markdown files with embedded curl/Python commands — no SDK dependencies.

### 🐝 Swarm Mode (Multi-Agent)

Spawn focused worker agents for parallel subtasks:

```bash
claudia --swarm
> Refactor the authentication module

# Claudia spawns 3 workers in parallel:
# Worker 1: Analyze current auth code (read-only)
# Worker 2: Check test coverage (read-only)
# Worker 3: Search for security patterns (brain)
# → Synthesizes results → implements changes
```

Workers run in-process with:
- **Tool filtering**: `allowedTools: ["read", "grep", "glob"]` for read-only scouts
- **Parallel execution**: independent workers run simultaneously
- **Profile support**: YAML-defined agent personas

### 👤 Agent Profiles

Define specialized agents in `~/.claudia/agents/`:

```yaml
# reviewer.yml
name: Code Reviewer
model: claude-opus-4.6
allowedTools: [read, grep, glob, git_diff, git_log]
maxSteps: 30
systemPrompt: |
  You are a senior code reviewer. Focus on:
  - Security vulnerabilities
  - Performance anti-patterns
  - Test coverage gaps
```

Built-in profiles: `coder`, `researcher`, `reviewer`.

### 📋 Plan Mode

Read-only exploration without modifying files:

```bash
claudia --plan
> How should we restructure the database schema?

# Can read files, search, grep — but cannot write, edit, or run bash
# Dual enforcement: tool schema restrictions + dispatch-level blocking
```

Toggle in-session with `/plan` and `/execute`.

### ↩️ Undo Stack

10-turn undo with conflict detection:

```
/undo              # Revert last file changes
/undo              # Revert the one before that
# Detects if files changed externally since the edit
```

### 💰 Token Tracking

Per-turn and session-level cost awareness:

```
[in:1.2k out:340 · ctx:34%]     # Each turn shows token usage
Σ in:45.2k out:12.1k             # Session total with /tokens
```

### 📎 Attachments

```
/attach src/**/*.py      # Attach files by glob
/attach screenshot.png   # Images auto-routed to vision model
/attach                  # Show current attachments
/detach                  # Clear all
```

### 🔐 Permission System

Three tiers:
1. **Auto-allowed**: read, glob, grep, git_status, git_log, brain_search — no confirmation needed
2. **Session-allowed**: write, edit — confirm once, allowed for session
3. **Always-confirm**: bash, destructive operations — confirm each time

### 💾 Session Management

```
/save my-feature        # Save current session
/load my-feature        # Resume later
/fork experiment        # Branch from current point
/sessions               # List saved sessions
```

Auto-save on every turn. Survives crashes.

---

## CLI Reference

### Modes

```bash
claudia                          # Interactive REPL
claudia -p "prompt"              # One-shot (execute and exit)
claudia "prompt"                 # One-shot (positional)
claudia --mcp                    # Run as MCP server (stdio)
```

### Flags

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | One-shot prompt |
| `-m, --model <id>` | Override model |
| `--json` | JSON output (one-shot mode) |
| `--swarm` | Enable agent tool (multi-agent) |
| `--plan` | Read-only mode |
| `--auto-commit` | Git commit after each turn |
| `--effort <level>` | Reasoning: `low`, `medium`, `high`, `max` |
| `--fork <name>` | Fork a saved session |
| `--mcp` | MCP server mode |
| `--verbose` | Debug logging |

### REPL Commands

| Command | Action |
|---------|--------|
| `/help` | Show available commands |
| `/model [name]` | Show or switch model |
| `/plan` | Enter read-only mode |
| `/execute` | Exit read-only mode |
| `/undo` | Revert last file changes |
| `/save [name]` | Save session |
| `/load [name]` | Load session |
| `/fork [name]` | Fork session |
| `/sessions` | List saved sessions |
| `/tokens` | Show token usage |
| `/attach <path>` | Attach files/images |
| `/detach` | Clear attachments |
| `/agents` | List agent profiles |
| `/swarm` | Toggle multi-agent mode |
| `/autocommit` | Toggle git auto-commit |
| `/effort <level>` | Set reasoning effort |
| `/skills` | List available skills |
| `/compact` | Force context compaction |
| `/clear` | Clear conversation history |
| `/exit` | Exit (triggers brain save) |

---

## Provider System

### `@claude/providers` (shared package)

A transport-agnostic provider registry used by both Claudia and Brain:

| Provider | Endpoint | Auth | Models |
|----------|----------|------|--------|
| **Copilot** | `api.business.githubcopilot.com` | Token exchange (VS Code flow) | All Copilot-available models |
| **Anthropic Bedrock** | AWS `bedrock-runtime` | IAM/SSO (`AWS_PROFILE`) | Claude Haiku/Sonnet/Opus |
| **Azure OpenAI** | Custom endpoint | API key | GPT models |
| **GenAI Lab** | Internal Allianz platform | Token | Various |
| **Ollama** | Local `localhost:11434` | None | Local models |

Default: **Copilot** (primary) → **Bedrock Haiku** (fallback).

### Model IDs

| Alias | Model | Use |
|-------|-------|-----|
| `codex` | `gpt-5.3-codex` | Coding (default) |
| `claude` | `claude-opus-4.6` | Corporate tools, complex reasoning |
| `mini` | `gpt-4.1-mini` | Quick responses |

---

## Skills System (V3)

Skills live in `~/.claude/commands/*.md` (legacy) or `~/.claude/skills/*/SKILL.md` (V3):

```
~/.claude/
├── commands/
│   ├── jira.md              # Jira integration
│   ├── confluence.md        # Confluence CRUD
│   ├── dynatrace.md         # Monitoring & health
│   ├── jenkins.md           # CI/CD builds
│   ├── teams.md             # Teams messaging
│   ├── outlook.md           # Legacy Outlook (COM)
│   ├── outlook-mcp.md       # Outlook MCP (Playwright)
│   ├── github.md            # GitHub Enterprise
│   ├── sonarqube.md         # Code quality
│   ├── sharepoint.md        # SharePoint Online
│   ├── servicenow.md        # ITSM
│   ├── postgresql.md        # Database queries
│   ├── controlm.md          # Job scheduling
│   ├── flexera.md           # License management
│   ├── onenote.md           # Notes
│   ├── giam.md              # Identity & Access
│   ├── linkedin.md          # Social profile
│   ├── briefing.md          # Daily briefing
│   ├── allianz-pptx.md      # PowerPoint generator
│   ├── pdf.md               # PDF reader
│   └── ... (38 total)
└── skills/                   # V3 directory-based skills
    └── outlook-mcp/
        └── SKILL.md
```

### Creating a Skill

```markdown
---
name: my-tool
description: Does something useful
model: claude-opus-4.6
---

# My Tool Skill

When the user asks about X, execute:

\`\`\`bash
curl -s https://api.example.com/... \
  -H "Authorization: Bearer $TOKEN"
\`\`\`
```

Skills are auto-discovered. The LLM sees them via the `run_command` tool.

---

## MCP Server Mode

Claudia can run as an MCP server, exposing its agent capability to other tools:

```bash
claudia --mcp
```

This exposes a single `agent` tool over stdio that accepts prompts and returns results. Useful for integrating Claudia into larger workflows or other MCP-compatible clients.

---

## Brain MCP Server

A separate MCP server (`claude_local_brain/`) provides persistent memory:

```json
{
  "mcpServers": {
    "claude-brain": {
      "command": "node",
      "args": ["path/to/mcp-server/index.js"],
      "env": {
        "BRAIN_DATA_PATH": "path/to/brain-data",
        "BRAIN_LLM_FALLBACK": "bedrock:haiku"
      }
    }
  }
}
```

### Brain Tools

| Tool | Function |
|------|----------|
| `brain_search` | Semantic + keyword search over memory |
| `brain_remember` | Store learnings, warnings, patterns |
| `brain_get_context` | Load project context at session start |

### LLM Fallback Chain

```
1. Copilot (primary, free)
   └── fail? → 2. Bedrock Haiku (AWS Allianz, ~$0.01/day)
                   └── fail? → 3. Degrade gracefully (no auto-tags/expand)
```

---

## Outlook MCP Server

A Playwright-based MCP server for Outlook Web:

```bash
cd mcp-servers/outlook-mcp
npm install
node scripts/login.js    # SSO/MFA once (session persisted)
```

Works cross-platform (Windows, Mac, Linux). 13 tools for email, calendar, contacts, and drafts.

---

## Tests

```bash
npm test                        # Run all tests
node --test tests/unit/*.js     # Unit tests only
```

17 test files covering: providers, tools (edit, git, permissions, registry), session management, undo, paste, swarm, SSE parsing, memory files, diff, attachments.

---

## Project Stats

| Metric | Value |
|--------|------:|
| Total source LOC | ~6,400 |
| Total commits | 122 |
| Test files | 17 |
| Built-in tools | 14 (+ 13 Outlook) |
| Corporate skills | 38 |
| Agent profiles | 3 |
| External dependencies | 3 (`fast-glob`, `@modelcontextprotocol/sdk`, `yaml`) |
| Node.js | 24+ (ESM) |
| Development period | March 15–27, 2026 (12 days) |

---

## Development Timeline

| Date | Milestone |
|------|-----------|
| Mar 15 | **MVP**: Agent loop, streaming, tools, permissions, sessions |
| Mar 16 | Vision/images, auto-router, attachments, brain MCP |
| Mar 17 | Token budget, CLAUDE.md hierarchy, git tools, diff, auto-commit, undo, cost tracking |
| Mar 18 | Swarm (multi-agent), MCP server mode, permissions refactor, automated 5-agent code review |
| Mar 19 | Architecture review (0 HIGH findings), multi-provider `@claude/providers` package |
| Mar 21 | `/briefing` (7 parallel workers), parallel agent fixes, **V1 Feature Complete** |
| Mar 22 | Plan mode, agent profiles, brain quality, CLI flags, **V2 Complete** (6/6 items in one session) |
| Mar 22 | Skills V3 loader + migration |
| Mar 27 | Outlook MCP (13 tools), Dynatrace enrichment (+4 capabilities), Bedrock fallback, provider cleanup |

---

## License

Internal project — Allianz Technology S.L.

---

*Built by [Jordi Tribó](mailto:jordi.tribo@allianz.es) — AI Technical Ambassador / Data Engineer*
