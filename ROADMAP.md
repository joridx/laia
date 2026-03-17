# Claudia — Roadmap

> Comparativa amb Claude Code + pla d'implementació
> Última actualització: 2026-03-17

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

---

## 🔨 Pendent d'implementar (dissenyat)

### 1. Token Budget Display
- **Prioritat:** 🟢 ALTA (UX immediata)
- **Esforç:** 30 min
- **Estat:** ⬜ Dissenyat

Mostrar % de context window usat després de cada turn:
```
[1234 in / 567 out · 45% ctx]
```
Color: 🟢 <60%, 🟡 60-80%, 🔴 >80%

**Fitxers:** `context.js` (+`usagePercent()`), `repl.js` (L234-237)

---

### 2. CLAUDE.md Memory Hierarchy
- **Prioritat:** 🔴 CRÍTICA (killer feature)
- **Esforç:** 1h
- **Estat:** ⬜ Dissenyat

Jerarquia de fitxers CLAUDE.md (menor → major prioritat):
```
~/.claude/CLAUDE.md              ← user (ja existeix!)
~/.claudia/CLAUDE.md             ← user (alt)
<workspace>/CLAUDE.md            ← project
<workspace>/.claude/CLAUDE.md    ← project (alt)
~/.claudia/CLAUDE-managed.md     ← corporate (immutable)
```

Prepend al system prompt. Sobreviu compaction (re-read cada turn).

**Fitxers:** `memory-files.js` (NOU), `system-prompt.js`, `repl.js` (banner), `tests/unit/memory-files.test.js` (NOU)

---

### 3. Git Tools (read-only)
- **Prioritat:** 🟡 ALTA
- **Esforç:** 1h 20min
- **Estat:** ⬜ Dissenyat

3 tools natius read-only, tier 1 (auto-allowed):

| Tool | Descripció |
|------|-----------|
| `git_diff(staged?, path?, ref?, stat?)` | Canvis unstaged/staged/entre refs |
| `git_status()` | Branch + staged/unstaged/untracked |
| `git_log(count?, path?)` | Historial de commits |

Avantatge vs `bash("git diff")`: discoverable, structured output, auto-allowed, read-only safe.

**Fitxers:** `tools/git.js` (NOU), `tools/index.js`, `permissions.js`, `system-prompt.js`, `tests/unit/git.test.js` (NOU)

---

### 4. Diff Preview per edit/write
- **Prioritat:** 🟡 ALTA
- **Esforç:** 1h 50min
- **Estat:** ⬜ Dissenyat

Mostrar unified diff colorit al terminal després de cada edit/write:
```
✓ edit
  --- a/src/foo.js
  +++ b/src/foo.js
  @@ -3,3 +3,3 @@
   import { bar } from './bar.js';
  -const x = 1;
  +const x = 42;
   export default x;
```

Post-aplicació (informatiu). Preview interactiu (pre-aplicació amb [y/n]) és futur.

**Fitxers:** `diff.js` (NOU), `tools/edit.js`, `tools/write.js`, `agent.js` (printStep), `tests/unit/diff.test.js` (NOU)

---

## 📋 Backlog (futur)

| Feature | Esforç | Notes |
|---------|--------|-------|
| `/init` command | 1h | Genera CLAUDE.md a partir del projecte |
| Git auto-commit | 2h | Commit automàtic després d'edits (opt-in) |
| Background tasks / multi-agent | 8h | `/background` per tasques paral·leles |
| MCP server connections | 4h | Connect to external MCP servers |
| Web search tool | 2h | `WebSearch` natiu |
| Notebook/REPL tool | 3h | Executar Python/JS inline amb output |
| Vim/Emacs keybindings | 1h | readline config |
| `.claude/rules/*.md` | 2h | Conditional rules amb `paths:` frontmatter |
| Hooks (pre/post tool) | 3h | Deterministic actions around tool calls |
| Interactive diff preview | 4h | Confirm [y/n] before applying edits |

---

## 📊 Estat del codebase

- **Tests:** 69/69 ✅
- **Fitxers src/:** 15 (agent, attach, auth, brain/client, commands/loader, context, llm, permissions, render, repl, router, session, system-prompt, tools/*)
- **Tools:** 9 (read, write, edit, bash, glob, grep, brain_search, brain_remember, run_command)
- **Lines of code:** ~2800
- **Last push:** `114aceb` → `main`
