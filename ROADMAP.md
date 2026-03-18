# Claudia — Roadmap

> Comparativa amb Claude Code + pla d'implementació
> Última actualització: 2026-03-18

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

---

## 📋 Backlog futur

| Feature | Prioritat | Esforç | Notes |
|---------|-----------|--------|-------|
| **claudia swarm — `agent` tool (in-process)** | 🔴 HIGH | 6h | Nou tool `agent({prompt, files?, model?})`: workers in-process amb context net, `Promise.all` per paral·lelisme real. Refactors: `permissions.js` instanciable, client no singleton, `buildWorkerSystemPrompt()`. Objectiu: superar limitació de context window delegant a workers especialitzats. |
| **claudia MCP server mode** | 🔴 HIGH | 4h | `--mcp` flag: exposa tool `agent` via MCP stdio. Claude Code es connecta i delega tasques a workers Copilot (estalvi tokens Anthropic). `src/mcp-server.js` amb `@modelcontextprotocol/sdk` (ja disponible). |
| Git auto-commit | 🟡 MED | 2h | Commit automàtic després d'edits (opt-in) |
| MCP server connections | 🟡 MED | 4h | Connect to external MCP servers dynamically |
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
| Tests | 117/117 ✅ |
| Fitxers src/ | 17 |
| Tools LLM | 12 (read, write, edit, bash, glob, grep, brain×4, command, git×3) |
| LOC (src/) | ~3200 |
| Dependències extra | 1 (`fast-glob`) |
| Node.js | 24+ (ESM) |

---

## Historial de versions

| Data | Commits | Features |
|------|---------|----------|
| 2026-03-15 | MVP | Agent loop, streaming, tools, permissions, sessions |
| 2026-03-16 | +5 | Vision/images, router, attachments, brain MCP |
| 2026-03-17 | +4 | Token budget, CLAUDE.md hierarchy, git tools, diff preview |
| 2026-03-18 | +1 | Codex review fixes: security (execFileSync), perf (Uint32Array), UX (truncation) |
