# LAIA

**Local AI Agent with self-evolving memory.**

An autonomous CLI coding agent that learns from every session — built on Node.js with a composable brain architecture that adapts to your workflows, preferences, and domain knowledge over time.

Fork of [Claudia](https://github.developer.allianz.io/jordi-tribo/claudia) with a focus on **brain evolution**: procedural memory, post-session reflection, quality tracking, and auto-compiled prompt personalization.

---

## ✨ What Makes LAIA Different

| Feature | Traditional Agent | LAIA |
|---------|------------------|------|
| **Memory** | Flat key-value store | Typed learnings (procedure, preference, warning, pattern) with vitality decay + knowledge graph |
| **Session End** | "Done." | LLM-powered reflection extracts corrections, preferences, and errors automatically |
| **Prompt** | Static CLAUDE.md | Evolved prompt compiled from memory — dual-layer (Stable + Adaptive with 30-day expiry) |
| **Quality** | No tracking | Composite scorecard (1-10) with sparkline trends and degradation alerts |
| **Critical Knowledge** | Can be forgotten | Protected learnings immune to decay — auto-promoted when frequently accessed |
| **Procedures** | Text blobs | Structured steps with trigger intents, preconditions, and success/failure tracking |

---

## 🚀 Quick Start

```bash
# Clone
git clone https://github.com/joridx/laia.git
cd laia
npm install

# Run (requires GitHub Copilot Business license)
node bin/laia.js

# Run with a prompt
node bin/laia.js -p "explain this codebase"

# Run tests
npm test  # 287 tests, 57 suites
```

### Requirements

- **Node.js 24+** (ESM)
- **GitHub Copilot Business** license (for LLM access via Copilot API)
- Optional: AWS Bedrock, Ollama, or other providers

---

## 🧠 Brain Architecture

LAIA's brain is a local MCP server with SQLite, full-text search, 384-dimensional embeddings, and a knowledge graph:

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
│  evolved-prompt.js                              │
│    compileEvolvedPrompt()                       │
│    dual-layer: Stable + Adaptive (30d expiry)   │
└─────────────┬──────────────────────────────────┘
              │ MCP (stdio)
┌─────────────┴──────────────────────────────────┐
│              Brain Server (packages/brain/)      │
│                                                  │
│  SQLite (schema v4, 10 tables)                   │
│  11-pass scoring engine                          │
│  16 tools (search, remember, reflect, compile…)  │
│  LLM-powered: reflection, reranking, distill     │
└──────────────────────────────────────────────────┘
```

### Brain Tools

| Tool | Purpose |
|------|---------|
| `brain_search` | Semantic search with graph expansion, BM25, embeddings, and LLM reranking |
| `brain_remember` | Store learnings with type, tags, procedure metadata, protection |
| `brain_reflect_session` | LLM-powered post-session analysis — extracts corrections, preferences, errors |
| `brain_compile_evolved` | Compile memory into evolved system prompt sections |
| `brain_log_session` | Log session summary with quality scorecard |
| `brain_health` | Full diagnostics: integrity, trends, quality sparkline, embedding stats |
| `brain_feedback` | Rate search results, track procedure outcomes |

---

## 📊 Quality Scorecard

Every session can include a quality assessment:

```
🎯 Quality score: 8.9/10

## Session Quality Trend
- Last 10 sessions: ▆▇▇█▅▇▆▇▇█ (avg: 8.2, last: 9.5)
- Alert: none
```

**Score formula**: starts at 10, subtracts penalties for incomplete tasks (-4), rework (-2), user corrections (-0.5 each, cap 2), tool errors (-0.3 each, cap 1.5), and low satisfaction (-1).

---

## 🛡️ Safety

- **Evidence grounding**: Reflection observations must have evidence present in the transcript
- **Prompt injection defense**: XML fencing for transcripts, `sanitizeForPrompt()` strips role tags from evolved content
- **Confidence gating**: Auto-save only at ≥0.85 confidence, max 3 auto-writes per session
- **Contradiction detection**: Warns when new learnings conflict with protected knowledge
- **Dedup gate**: Prevents duplicate learnings via similarity check
- **Parameterized SQL**: All database operations use `@param` bindings

---

## 🔧 Development

```bash
# Run tests
npm test

# Run a single test file
node --test tests/quality.test.js

# Brain smoke test
LAIA_BRAIN_PATH=~/laia-data node bin/laia.js -p "brain health"
```

### Project Structure

```
laia/
├── bin/laia.js              # Entry point
├── src/
│   ├── system-prompt.js     # Composable prompt builder (10 sections)
│   ├── evolved-prompt.js    # Evolved prompt compiler
│   ├── brain/client.js      # Brain MCP client (timeout, reconnect)
│   ├── turn-runner.js       # Modular turn execution
│   └── ...
├── packages/brain/          # Brain MCP server
│   ├── database.js          # SQLite schema v4
│   ├── scoring.js           # 11-pass scoring engine
│   ├── quality.js           # Quality scorecard
│   ├── reflection-llm.js    # LLM bridge for reflection
│   ├── tools/               # 16 brain tools
│   └── ...
├── tests/                   # 287 tests, 57 suites
└── docs/                    # Architecture docs, evolution plan
```

---

## 📜 Origin

LAIA started as a fork of **Claudia** — a corporate CLI agent for Allianz — with the goal of adding self-evolution capabilities inspired by [ghostwright/phantom](https://github.com/ghostwright/phantom).

The V4 Brain Evolution Plan was designed collaboratively between Claude Opus 4.6 and GPT-5.3-Codex, reviewed bidirectionally, and implemented in a single session (4 sprints, ~1750 LOC, 10 Codex criticals found and fixed).

---

## License

MIT
