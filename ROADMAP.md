# Claudia — Roadmap

> CLI coding assistant — V1 Feature Complete 🏁
> Última actualització: 2026-03-22 (sessió 4)

---

## ✅ Ja implementat (equivalent o superior a Claude Code)

| Feature | Claudia | Claude Code | Notes |
|---------|:-------:|:-----------:|-------|
| Agent loop + tool calls | ✅ | ✅ | `llm.js` — agentic loop amb max iterations |
| Streaming | ✅ | ✅ | SSE per /responses i /chat/completions |
| File read/write/edit | ✅ | ✅ | `tools/` — read, write, edit amb fuzzy match |
| Bash execution | ✅ | ✅ | `tools/bash.js` — Git Bash on Windows |
| Permission system | ✅ | ✅ | 3-tier: auto / session / confirm |
| Session save/load | ✅ | ✅ | `session.js` — autosave + named sessions |
| Tab autocomplete | ✅ | ✅ | Slash commands + follow-up suggestion cycling |
| Auto-compaction | ✅ | ✅ | `context.js` — trigger at 80% capacity |
| Vision/Images | ✅ | ✅ | Multimodal: attach → base64 → content parts → API |
| Model routing | ✅ | ❌ | `router.js` — auto per-turn (codex/claude/mini) |
| 35 corporate skills | ✅ | ❌ | `commands/` — Jira, Confluence, Teams, Outlook, PostgreSQL, GitHub, Jenkins, etc. |
| **Daily briefing** | ✅ | ✅ | `/briefing` — 7 parallel workers, anomaly detection |
| Brain/memory (MCP) | ✅ | ✅* | Brain MCP server vs CLAUDE.md (*diferent mètode) |
| Image auto-routing | ✅ | ❌ | `hasImages → gpt-5.3-codex` automàtic |
| Attachment manager | ✅ | ✅ | `/attach` amb glob, dedup, images, binary detection |
| **Token budget + /tokens** | ✅ | ❌ | Per-turn `[in/out · ctx%]`, session `Σ`, `/tokens` command |
| **CLAUDE.md hierarchy** | ✅ | ✅ | 5-level: user → project → managed (50KB/file, 100KB total) |
| **Git tools** | ✅ | ✅ | `git_diff`, `git_status`, `git_log` — tier 1, read-only |
| **Git auto-commit** | ✅ | ❌ | `git-commit.js` (92 LOC), `--auto-commit`, `/autocommit`, `git commit --only` aïllat |
| **Diff preview** | ✅ | ✅ | Unified diff colorit al terminal per edit/write |
| **Swarm — `agent` tool** | ✅ | ❌ | `tools/agent.js` + `swarm.js` — workers in-process, paral·lels, `allowedTools` filter |
| **Agent Profiles** | ✅ | ❌ | YAML profiles (`~/.claudia/agents/`) — per-agent model, tools, prompt, maxSteps |
| **Parallel agents (Copilot fix)** | ✅ | ✅ | Fix 3 bugs: streaming, forceToolChoiceRequired, index offset |
| **MCP server mode** | ✅ | ❌ | `--mcp` flag: exposa tool `agent` via MCP stdio |
| **/undo stack** | ✅ | ❌ | `undo.js` (113 LOC), 10-turn stack, conflict detection, workspace guard |
| **Cost tracking** | ✅ | ❌ | `sessionTokens` acumulat per sessió, `Σ` display, `formatTokenCount` |
| **Plan Mode** | ✅ | ✅ | `/plan`, `/execute`, `--plan` — read-only mode (dual enforcement: schema + dispatch) |

---

## 🔧 Architecture Review Findings (2026-03-19)

> 3-round adversarial review amb 2 agents gpt-5.3-codex (Security + Architecture).
> Resultat: 0 HIGH, 6 MEDIUM, 2 LOW. Detalls: `docs/ARCHITECTURE_REVIEW.md`

| # | Finding | Severitat | Status |
|---|---------|-----------|--------|
| 1 | **Registry freeze** | MEDIUM | ✅ DONE |
| 2 | **Context `addTurn()` atòmic** | MEDIUM | ✅ DONE |
| 3 | **Corporate workflow pre-hook** | MEDIUM | ✅ DONE |
| 4 | **`allowedTools` per workers** | MEDIUM | ✅ DONE |
| 5 | Prompt modularització | MEDIUM | 🟡 DEFER (94 línies, no crític) |
| 6 | Worker trust docs | MEDIUM | 🟡 DEFER (documentació) |
| 7 | Token cache permisos | LOW | ❄️ SKIP |
| 8 | Provider abstraction | LOW | ❄️ SKIP |

---

## 🚀 V2 — Improvements (basat en Claude Code docs research 2026-03-22)

> Proposta acordada amb Codex en 2 rondes. Document complet: `knowledge/tools/claudia-brain-v2-proposal-2026-03-22.md`

| # | Feature | Effort | Status |
|---|---------|--------|--------|
| 1 | **Plan Mode** (`/plan`, `/execute`, `--plan`) | 4h | ✅ DONE (2026-03-22) |
| 2 | **Subagents v2a** — per-agent model + allowedTools (YAML profiles) | 4h | ✅ DONE (2026-03-22) |
| 3 | **Brain memory quality** — dedup + decay + auto-archive | 8h | ✅ DONE (2026-03-22) |
| 4 | **CLI flags** — `--effort`, `--fork` | 4h | ✅ DONE (2026-03-22) |
| 5 | **Subagents v2b** — persistent agent memory (namespaced tags) | 6h | ✅ DONE (2026-03-22) |
| 6 | **`/agents` command** — list/edit/validate profiles | 4-6h | ✅ DONE (2026-03-22) |

Deferred to V3+: hooks framework, path rules, code-intel, **skills v3**, channels, plugins.

---

## 🔮 V3 — Skills System (planificat 2026-03-22)

> Migrar de `~/.claude/commands/*.md` a `~/.claude/skills/*/SKILL.md`.
> Principi: "Claude-compatible, Claudia-opinionated". Compatible amb Claude Code natiu.
> Document complet: `knowledge/tools/claudia-skills-v3-plan-2026-03-22.md`

| Phase | Feature | Effort | Status |
|-------|---------|--------|--------|
| 1 | **Skill Loader** — discover, load, frontmatter, supporting files, /skills | 4h | ✅ DONE (2026-03-22) |
| 2 | **Migration** — commands/*.md → skills/*/SKILL.md (simple script) | 2h | ✅ DONE (2026-03-22) |
| 3 | **Auto-invoke + Fork** — invocation:both, context:fork, project-level | 6h | 🟡 DEFERRED |

---

## 🧬 V4 — Brain Evolution (planificat 2026-03-31)

> Inspirat en anàlisi de [ghostwright/phantom](https://github.com/ghostwright/phantom).
> Revisat amb GPT-5.3-Codex (1 ronda). Document complet: `docs/2026-03-31-brain-evolution-plan.md`

| Sprint | Feature | Effort | Status |
|--------|---------|--------|--------|
| 1 | **Procedural Memory** — type `procedure`, trigger_intents, steps, outcome tracking | 8h | 🔲 TODO |
| 1 | **Golden Suite Lite** — `protected: true`, decay immunity, auto-promotion, contradiction detection | 6h | 🔲 TODO |
| 2 | **Post-Session Reflection** — `brain_reflect_session` tool, confidence-gated auto-save, Codex safeguards | 14h | 🔲 TODO |
| 3 | **Quality Scorecard** — composite score, sparkline trends, alerts in brain_health | 8h | 🔲 TODO |
| 4 | **Evolved System Prompt** — `~/.claudia/evolved/`, compiled dual-layer (stable+adaptive), `/evolve` | 16h | 🔲 TODO |
| Future | **Evaluation Harness** — replay corpus, rubrics, regression detection | 20h+ | 🔲 DEFERRED |

---

## 📋 Backlog futur

| Feature | Prioritat | Notes |
|---------|-----------|-------|
| MCP server connections | 🟡 DEFER | Connectar a MCP servers externs. 35 skills ja cobreixen tot. Fer quan hi hagi necessitat real. |
| Prompt modularització | 🟡 DEFER | Separar system prompt en mòduls. Fer quan creixi. |
| Worker trust docs | 🟡 DEFER | Documentar model de trust dels workers. |

---

## 🚀 V5 — Claude Code Adoption Roadmap (2026-04-01)

> Roadmap consensuat per 3 agents (OPUS, SONNET, CODEX) analitzant el codi font de Claude Code.
> Document complet: `~/laia-data/knowledge/roadmap-claude-code-adoption.md`

### Phase 1: Quick Wins DX ✅ (implementat 2026-04-01)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | **`/commit`** — generate commit from staged/unstaged changes | ✅ DONE | Gathers git status/diff/branch/log, builds LLM prompt. Ref: CC `src/commands/commit.ts` |
| 2 | **`/review <PR#>`** — code review a Pull Request | ✅ DONE | Uses `gh` CLI with preflight check. Ref: CC `src/commands/review.ts` |
| 3 | **`/debug [issue]`** — diagnose session issues | ✅ DONE | Reads session logs, tool stats, builds diagnostic prompt. Ref: CC `src/skills/bundled/debug.ts` |
| 4 | **`/style [name\|list\|off]`** — output styles | ✅ DONE | `.md` files with frontmatter in `~/.laia/output-styles/`. Injected into system prompt. Ref: CC `src/outputStyles/` |
| 5 | **`/tip`** — contextual tips | ✅ DONE | 20 bundled tips, shown during spinner waits (3s delay). User-extensible via `~/.laia/tips.json` |
| 6 | **Spinner tips** — auto-show tip during LLM wait | ✅ DONE | Integrated in `turn-runner.js` with proper terminal cleanup |

### Phase 2: Memòria Intel·ligent 🧠 (pendent)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | **Memòria Tipada** — 4 tipus: user/feedback/project/reference | ✅ DONE | Ref: CC `src/memdir/memoryTypes.ts` |
| 2 | **Session Memory/Notes** — template 9 seccions | ✅ DONE | Ref: CC `src/services/SessionMemory/` |
| 3 | **Context Compaction** — auto-compact al ~80% amb prompt 9 seccions | ✅ DONE | Ref: CC `src/services/compact/` |

### Phase 3: Skills & Commands ⚡ (pendent)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | **Skills System upgrade** — SKILL.md amb frontmatter + bundled skills | 🔲 TODO | `/batch`, `/simplify`, `/remember`. Ref: CC `src/skills/bundled/` |
| 2 | **`/init`** — generar LAIA.md per projecte | 🔲 TODO | Ref: CC `src/commands/init.ts` |
| 3 | **Magic Docs** — auto-updating docs | 🔲 TODO | Ref: CC `src/services/MagicDocs/` |

### Phase 4: Orquestració Multi-Agent 🤖 (pendent)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | **CoordinatorMode** — Research→Synthesis→Implementation→Verify | ✅ DONE | Ref: CC `src/coordinator/coordinatorMode.ts` |
| 2 | **AgentTool millorat** — modes sync/async/fork | 🔲 TODO | Ref: CC `src/tools/AgentTool/` |
| 3 | **SendMessage/Mailbox** — inter-agent messaging | 🔲 TODO | Ref: CC `src/tools/SendMessageTool/` |

### Dropped (acordat amb Codex review 2026-03-21)
- `/init` command — CLAUDE.md ja existeix a tots els projectes
- Interactive diff approval — /undo + auto-commit ja cobreixen
- Web search tool — no necessari per workflow actual
- Notebook/REPL tool — bash() ja executa Python/JS
- Vim/Emacs keybindings — readline default és suficient
- Generic retry wrapper — cada skill gestiona els seus errors

---

## 📊 Estat del codebase

| Mètrica | Valor |
|---------|-------|
| Tests | 155 test cases (11 files) |
| Fitxers src/ | 38 (26 core + 11 tools + 1 shared pkg) |
| Tools LLM | 14 (read, write, edit, bash, glob, grep, brain×3, run_command, git×3, agent) |
| Slash commands | 28 (session×6, config×5, git×3, files×3, agents×2, skills×1, system×8) |
| LOC (src/) | ~5000 |
| Skills | 36 (`~/.claude/skills/*/SKILL.md`) — compatible Claude Code + Claudia |
| Dependències extra | 2 (`fast-glob`, `@modelcontextprotocol/sdk`) |
| Node.js | 24+ (ESM) |

---

## Historial de versions

| Data | Commits | Features |
|------|---------|----------|
| 2026-03-15 | MVP | Agent loop, streaming, tools, permissions, sessions |
| 2026-03-16 | +5 | Vision/images, router, attachments, brain MCP |
| 2026-03-17 | +4 | Token budget, CLAUDE.md hierarchy, git tools, diff preview, auto-commit, undo stack, cost tracking |
| 2026-03-18 | +20 | Codex review fixes, swarm (agent tool + semaphore + batch dispatch + allowedTools), MCP server mode (stdio + stdout guard), permissions refactor |
| 2026-03-18 | +1 | Automated multi-agent code review (5 parallel agents): fix 13 issues |
| 2026-03-19 | +3 | Architecture review: registry freeze, atomic addTurn, corporate pre-hook |
| 2026-03-19 | +2 | **Multi-provider LLM routing (api-agnostic-v2):** `@laia/providers` shared package (5 providers) |
| 2026-03-21 | +4 | **`/briefing` daily briefing skill** (7 parallel workers). **Parallel agents fix** (3 Copilot streaming bugs). **V1 Feature Complete** declared after Codex review. |
| 2026-03-22 | +1 | **Plan Mode** (`/plan`, `/execute`, `--plan`). Dual enforcement (schema + dispatch). Reviewed by Codex. V2 roadmap defined (6 items, ~30h). |
| 2026-03-22 | +1 | **Agent Profiles V2a** — YAML profiles (`~/.claudia/agents/`), resolveToolSet, customPrompt, maxSteps cap. 3 example profiles. Reviewed by Codex (3 rounds). |
| 2026-03-22 | +1 | **Brain Memory Quality V2** — type-aware idle decay, cold tier, dedup tuning (0.70→0.65), brain_health dashboard with grade. Production: 1233 all-active → 484 active + 281 stale + 154 cold + 247 fading. Reviewed by Codex (3 rounds). |
| 2026-03-22 | +1 | **CLI Flags V2** — `--effort` (low/medium/high/max → reasoning_effort param) + `--fork` (session branching). `/effort` and `/fork` REPL commands. |
| 2026-03-22 | +1 | **Subagents V2b** — persistent agent memory (memoryPrefetch, brain.search/remember gating, auto-tag agent:<profile>). **V3 Skills System** planned. |
| 2026-03-22 | +1 | **`/agents` command** — list, validate, show. **V2 ROADMAP COMPLETE** (6/6 items done in one session). |
| 2026-04-01 | +1 | **Phase 1 Quick Wins** (Claude Code adoption) — `/commit`, `/review`, `/debug`, `/style`, `/tip`, output styles, contextual tips. Reviewed by Codex. |
