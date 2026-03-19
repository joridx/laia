# Claudia — Roadmap

> Comparativa amb Claude Code + pla d'implementació
> Última actualització: 2026-03-19

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
| 30+ corporate skills | ✅ | ❌ | `commands/` — Jira, Confluence, Teams, etc. |
| Brain/memory (MCP) | ✅ | ✅* | Brain MCP server vs CLAUDE.md (*diferent mètode) |
| Image auto-routing | ✅ | ❌ | `hasImages → gpt-5.3-codex` automàtic |
| Attachment manager | ✅ | ✅ | `/attach` amb glob, dedup, images, binary detection |
| **Token budget display** | ✅ | ❌ | `[in / out · 45% ctx]` amb color 🟢🟡🔴 |
| **CLAUDE.md hierarchy** | ✅ | ✅ | 5-level: user → project → managed (50KB/file, 100KB total) |
| **Git tools** | ✅ | ✅ | `git_diff`, `git_status`, `git_log` — tier 1, read-only |
| **Diff preview** | ✅ | ✅ | Unified diff colorit al terminal per edit/write |
| **Swarm — `agent` tool** | ✅ | ❌ | `tools/agent.js` + `swarm.js` — workers in-process amb context net, paral·lels via semaphore |
| **MCP server mode** | ✅ | ❌ | `--mcp` flag: exposa tool `agent` via MCP stdio. Stdout guard (strict/redirect). |

---

## 🔧 Architecture Review Findings (2026-03-19)

> 3-round adversarial review amb 2 agents gpt-5.3-codex (Security + Architecture).
> Resultat: 0 HIGH, 6 MEDIUM, 2 LOW. Detalls: `docs/ARCHITECTURE_REVIEW.md`

### Recomanats per implementar

| # | Finding | Severitat | Esforç | Status |
|---|---------|-----------|--------|--------|
| 1 | **Registry freeze** | MEDIUM | 7 LOC | ✅ DONE — `frozen` flag a `createToolRegistry()`, `set/delete` throw si frozen, auto-freeze post-bootstrap (except REPL) |
| 2 | **Context `addTurn()` atòmic** | MEDIUM | 10 LOC | ✅ DONE — `addTurn({ assistantText, turnMessages })` unifica `addTurnMessages` + `addAssistant`. Bug duplicació user detectat i fixat per Codex review |
| 3 | **Corporate workflow pre-hook** | MEDIUM | 10 LOC | ✅ DONE — Router retorna `corporateHint`, system prompt injecta `## ⚠ Corporate Service Detected` dinàmicament. Soft hint, no hard gate (Codex va acceptar: FP risk massa alt) |
| 4 | **`allowedTools` param per workers** | MEDIUM | ~25 LOC | 🟡 DEFER — nice-to-have, no urgent (same trust boundary) |
| 5 | **Prompt modularització** | MEDIUM | ~20 LOC | 🟡 DEFER — 94 línies no és crític, fer quan creixi |
| 6 | **Worker trust docs** | MEDIUM | docs | 🟡 DEFER — documentació, no bloqueja res |
| 7 | Token cache permisos | LOW | ~5 LOC | ❄️ SKIP — %TEMP% ja és per-user, token expira 30min |
| 8 | Provider abstraction | LOW | refactor | ❄️ SKIP — YAGNI, un sol provider |

---

## 📋 Backlog futur

| Feature | Prioritat | Esforç | Notes |
|---------|-----------|--------|-------|
| ~~Registry freeze~~ | ✅ DONE | — | Implementat 2026-03-19 |
| ~~Context `addTurn()` atòmic~~ | ✅ DONE | — | Implementat 2026-03-19 |
| ~~Corporate workflow pre-hook~~ | ✅ DONE | — | Implementat 2026-03-19 |
| Git auto-commit | 🟡 MED | 2h | Commit automàtic després d'edits (opt-in) |
| MCP server connections | 🟡 MED | 4h | Connect to external MCP servers dynamically |
| `allowedTools` per agent workers | 🟡 MED | 1h | Paràmetre opcional per restringir tools disponibles al worker |
| `/init` command | 🟢 LOW | 1h | Genera CLAUDE.md a partir del projecte |
| Web search tool | 🟢 LOW | 2h | WebSearch equivalent |
| Notebook/REPL tool | 🟢 LOW | 3h | Executar Python/JS inline amb output |
| Vim/Emacs keybindings | 🟢 LOW | 1h | readline config |
| Interactive diff approval | 🟢 LOW | 4h | Confirmar diffs abans d'escriure (y/n) |
| `/undo` command | 🟢 LOW | 2h | Revertir últim edit/write |
| Cost tracking | 🟢 LOW | 1h | Comptador de tokens acumulats per sessió |

---

## 📊 Estat del codebase

| Mètrica | Valor |
|---------|-------|
| Tests | 154/154 ✅ |
| Fitxers src/ | 30 (19 core + 11 tools) |
| Tools LLM | 13 (read, write, edit, bash, glob, grep, brain×4, command, git×3, agent) |
| LOC (src/) | ~3850 |
| Dependències extra | 2 (`fast-glob`, `@modelcontextprotocol/sdk`) |
| Node.js | 24+ (ESM) |

---

## Historial de versions

| Data | Commits | Features |
|------|---------|----------|
| 2026-03-15 | MVP | Agent loop, streaming, tools, permissions, sessions |
| 2026-03-16 | +5 | Vision/images, router, attachments, brain MCP |
| 2026-03-17 | +4 | Token budget, CLAUDE.md hierarchy, git tools, diff preview |
| 2026-03-18 | +20 | Codex review fixes, swarm (agent tool + semaphore + batch dispatch), MCP server mode (stdio + stdout guard), permissions refactor, spec compliance fixes (singleton client, indentation, per-worker permCtx) |
| 2026-03-18 | +1 | Automated multi-agent code review (5 parallel claudia agents): fix 13 issues — tool timeout via Promise.race, null-safe batch results, SSE debug log, proper Error throwing, MCP full stack propagation, headless auto-deny warning, unexpected key feedback, brain-disabled user warning, structured turn error log; fix test glob quoting for Windows |
| 2026-03-19 | +3 | Architecture review findings: registry freeze (7 LOC), atomic addTurn (10 LOC), corporate workflow pre-hook (10 LOC). All reviewed with gpt-5.3-codex adversarial debate. ANSI dim fix for ctx% color. |
| 2026-03-19 | +2 | **Multi-provider LLM routing (api-agnostic-v2):** `@claude/providers` shared package (5 providers: copilot, openai, anthropic, azure_openai, ollama). `detectProvider()` with explicit prefix override + pattern auto-detect + availability guard. VS Code-style Copilot headers (vscode/1.109.5). Deterministic token selection from apps.json (appId > ghu_ > sorted). Brain integration with standalone fallback. |
