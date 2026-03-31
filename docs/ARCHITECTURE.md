# LAIA — Architecture Deep Dive

> Document generat per auto-exploració del codebase el 2026-03-31.
> Objectiu: servir com a input per a una LLM externa que analitzi punts forts, debilitats i oportunitats.

---

## 1. Visió General

**LAIA** (Local AI Agent) és un agent CLI autònom amb memòria evolutiva, escrit en JavaScript (ESM, Node.js ≥24). Fork de Claudia (agent corporatiu intern d'Allianz), divergit amb un pla de "Brain Evolution" (V4) de 4 sprints inspirat en [phantom](https://github.com/ghostwright/phantom).

| Mètrica | Valor |
|---------|-------|
| LOC agent (`src/`) | ~8.000 |
| LOC brain (`packages/brain/`) | ~14.700 |
| LOC providers (`packages/providers/`) | ~300 |
| LOC total | ~23.000 |
| Tests | 287 cases, 59 suites |
| Temps tests | ~1.9s |
| Dependències directes | 6 (`fast-glob`, `@modelcontextprotocol/sdk`, `yaml`, `@huggingface/transformers`, `zod`, `better-sqlite3`) |
| Node.js runtime | ≥24 (ESM, global fetch, native test runner) |

---

## 2. Arquitectura de Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        bin/laia.js                              │
│   Entry point: argv parse, config load, REPL o one-shot        │
└─────────────┬───────────────────────────────────────────────────┘
              │
      ┌───────┴───────┐
      │   src/repl.js  │  ← REPL interactiu (readline, keypresses, banner)
      │                │     Delegant a mòduls extractats:
      │  repl/         │
      │  ├─ turn-runner.js    Execució unificada d'un torn (pre/post hooks V4)
      │  ├─ slash-commands.js 28 slash commands (/save, /load, /model, /reflect...)
      │  ├─ ui.js             Banner animat, follow-up suggestions
      │  └─ feedback.js       Post-turn brain relevance feedback
      └───────┬───────┘
              │
      ┌───────┴───────┐
      │  src/agent.js  │  ← Agentic loop: input → LLM → tool_calls → LLM → text
      │                │     Crea LLM client, system prompt, tool schemas
      │                │     Swarm: batch dispatcher per a parallel agent()
      └───┬───────┬───┘
          │       │
    ┌─────┴──┐ ┌──┴─────────────┐
    │ LLM    │ │ Tool Registry   │
    │ Layer  │ │ (tools/index.js)│
    └────────┘ └─────────────────┘
```

### 2.1 LLM Layer (`src/llm.js` — 619 LOC)

- **Dual endpoint**: `/responses` (Codex models) + `/chat/completions` (Claude, GPT-5.x)
- **SSE streaming** amb parser custom (`parseSSEStream`)
- **Retry logic** amb backoff exponencial (3 retries)
- **Timeout**: 300s per defecte, reset per chunk en streaming
- **Multi-provider**: Via `@laia/providers` (shared amb brain)
- **Agentic loop** (`runAgentTurn`): max 100 tool iterations, stop on text response

### 2.2 Provider Registry (`packages/providers/` — 301 LOC)

Registre compartit entre agent i brain. Transport-agnostic (resol *què* cridar, no *com*).

| Provider | Auth | Endpoint | Ús |
|----------|------|----------|-----|
| `copilot` | Token exchange (VS Code apps.json) | `api.business.githubcopilot.com` | Principal per agent |
| `openai` | Bearer (`OPENAI_API_KEY`) | `api.openai.com/v1` | Alternatiu |
| `anthropic` | x-api-key | `api.anthropic.com/v1` | Messages API |
| `azure_openai` | Bearer | Custom URL | Enterprise |
| `ollama` | None | `localhost:11434` | Local models |
| `bedrock` | AWS SigV4 (via CLI) | AWS Regional | Brain fallback |
| `genailab` | Browser CDP (Edge) | Internal SSO | Brain last resort |

**Detecció automàtica** per model name: `claude-*` → `copilot`, `gpt-*` → `copilot`, `llama-*` → `ollama`, etc.

### 2.3 Router (`src/router.js` — 180 LOC)

Auto-router per torn que selecciona el model basat en el contingut de l'input:

- **Corporate keywords** (confluence, jira, teams...) → `claude-opus-4.6`
- **Coding keywords** (debug, fix, refactor...) → `gpt-5.3-codex`
- **Quick** (<60 chars, no keywords) → `gpt-5-mini`
- **Stickiness**: 2 torns de persistència del domini anterior
- **Fuzzy matching**: edit distance 1 per typos en keywords corporatius
- Activat amb `--model auto` o `/model auto`

### 2.4 Tool System (`src/tools/` — 13 fitxers)

**Registre dinàmic** amb `createToolRegistry()`: Map<name, {schema, execute}>, congel·lable post-bootstrap.

| Tool | Fitxer | LOC | Tier |
|------|--------|-----|------|
| `read` | read.js | ~80 | Auto |
| `write` | write.js | ~70 | Session |
| `edit` | edit.js | ~150 | Session |
| `bash` | bash.js + bash-compact.js | ~170 | Session |
| `glob` | glob.js | ~40 | Auto |
| `grep` | grep.js | ~60 | Auto |
| `git_diff`, `git_status`, `git_log` | git.js | ~120 | Auto |
| `brain_search`, `brain_remember`, `brain_get_context`, `brain_log_session`, `brain_reflect_session` | brain.js | ~100 | Mixed |
| `run_command` | command.js | ~80 | Auto |
| `agent` | agent.js | ~269 | Session |
| `outlook_*` | outlook.js | ~223 | Lazy-loaded |

**Permisos (3 tiers)**:
- **Tier 1 (Auto)**: read, glob, grep, git_*, brain_search, brain_get_context, run_command
- **Tier 2 (Session)**: write, edit, bash, brain_remember, agent — ask once, remember per session
- **Tier 3 (Confirm)**: reservat per futures high-risk

### 2.5 Swarm System (`src/swarm.js` — 76 LOC + `src/tools/agent.js` — 269 LOC)

- **Semàfor** amb concurrència 4 per `agent()` calls en paral·lel
- **Batch dispatcher**: si totes les tool calls d'un batch són `agent` → parallel. Mixed → sequential.
- **Worker agents**: fresh context window, sub-system prompt, max recursion depth 3
- **Profiles** (`~/.laia/agents/*.yml`): model override, allowed tools, timeout, custom prompt
- **Memory prefetch**: opcionalment injecta learnings rellevants al worker context

### 2.6 System Prompt (`src/system-prompt.js` — 263 LOC + `src/evolved-prompt.js` — 393 LOC)

**Composable**: 10+ seccions pures (cadascuna retorna string o null), compostes per `buildSystemPrompt()`:

1. `memorySection()` — LAIA.md files (user + project)
2. `identitySection()` — Nom, runtime, datetime
3. `toolsSection()` — Documentació eines disponibles
4. `skillsPolicySection()` — CRITICAL: corporate tool policy
5. `multiModelSection()` — Second opinion via bash
6. `rulesSection()` — Core rules + tool-use + code-edit + safety
7. `evolvedSection()` — **V4**: compiled from brain learnings

**Evolved Prompt** (V4 Sprint 4):
- **Dual-layer**: Stable (manually confirmed, never expire) + Adaptive (auto-compiled, 30-day expiry)
- **4 fitxers**: `user-preferences.md`, `task-patterns.md`, `error-recovery.md`, `domain-knowledge.md`
- **Safety**: max 50 lines/section, 200 lines total, 16K char cap, anti-injection sanitization
- **Audit trail**: `_evolution-log.jsonl`

### 2.7 Context Management (`src/context.js` — 155 LOC)

- **Turn-based**: almacena transcripcions completes (tool calls + results + reply)
- **Compaction**: últims 6 torns en full detail; antics → only user+assistant text
- **Token budgeting**: 300K max tokens, threshold 80% per trigger compaction
- **Truncation**: tool results capped a 3000 chars
- **Serialization**: serialize/deserialize per session persistence

### 2.8 Session Persistence (`src/session.js` — 183 LOC)

- **Autosave**: cada torn guarda a `~/.laia/sessions/_autosave.json`
- **Named saves**: `/save <name>` → `~/.laia/sessions/2026-03-31T15-10_name.json`
- **Fork**: `/fork <session>` → copia amb nou sessionId
- **Atomic writes**: write to tmpfile + rename (anti-corruption)
- **Restore**: per index, partial name match, o path directe

### 2.9 Skills System (`src/skills.js` — 362 LOC)

- **V3 Skills**: `~/.laia/skills/*/SKILL.md` (directory-based with frontmatter)
- **Legacy commands**: `~/.laia/commands/*.md` (flat files, auto-wrapped)
- **Frontmatter schema**: `name`, `description`, `invocation`, `context`, `allowed-tools`, `argument-hint`
- **Placeholder resolution**: `{{user.name}}`, `{{env.VAR}}` → from `~/.laia/user.json` + env
- **Cache**: 5s TTL amb fingerprint (mtime + count)
- **36 skills** per integració amb Jira, Confluence, Teams, Jenkins, GitHub, etc.

---

## 3. Brain Server (`packages/brain/` — 14.700 LOC)

El brain és un **MCP server independent** que es comunica amb l'agent via JSON-RPC sobre stdio. Separat arquitectònicament per:
1. Reusabilitat (pot ser usat per Claude Code via MCP)
2. Aïllament (crash del brain no mata l'agent)
3. Testabilitat (>40 test suites independents)

### 3.1 Database Layer (`database.js` — 1840 LOC)

- **SQLite + FTS5** via `better-sqlite3` (optional dependency, graceful degradation)
- **Schema v4** amb 10+ taules:
  - `learnings_fts` — Full-text search amb BM25 (title×3, headline×2, body×1, tags×1.5)
  - `files_fts` — FTS per notes/sessions
  - `concept_activations` — Spreading activation graph
  - `learning_embeddings` — 384d vectors (Float32, BLOB)
  - `session_quality` — Quality scorecard per sessió
  - `meta_kv` — Key-value store per metadata
  - `metrics` — Search/tag hit counters
  - `export_state`, `change_log` — Dual-write audit
- **Repos pattern**: `metaRepo`, `metricsRepo`, `graphRepo` — abstracció sobre SQLite KV
- **Dual-write hooks**: JSON files + SQLite en sync (JSON com a source of truth per git)
- **Self-heal**: si DB corrupta → delete + recreate automàticament

### 3.2 Search Engine (`search.js` — 495 LOC)

Pipeline de cerca multi-signal:

```
Query → Intent Classification → Token Expansion (graph + semantic)
      → BM25 (FTS5) + Token Matching + Graph Boost + Embedding Similarity
      → RRF Fusion → Vitality Weighting → Rerank (LLM optional) → Top-K
```

Signals:
1. **BM25** via SQLite FTS5
2. **Token matching** amb stem-aware fuzzy (Porter stemming)
3. **Graph expansion** via knowledge graph neighbors + PageRank
4. **Spreading activation** (cognitive model)
5. **Embedding similarity** (384d cosine, `@huggingface/transformers` local)
6. **Vitality** (ACT-R model: recency × frequency × structural boost)
7. **Intent classification** (factual, procedural, warning, exploratory...)
8. **Type prior** (principle > pattern > warning > learning)
9. **Feedback score** (user relevance feedback acumulat)
10. **Trigger intents** (V4: procedural memory matching)
11. **RRF fusion** (Reciprocal Rank Fusion de múltiples signals)

### 3.3 Scoring Engine (`scoring.js` — 567 LOC)

- **ACT-R cognitive model**: `B = ln(n/(1-d)) - d*ln(L)` normalitzat amb sigmoid
- **Vitality zones**: active (>0.6), stale (>0.3), cold (>0.15), fading (<0.1)
- **Type-aware decay**: warnings decauen 8%/mes, principles 2%/mes
- **Type vitality floors**: principles mai baixen de 0.40
- **PageRank** sobre knowledge graph per structural importance
- **Spreading activation** amb decay temporal
- **11 passes de scoring** (S1-S11) amb pesos configurables

### 3.4 Embeddings (`embeddings.js` — ~200 LOC)

- **Model**: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dimensions, 50+ idiomes)
- **Runtime**: ONNX via `@huggingface/transformers` (WASM backend, zero cost)
- **Cache**: SQLite (`learning_embeddings` taula), in-memory Map per search
- **Hash-based dedup**: només re-computa si contingut canvia
- **Init timeout**: 15s, singleflight (una sola inicialització)

### 3.5 Knowledge Graph (`graph.js` — 421 LOC)

- **Conceptes**: tags i entitats extretes de learnings
- **Relacions**: `related_to`, `parent`, `children` (bidireccionals)
- **PageRank**: calculat sobre el graf per ponderar importància estructural
- **Spreading activation**: boosts des de conceptes activats recentment
- **Storage**: `relations.json` (git-tracked) + SQLite mirror

### 3.6 LLM Enhancement (`llm.js` — 1563 LOC)

El brain té el seu propi layer LLM per tasques internes:

| Task | Model | Budget | Descripció |
|------|-------|--------|------------|
| `rerank` | gpt-4o-mini | 2 | Reordenar resultats semànticament |
| `expand` | gpt-4o-mini | 1 | Generar termes de cerca relacionats |
| `autotags` | gpt-4o-mini | 1 | Suggerir tags per learnings nous |
| `duplicate` | gpt-4o-mini | 1 | Detectar duplicats |
| `distill` | gpt-5.3-codex | 4 | Destil·lar principis de clusters |
| `compact` | gpt-5.3-codex | 3 | Merge de learnings similars |
| `assess` | gpt-4o-mini | 0.5 | Avaluar qualitat d'un learning |
| `reflection` | configurable | 2 | Post-session reflection |

**Provider chain**: Copilot → Bedrock (Claude Haiku) → GenAI Lab (browser CDP)
**Circuit breaker**: 3 errors consecutius → disabled 5 min → half-open retry
**Budget**: 1000 units/sessió amb warning al 80%

### 3.7 Brain Tools (16 MCP tools)

| Tool | LOC | Descripció |
|------|-----|------------|
| `brain_search` | ~200 | Multi-signal scored search |
| `brain_remember` | 426 | Store learning amb dedup, contradiction check, auto-tags |
| `brain_get_context` | 328 | Recuperar context (prefs, recent sessions, relevant learnings) |
| `brain_log_session` | ~200 | Log sessió amb quality scorecard |
| `brain_health` | 1053 | Dashboard complet (stats, quality trends, evolved prompt info) |
| `brain_reflect_session` | 380 | LLM-powered post-session analysis (7 safeguards) |
| `brain_compile_evolved` | ~200 | Compilar evolved prompt des de learnings |
| `brain_feedback` | ~150 | User relevance feedback per search results |
| `brain_distill` | ~200 | Destil·lar principis de clusters |
| `brain_index_notes` | 493 | Indexar notes/fitxers externs |
| `brain_check_action` | ~100 | Verificar si una acció és segura |
| `brain_update_project` | ~100 | Actualitzar metadata de projecte |
| `brain_ingest_confluence` | ~100 | Importar pàgines de Confluence |
| `brain_todo` | ~100 | TODO management |
| `brain_web_search` | ~100 | Web search (experimental) |
| `brain_get_learnings` | ~100 | Llistar learnings filtrats |

### 3.8 Quality Scorecard (`quality.js` — 139 LOC)

Mètrica composta per sessió (1-10):

```
score = 10
if !task_completed: score -= 4
if rework_required: score -= 2
score -= min(user_corrections × 0.5, 2)
score -= min(tool_errors × 0.3, 1.5)
if satisfaction == "low": score -= 1
if satisfaction == "medium": score -= 0.5
```

- **Sparkline trends**: `▁▂▃▄▅▆▇█`
- **Alert**: 3 sessions consecutives < 6 → warning
- **Storage**: SQLite `session_quality` taula

### 3.9 Reflection (`reflection-llm.js` + `tools/brain-reflect-session.js`)

Post-session LLM analysis amb **7 safeguards**:
1. Confidence gating (>0.7 per auto-save)
2. Evidence grounding (citations required)
3. Dedup against existing learnings
4. Anti-spam (max 5 learnings per reflection)
5. Contradiction check
6. Type validation
7. Mockable LLM bridge per tests

### 3.10 Maintenance (`maintenance.js` — 758 LOC)

- **Migration**: flat learnings → structured frontmatter
- **Distillation**: cluster learnings per tags → draft principles
- **Compression**: merge similar learnings
- **Vitality cleanup**: archive fading learnings
- **Schema validation**: validate JSON/YAML consistency

### 3.11 Data Storage (`~/laia-data/`)

Git-tracked repo independent:

```
~/laia-data/
├── memory/
│   ├── learnings/          ← .md files amb frontmatter (learning, warning, pattern, procedure, principle)
│   ├── sessions/           ← Session logs
│   ├── knowledge/          ← Knowledge base (people, projects, notes)
│   └── archive/            ← Archived (fading vitality) learnings
├── relations.json          ← Knowledge graph
├── metrics.json            ← Hit counters
├── distillation_state.json ← Distillation tracking
├── learnings-meta.json     ← Metadata (V4 columns: hit_count, last_hit, protected, etc.)
└── .brain.db               ← SQLite cache (FTS5 + embeddings + quality)
```

---

## 4. Data Flow

### 4.1 Turn Lifecycle

```
User Input
    │
    ├─ Router: classify domain (corporate/coding/quick)
    ├─ Select model (auto mode)
    │
    ▼
executeTurn()
    │
    ├─ Pre-turn hook (V4: scorecard start)
    ├─ context.addUser(input)
    ├─ undoStack.startTurn()
    │
    ▼
runTurn() → agent.js
    │
    ├─ buildSystemPrompt() ← includes evolved prompt
    ├─ getToolSchemas() ← filtered if planMode
    │
    ▼
runAgentTurn() → llm.js (agentic loop)
    │
    ├─ LLM call (streaming)
    ├─ While tool_calls:
    │   ├─ checkPermission(tool, args)
    │   ├─ executeTool(tool, args)  ← or batch dispatch for agent()
    │   ├─ Track file for undo + autocommit
    │   ├─ Log tool stats
    │   └─ LLM call with tool results
    │
    ▼
Return { text, usage, turnMessages }
    │
    ├─ Render markdown
    ├─ undoStack.commitTurn()
    ├─ context.addTurn(text, turnMessages)
    ├─ autoCommitter.commitIfNeeded()
    ├─ Post-turn hook (V4: reflection, feedback)
    ├─ sendFeedback() (fire-and-forget)
    ├─ Update router stickiness
    ├─ Show follow-up suggestions
    └─ Token accounting + context % display
```

### 4.2 Brain Communication

```
Agent (src/brain/client.js)
    │
    ├─ createBrainConnection() → spawn child process
    ├─ MCP Client (JSON-RPC/stdio)
    │   ├─ 30s timeout per call
    │   ├─ Auto-reconnect (3 attempts, backoff)
    │   └─ Concurrency guard (single pending connect)
    │
    ▼
Brain Server (packages/brain/index.js)
    │
    ├─ StdioServerTransport
    ├─ registerAllTools() → 16 tools
    ├─ DB write hooks → dual-write JSON+SQLite
    ├─ Embedding warmup at startup
    └─ Schema validation on first load
```

---

## 5. Configuration & Extensibility

### 5.1 Config Chain

```
Defaults (src/config.js)
  ← ~/.laia/config.json (file overrides)
    ← LAIA_MODEL env var
      ← --model CLI flag
        ← /model REPL command
          ← Router auto-selection (per turn)
```

### 5.2 Extension Points

| Extension | Mecanisme | Ubicació |
|-----------|-----------|----------|
| **Skills** | .md files amb frontmatter | `~/.laia/skills/*/SKILL.md` |
| **Commands** | .md flat files (legacy) | `~/.laia/commands/*.md` |
| **Agent profiles** | .yml files | `~/.laia/agents/*.yml` |
| **Evolved prompt** | Auto-compiled from brain | `~/.laia/evolved/*.md` |
| **Providers** | Registre a `PROVIDERS` | `packages/providers/` |
| **Brain tools** | MCP tool modules | `packages/brain/tools/` |
| **LLM config** | JSON config | `packages/brain/llm-config.json` |

### 5.3 REPL Slash Commands (28)

| Category | Commands |
|----------|----------|
| Session | `/save`, `/load`, `/sessions`, `/fork`, `/clear`, `/compact` |
| Config | `/model`, `/effort`, `/plan`, `/execute`, `/tokens` |
| Files | `/attach`, `/detach`, `/attached` |
| Agents | `/agents`, `/swarm` |
| Skills | `/skills` |
| System | `/help`, `/autocommit`, `/undo`, `/reflect`, `/exit`, `/quit` |

---

## 6. Test Architecture

### 6.1 Test Stack

- **Runner**: Node.js native test runner (`node --test`)
- **Framework**: `node:test` + `node:assert`
- **No external deps**: zero test dependencies
- **Parallel suites**: brain tests run via custom `tests/run.js`

### 6.2 Test Coverage

| Component | Suites | Tests | Focus |
|-----------|--------|-------|-------|
| Agent (`tests/unit/`) | 11 | ~100 | Edit, diff, SSE, swarm, permissions, registry, sessions |
| Agent (`tests/`) | 6 | ~40 | Evolved prompt, git-commit, paste, providers, quality, undo |
| Brain (`packages/brain/tests/`) | 42 | ~150 | Scoring, search, embeddings, database, regression, integration |
| **Total** | **59** | **287** | |

### 6.3 Test Highlights

- **Ablation tests**: verify each scoring signal contributes positively
- **Regression tests**: known queries → expected ranking positions
- **Performance bench**: `perf-bench.js` per search latency
- **Failure tests**: corrupt JSON, empty dirs, missing deps
- **Integration tests**: full pipeline with real SQLite

---

## 7. Security Model

| Layer | Mecanisme |
|-------|-----------|
| **Tool permissions** | 3-tier (auto/session/confirm), serialized prompt queue |
| **Evolved prompt** | Anti-injection sanitization, line/char caps |
| **Plan mode** | Server-side enforcement, blocks write/edit/bash even if model emits |
| **Brain** | Isolated process (crash doesn't kill agent) |
| **Auth** | Token never exposed; Copilot token cached 25min, rotated |
| **Sessions** | Atomic writes (tmpfile + rename) |
| **DB** | Self-healing corruption detection + delete+recreate |

---

## 8. Performance Characteristics

| Operation | Typical Latency | Notes |
|-----------|-----------------|-------|
| Startup (REPL) | ~1.5s | Brain + tools + banner in parallel |
| Brain connect | ~700ms | MCP stdio spawn + handshake |
| Tool register | ~270ms | All 16+ tools |
| Brain search | ~50-200ms | Depends on corpus size + embedding availability |
| Embedding init | ~5-15s | First load only (ONNX model) |
| Single embedding | ~20-50ms | After init |
| FTS5 query | ~5ms | SQLite BM25 |
| Test suite | ~1.9s | 287 tests, 59 suites |
| LLM first token | 1-5s | Depends on provider + model |

---

## 9. Dependency Graph

```
laia (root)
├── @laia/providers (local)          ← Shared provider registry
│   └── (no deps)
├── @laia/brain (local)              ← MCP Brain server
│   ├── @laia/providers (local)
│   ├── @modelcontextprotocol/sdk
│   ├── @huggingface/transformers    ← ONNX embeddings
│   ├── zod                          ← Schema validation
│   └── better-sqlite3 (optional)    ← SQLite + FTS5
├── @modelcontextprotocol/sdk        ← MCP client
├── fast-glob                        ← File discovery
└── yaml                             ← YAML parsing (skills)
```

**Total node_modules footprint**: primarily `@huggingface/transformers` (ONNX runtime) and `better-sqlite3` (native C++ addon). Everything else is minimal.

---

## 10. Unique Design Decisions

### 10.1 MCP per Brain Communication

El brain no és una library importada directament — és un **MCP server** que corre com a child process. Això aporta:
- **Aïllament de falles**: un crash del brain no mata la sessió
- **Reutilització**: Claude Code pot connectar-se al mateix brain via MCP
- **Versionat independent**: brain pot evolucionar sense tocar l'agent
- **Protocol estàndard**: JSON-RPC sobre stdio, introspectible

**Tradeoff**: ~700ms latència d'arrancada, overhead de serialització JSON per cada tool call.

### 10.2 Dual-Write (JSON + SQLite)

Tot el brain data es persiteix en dos llocs:
- **JSON/Markdown files** → git-tracked, human-readable, portable
- **SQLite** → FTS5, embeddings, fast queries

El JSON és la **source of truth** (git-diffable), SQLite és un **index/cache** que es pot reconstruir.

### 10.3 Cognitive Models (ACT-R)

El scoring usa ACT-R (Adaptive Control of Thought—Rational) per modelar:
- **Recency decay**: informació vella perd rellevància
- **Frequency boost**: informació accedida sovint guanya pes
- **Structural importance**: PageRank sobre knowledge graph

### 10.4 Zero-Cost Local Embeddings

384d multilingual embeddings via ONNX (WASM), sense cap API call. Tots els vectors es calculen localment i es cachegen a SQLite. Cost: $0.

### 10.5 Evolved System Prompt

El system prompt no és estàtic — es **compila automàticament** des dels learnings del brain:
- Preferències d'usuari → afecten to i estil
- Patrons de tasques → optimitzen workflow
- Warnings → prevenen errors recurrents
- Dual-layer amb expiry temporal (30 dies) per evitar drift

### 10.6 Skills com a Markdown

Integracions amb 30+ serveis corporatius definides com a fitxers `.md` amb frontmatter YAML. L'LLM llegeix el contingut del skill i genera les comandes bash/curl necessàries. Zero codi per skill — només text instructiu.

---

## 11. Números Clau

| Mètrica | Valor |
|---------|-------|
| Fitxers JS (src/) | 44 |
| Fitxers JS (brain/) | 48 |
| Brain MCP tools | 16 |
| Agent tools | 16 |
| REPL slash commands | 28 |
| Skills disponibles | ~36 |
| Scoring signals | 11 |
| Providers suportats | 7 |
| Max tool iterations/turn | 100 |
| Max worker recursion | 3 |
| Worker concurrency | 4 |
| Context window | 300K tokens |
| Evolved prompt cap | 200 lines / 16K chars |
| Session quality scale | 1-10 |
| Brain LLM tasks | 8 |
| Brain LLM budget/session | 1000 units |
| Embedding dimensions | 384 |
| Embedding languages | 50+ |
| SQLite FTS5 BM25 weights | title×3, headline×2, body×1, tags×1.5 |

---

*Document generat automàticament per LAIA explorant el seu propi codebase. Actualitzar manualment si l'arquitectura canvia significativament.*
