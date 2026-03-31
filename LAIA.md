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
| **Llicència** | MIT |
| **Llenguatge** | JavaScript (ESM, Node.js ≥24) |
| **Creació** | 2026-03-31 |

---

## Relació amb Claudia

- **Claudia** = agent CLI corporatiu (Allianz). Repo origin a GitHub Enterprise.
- **LAIA** = fork personal públic amb focus en **self-evolution** del brain i l'agent.
- El codi base és idèntic al moment del fork (v1.1.0, commit `ed36af9`).
- LAIA ha divergit amb les features de V4 (Brain Evolution Plan) — 4 sprints completats.

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
| Tools | 16 built-in (read, write, edit, bash, glob, grep, brain×5, run_command, git×3, agent) |
| Skills | 36 (.md-based, compatible Claude Code) |
| Tests | 287 cases, 57 suites |
| LOC | ~5200 (src/) + ~14800 (packages/brain/) |
| Dependencies | Minimal: `fast-glob`, `@modelcontextprotocol/sdk`, `yaml`, `@huggingface/transformers`, `zod` |

---

## Roadmap V4 — Brain Evolution

> Document complet: [`docs/2026-03-31-brain-evolution-plan.md`](docs/2026-03-31-brain-evolution-plan.md)
> Inspirat per: [ghostwright/phantom](https://github.com/ghostwright/phantom) (self-evolution engine)
> Revisat per: GPT-5.3-Codex + Claude Opus 4.6

| Sprint | Feature | Commits | Tests | Status |
|--------|---------|---------|-------|--------|
| **Pre-V4** | 4 Refactors (TurnRunner, Brain Client, System Prompt, Config) | 5 | 254 | ✅ Done |
| **1** | **Procedural Memory** + **Golden Suite Lite** — `procedure` type, `protected: true`, trigger_intents, outcome tracking, decay immunity | 2 | 254 | ✅ Done |
| **2** | **Post-Session Reflection** — `brain_reflect_session`, LLM-powered, confidence-gated, evidence grounding, anti-spam | 2 | 254 | ✅ Done |
| **3** | **Quality Scorecard** — composite score (1-10), sparkline trends, alerts, `session_quality` SQLite table | 2 | 281 | ✅ Done |
| **4** | **Evolved System Prompt** — `~/.laia/evolved/`, compiled dual-layer (Stable + Adaptive), auto-expiry | 2 | 287 | ✅ Done |
| **Future** | **Evaluation Harness** — replay corpus, rubrics, regression detection | — | — | 🔲 DEFERRED |

**All 4 sprints completed** on 2026-03-31. Each sprint followed: implement → test → E2E → commit → Codex review → fix criticals → commit.

### What's Next (post-V4)

| Priority | Task | Effort |
|----------|------|--------|
| 🔴 | Auto-promotion to Golden (hit≥10 AND appearances≥20) | 1h |
| 🔴 | Contradiction check in brain_remember (not just reflection) | 1h |
| 🟡 | Procedure outcome tracking via brain_feedback | 2h |
| 🟡 | Auto-compile evolved prompt at session end | 1h |
| 🟡 | Port Sprint 1-4 features to Claudia production | 4h |
| 🟢 | `/reflect` and `/evolve` custom commands | 1h |
| 🔵 | Evaluation Harness (needs 50+ sessions with quality data) | 20h+ |

---

## V4 Architecture

```
┌────────────────────────────────────────────────┐
│                  LAIA Agent                     │
│                                                 │
│  system-prompt.js (composable, 10 sections)     │
│    └── evolvedSection() ← ~/.laia/evolved/      │
│         ├── user-preferences.md                 │
│         ├── task-patterns.md                    │
│         ├── error-recovery.md                   │
│         └── domain-knowledge.md                 │
│                                                 │
│  evolved-prompt.js (380 LOC)                    │
│    compileEvolvedPrompt()                       │
│    sanitizeForPrompt() (anti-injection)         │
│    dual-layer: Stable + Adaptive (30d expiry)   │
│                                                 │
│  brain/client.js                                │
│    30s timeout, 3 reconnects, concurrency guard │
│    brainReflectSession()                        │
│    brainCompileEvolved()                        │
│    brainLogSession() + quality scorecard        │
└─────────────┬──────────────────────────────────┘
              │ MCP (stdio)
┌─────────────┴──────────────────────────────────┐
│              Brain Server (packages/brain/)      │
│                                                  │
│  database.js (schema v4, 10 tables)              │
│    session_quality, concept_activations,         │
│    learning_embeddings, learnings (8 V4 cols)    │
│                                                  │
│  scoring.js (11 scoring passes)                  │
│    S9: trigger_intents (+3.0/match)              │
│    S10: procedure confidence (×1.5)              │
│                                                  │
│  quality.js (139 LOC)                            │
│    computeCompositeScore() + analyzeTrend()      │
│    formatSparkline() ▁▂▃▄▅▆▇█                   │
│                                                  │
│  16 tools:                                       │
│    brain_reflect_session (LLM, 7 safeguards)     │
│    brain_compile_evolved (dry_run support)        │
│    brain_log_session (+quality scorecard)         │
│    brain_remember (+procedure +protected)         │
│    brain_search, brain_health, brain_feedback...  │
│                                                  │
│  reflection-llm.js (LLM bridge, mockable)        │
└──────────────────────────────────────────────────┘
```

---

## Decisions Clau

### Què copiem de Phantom i què no

| De Phantom | Copiem? | Raó |
|-----------|---------|-----|
| Procedural Memory (episòdic/semàntic/procedimental) | ✅ Done | Brain actual era flat, no distingia fets de procediments |
| Post-session reflection amb LLM | ✅ Done | `brain_log_session` era passiu, no extreia insights |
| Evolved config (persona, strategies) | ✅ Done | CLAUDE.md era estàtic, no evolucionava |
| Auto-rollback per mètriques | ✅ Lite | Alert via quality scorecard, no auto-rollback (single-user) |
| Triple-judge safety voting | ❌ | Overkill per single-user |
| Constitution immutable | ❌ | No necessari sense multi-tenant |
| 5-gate enterprise governance | ❌ | Complexitat innecessària |
| Dynamic tool creation (MCP runtime) | ❌ | Skills .md ja cobreixen el cas d'ús |

---

## Rebranding Status

- [x] `package.json` → name: "laia"
- [x] `bin/claudia.js` → `bin/laia.js`
- [x] System prompt → Identitat "LAIA"
- [ ] README.md → Nou README per LAIA
- [ ] Skill references → Actualitzar paths si divergeixen

---

## Historial

| Data | Acció |
|------|-------|
| 2026-03-31 | Fork creat des de Claudia v1.1.0 (commit `ed36af9`) |
| 2026-03-31 | Brain Evolution Plan escrit (570 línies, 4 sprints) |
| 2026-03-31 | Revisió amb GPT-5.3-Codex — reordenat prioritats |
| 2026-03-31 | 4 pre-V4 refactors completats (TurnRunner, Brain Client, System Prompt, Config) |
| 2026-03-31 | Sprint 1: Procedural Memory + Golden Suite Lite ✅ |
| 2026-03-31 | Sprint 2: Post-Session Reflection ✅ |
| 2026-03-31 | Sprint 3: Quality Scorecard ✅ |
| 2026-03-31 | Sprint 4: Evolved System Prompt ✅ |
| 2026-03-31 | Memory import: 21 learnings from Claudia brain (selective) |
