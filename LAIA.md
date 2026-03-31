# LAIA — Project Context

> **LAIA** (Local AI Agent) — Fork de [Claudia](https://github.developer.allianz.io/jordi-tribo/claudia),
> enfocada en self-evolution i memòria avançada.

---

## Identitat

| Camp | Valor |
|------|-------|
| **Nom** | LAIA |
| **Repo** | [github.com/joridx/laia](https://github.com/joridx/laia) |
| **Clone local** | `/home/yuri/laia/` |
| **Origen** | Fork de Claudia (`github.developer.allianz.io/jordi-tribo/claudia`) |
| **Autor** | Jordi Tribó (`joridx`) |
| **Llicència** | Privada (TODO: decidir) |
| **Llenguatge** | JavaScript (ESM, Node.js ≥24) |
| **Creació** | 2026-03-31 |

---

## Relació amb Claudia

- **Claudia** = agent CLI corporatiu (Allianz). Repo origin a GitHub Enterprise.
- **LAIA** = fork personal públic amb focus en **self-evolution** del brain i l'agent.
- El codi base és idèntic al moment del fork (v1.1.0, commit `ed36af9`).
- LAIA divergirà amb les features de V4 (Brain Evolution Plan).

### Remotes al repo local de Claudia

```
origin  → github.developer.allianz.io/jordi-tribo/claudia.git  (corporate)
laia    → github.com/joridx/laia.git                            (personal)
```

⚠️ **Warning**: Quan es commiteja a `/home/yuri/claude/claudia`, cal fer push a **ambdós** remotes.

El clone independent a `/home/yuri/laia/` treballa directament contra el remote `origin → github.com/joridx/laia.git`.

---

## Stack Tècnic

| Component | Tecnologia |
|-----------|-----------|
| Runtime | Node.js 24+ (ESM) |
| LLM Providers | GitHub Copilot, Anthropic, OpenAI, Ollama, GenAI Lab |
| Brain/Memory | **`packages/brain/`** — MCP server integrat, SQLite FTS + embeddings 384d + knowledge graph |
| Brain Data | **`joridx/laia-data`** — repo independent (`~/laia-data/`) |
| Tools | 14 built-in (read, write, edit, bash, glob, grep, brain×3, run_command, git×3, agent) |
| Skills | 36 (.md-based, compatible Claude Code) |
| Tests | 155 cases, 11 files + 9500 LOC brain tests |
| LOC | ~4400 (src/) + ~13200 (packages/brain/) |
| Dependencies | Minimal: `fast-glob`, `@modelcontextprotocol/sdk`, `yaml`, `@huggingface/transformers`, `zod` |

---

## Roadmap V4 — Brain Evolution

> Document complet: [`docs/2026-03-31-brain-evolution-plan.md`](docs/2026-03-31-brain-evolution-plan.md)
> Inspirat per: [ghostwright/phantom](https://github.com/ghostwright/phantom) (self-evolution engine)
> Revisat per: GPT-5.3-Codex + Claude Opus 4.6

| Sprint | Feature | Esforç | Status |
|--------|---------|--------|--------|
| **1** | **Procedural Memory** — type `procedure`, trigger_intents, steps, outcome tracking | 8h | 🔲 TODO |
| **1** | **Golden Suite Lite** — `protected: true`, decay immunity, auto-promotion | 6h | 🔲 TODO |
| **2** | **Post-Session Reflection** — `brain_reflect_session`, confidence-gated, anti-spam | 14h | 🔲 TODO |
| **3** | **Quality Scorecard** — composite score, sparkline trends, alerts | 8h | 🔲 TODO |
| **4** | **Evolved System Prompt** — `~/.claudia/evolved/`, compiled dual-layer | 16h | 🔲 TODO |
| Future | **Evaluation Harness** — replay corpus, rubrics, regression | 20h+ | 🔲 DEFERRED |

**Total estimat: ~52h (4 sprints) + 20h+ futur**

---

## Decisions Clau

### Què copiem de Phantom i què no

| De Phantom | Copiem? | Raó |
|-----------|---------|-----|
| Procedural Memory (episòdic/semàntic/procedimental) | ✅ | Brain actual és flat, no distingeix fets de procediments |
| Post-session reflection amb LLM | ✅ | `brain_log_session` actual és passiu, no extreu insights |
| Evolved config (persona, strategies) | ✅ | CLAUDE.md és estàtic, no evoluciona |
| Auto-rollback per mètriques | ✅ Lite | Alert, no auto-rollback (som single-user) |
| Triple-judge safety voting | ❌ | Overkill per single-user |
| Constitution immutable | ❌ | No necessari sense multi-tenant |
| 5-gate enterprise governance | ❌ | Complexitat innecessària |
| Dynamic tool creation (MCP runtime) | ❌ | Skills .md ja cobreixen el cas d'ús |

### Ordre d'implementació (consensuat amb Codex)

1. **Procedural Memory** → ROI immediat, menys risc
2. **Golden Suite Lite** → Protecció contra pèrdua de coneixement
3. **Post-Session Reflection** → Aprenentatge automàtic
4. **Quality Scorecard** → Instrumentació
5. **Evolved System Prompt** → Auto-personalització (depèn de 1-4)

---

## Pendent de Rebranding

- [ ] `package.json` → name: "laia"
- [ ] `bin/claudia.js` → `bin/laia.js`
- [ ] README.md → Nou README per LAIA
- [ ] System prompt → Identitat "LAIA" en lloc de "Claudia"
- [ ] Skill references → Actualitzar paths si divergeixen

---

## Historial

| Data | Acció |
|------|-------|
| 2026-03-31 | Fork creat des de Claudia v1.1.0 (commit `ed36af9`) |
| 2026-03-31 | Brain Evolution Plan escrit (570 línies, 4 sprints) |
| 2026-03-31 | Revisió amb GPT-5.3-Codex — reordenat prioritats |
