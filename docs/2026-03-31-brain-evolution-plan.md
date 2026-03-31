# Brain Evolution Plan — Inspired by Phantom Analysis
**Date**: 2026-03-31
**Status**: Proposed
**Reviewed by**: GPT-5.3-Codex (1 round), Opus 4.6 (main)
**Source**: Analysis of [ghostwright/phantom](https://github.com/ghostwright/phantom) self-evolution engine
**Related**: `knowledge/tools/claudia-brain-v2-proposal-2026-03-22.md`, `ROADMAP.md`

---

## Context

After evaluating Phantom (an AI agent with a 6-step self-evolution pipeline, 5 validation gates, and 6 LLM judges), we identified 5 improvement ideas for Claudia + Brain. After discussion with GPT-5.3-Codex, the priorities were reordered and 3 designs were improved.

**Key insight from Codex**: "Don't copy the flashiest feature (evolved prompt). Build the foundations first (typed memory, structured reflection, quality metrics)."

**Scope**: All changes go to `claude-local-brain/mcp-server/` (Brain) and `claudia/src/` (CLI). No changes to CLAUDE.md format or skill system.

---

## Sprint 1: Procedural Memory + Golden Suite Lite (~14h)

### 1A. Procedural Memory (~8h)

#### Problem
Everything in Brain is a flat "learning". No distinction between a fact ("SSL corporatiu usa proxy") and a procedure ("Per desplegar a Jenkins: 1. push, 2. wait CI, 3. trigger manual"). Procedures get lost in search because they have no special handling.

#### Design

**New learning type: `procedure`** (extends existing `type` enum: learning, pattern, warning, principle, bridge, **procedure**).

**New frontmatter fields** (on procedure-type learnings only):
```yaml
---
type: procedure
title: "Deploy binary-engine to Jenkins"
tags: [jenkins, deploy, binary-engine]
trigger_intents: [deploy, release, jenkins]   # NEW: when to surface this
preconditions: [git-push, tests-pass]          # NEW: what must be true first
steps: 5                                       # NEW: step count (body has numbered steps)
used_count: 0                                  # NEW: times procedure was followed
success_count: 0                               # NEW: times it worked
last_outcome: null                             # NEW: success|failure|partial
last_used: null                                # NEW: ISO date
---
```

**Body format** (human + machine readable):
```markdown
# Deploy binary-engine to Jenkins

## Steps
1. Ensure all tests pass locally: `sbt test`
2. Push to `develop` branch: `git push origin develop`
3. Wait for CI green (Jenkins Blue Ocean dashboard)
4. Navigate to Jenkins > binary-engine > Build with Parameters
5. Select environment: `staging` or `production`

## Notes
- Production deploys require approval from team lead
- If step 3 fails on DEFLATE tests, see warning "DEFLATE compression limitations"

## Expected Outcome
Artifact deployed and health check passing within 5 minutes.
```

#### Implementation

**File: `claude-local-brain/mcp-server/learnings.js`**
- Extend `buildLearningMarkdown()` to emit procedure-specific frontmatter fields
- Extend `parseLearningFrontmatter()` to read new fields (steps, trigger_intents, preconditions, used_count, success_count, last_outcome, last_used)
- Add `updateProcedureOutcome(slug, outcome)` function: increments counters, updates last_used

**File: `claude-local-brain/mcp-server/database.js`**
- Add columns to `learnings` table: `steps INTEGER`, `used_count INTEGER DEFAULT 0`, `success_count INTEGER DEFAULT 0`, `last_outcome TEXT`, `last_used TEXT`, `trigger_intents_json TEXT`, `preconditions_json TEXT`
- Migration v3→v4 (additive ALTER TABLE, non-breaking)

**File: `claude-local-brain/mcp-server/scoring.js`**
- Add `INTENT_PATTERNS.procedural`: detect "how to", "steps to", "process for", "deploy", "install", "configure", "setup", "workflow"
- Add `INTENT_SCOPE_BOOST.procedural`: +2.0 for procedure-type results when intent matches
- Add `trigger_intents` match scoring: if query tokens overlap with `trigger_intents[]`, boost +3.0
- Add procedure confidence bonus: `success_count / (used_count || 1) * 1.5` (proven procedures rank higher)

**File: `claude-local-brain/mcp-server/tools/brain-remember.js`**
- Accept `procedure: true` as shorthand in schema (auto-sets `type: procedure`)
- Accept `steps`, `trigger_intents`, `preconditions` fields
- Validate step count matches body if both provided

**File: `claude-local-brain/mcp-server/tools/brain-feedback.js`**
- Extend to accept `procedure_outcome: success|failure|partial` when a procedure learning was used
- Calls `updateProcedureOutcome()` to track execution results

**New tool: `brain_procedure_outcome`** (optional, could be done via brain_feedback)
- Schema: `{ slug: string, outcome: "success" | "failure" | "partial", notes?: string }`
- Updates counters + appends to change_log

#### Test Plan
- Unit: procedure creation, frontmatter round-trip, scoring boost with procedural intent
- Unit: outcome tracking (success/failure counters)
- Integration: search "how to deploy binary-engine" returns procedure above regular learnings

---

### 1B. Golden Suite Lite (~6h)

#### Problem
Vitality decay can archive important learnings that haven't been accessed recently. There's no way to protect critical knowledge from decay.

#### Design

**New frontmatter field: `protected: true`**

```yaml
---
type: warning
title: "DEFLATE compression limitations in binary-engine"
tags: [binary-engine, deflate, compression]
protected: true   # NEW: immune to vitality decay
---
```

**Promotion criteria** (how learnings become golden):
1. **Manual**: `brain_remember` with `protected: true` or `golden: true`
2. **Auto-promotion**: Learning with `hit_count >= 10` AND `feedback_score >= 3` (if using brain_feedback) → auto-set `protected: true`
3. **Principle type**: All `type: principle` learnings are automatically protected (they're distilled knowledge)

**Contradiction detection** (lightweight, no LLM needed):
- When `brain_remember` creates a new learning, check against all `protected: true` learnings
- If cosine similarity > 0.80 AND sentiment/content appears contradictory (negation detection via simple heuristics: "don't", "never", "not", "avoid" vs positive statements), warn but don't block
- Log contradiction candidates to `change_log` for manual review

#### Implementation

**File: `claude-local-brain/mcp-server/learnings.js`**
- Add `protected` to frontmatter parsing
- Add `isProtected(slug)` helper (checks frontmatter field + principle type + auto-promotion threshold)
- Modify `findSimilarLearning()` to flag potential contradictions with protected learnings

**File: `claude-local-brain/mcp-server/maintenance.js`**
- In `performPrune()`: skip all learnings where `isProtected(slug) === true`
- In `computeAllVitalities()`: protected learnings always return `zone: "active"`, `vitality: 1.0`

**File: `claude-local-brain/mcp-server/database.js`**
- Add column: `protected INTEGER DEFAULT 0`
- Migration v4 (additive)

**File: `claude-local-brain/mcp-server/tools/brain-remember.js`**
- Accept `protected: boolean` in schema
- Run contradiction check on save, include warnings in response

**File: `claude-local-brain/mcp-server/tools/brain-health.js`**
- Show golden/protected count in health dashboard: `Protected: 12 (never decay)`

#### Auto-Promotion Cron
- In `maintenance.js`, add `promoteToGolden()`: scans all non-protected learnings where `hit_count >= 10` AND `search_appearances >= 20`
- Sets `protected: true`, logs to `change_log`
- Runs as part of existing maintenance cycle

#### Test Plan
- Unit: protected learnings skip decay, always zone "active"
- Unit: auto-promotion triggers at threshold
- Unit: contradiction detection flags overlap with protected learning
- Integration: brain_health shows protected count

---

## Sprint 2: Post-Session Reflection (~14h)

### Problem
`brain_log_session` is passive — the agent writes what it thinks is relevant. It misses implicit corrections, unstated preferences, and error patterns.

### Design (incorporating Codex safeguards)

**New tool: `brain_reflect_session`**

Input:
```json
{
  "transcript": "string (full session transcript or summary)",
  "session_id": "string (optional, links to session log)",
  "auto_save": false
}
```

Output:
```json
{
  "observations": [
    {
      "type": "correction",
      "content": "User prefers Catalan for responses, not Spanish",
      "evidence": "User said: 'respon-me en català si us plau'",
      "confidence": 0.95,
      "write_recommendation": "auto",
      "suggested_learning": {
        "type": "preference",
        "title": "User prefers Catalan language",
        "tags": ["language", "preference", "catalan"]
      }
    },
    {
      "type": "error",
      "content": "Agent tried requests library but SSL failed; should have used curl",
      "evidence": "Tool error: SSLError at requests.get(...)",
      "confidence": 0.90,
      "write_recommendation": "auto",
      "suggested_learning": {
        "type": "warning",
        "title": "Corporate SSL blocks Python requests",
        "tags": ["ssl", "corporate", "python", "curl"]
      }
    }
  ],
  "stats": {
    "corrections_found": 1,
    "preferences_found": 1,
    "domain_facts_found": 0,
    "errors_found": 1,
    "auto_saved": 2,
    "needs_review": 0,
    "discarded": 0
  }
}
```

### Safeguards (from Codex review)

1. **Confidence thresholds**:
   - `auto` write: confidence ≥ 0.85 AND evidence is explicit (direct quote)
   - `review` write: confidence 0.60-0.85 OR evidence is inferred
   - `discard`: confidence < 0.60
2. **Anti-spam quotas**: max 5 observations per session, max 3 auto-writes
3. **Dedup gate**: each suggested_learning runs through existing `findSimilarLearning()` — if duplicate, skip
4. **Non-contradiction check**: auto-write blocked if contradicts a `protected: true` learning (Sprint 1B)
5. **Budget**: reflection uses 1 LLM call (~$0.02 with Sonnet), capped by existing budget system

### LLM Prompt

```
You are a session analyst for an AI coding assistant called Claudia.
Analyze this session transcript and extract actionable observations.

Categories:
- correction: User corrected the agent (explicit or implicit)
- preference: User expressed or demonstrated a preference
- domain_fact: New factual knowledge about codebase, tools, or team
- error: Agent made a mistake (even if user didn't comment)

Rules:
- Every observation MUST have a direct quote from the transcript as evidence
- Do NOT fabricate observations not grounded in the transcript
- Do NOT extract from tool output or system messages, only user-agent dialogue
- If uncertain, lower confidence rather than omitting
- Maximum 5 observations per session

Confidence calibration:
- 0.9-1.0: Explicit statement, no ambiguity ("always use X", "I prefer Y")
- 0.7-0.89: Strong implication, minor inference needed
- 0.5-0.69: Moderate inference, could be situational
- Below 0.5: Discard (too speculative)
```

### Implementation

**New file: `claude-local-brain/mcp-server/tools/brain-reflect-session.js`**
- Schema: `{ transcript: z.string(), session_id: z.string().optional(), auto_save: z.boolean().default(false) }`
- Handler:
  1. Call LLM with reflection prompt + transcript (truncated to 8K tokens if needed)
  2. Parse structured observations from response
  3. For each observation:
     a. Check confidence → assign write_recommendation
     b. Check dedup via `findSimilarLearning()`
     c. Check contradiction with protected learnings
     d. If `auto_save === true` AND `write_recommendation === "auto"`: call `brain_remember` internally
  4. Return full observation list + stats

**File: `claude-local-brain/mcp-server/llm.js`**
- Add task config: `reflection: { maxTokens: 2048, temperature: 0.3, budgetCost: 5 }`
- Add prompt template in code or as config

**File: `claude-local-brain/mcp-server/index.js`**
- Register new tool via safeTool()

**File: `claudia/src/tools/brain.js`**
- Expose `brain_reflect_session` as tool for the agent

**File: `claudia/src/session.js` (or `repl.js`)**
- On session end (before brain_log_session), optionally trigger reflection
- Config flag: `BRAIN_AUTO_REFLECT=true|false` (default: false initially)

### Migration Path
1. **Phase A (manual)**: Tool available, agent calls it when instructed (`/reflect`)
2. **Phase B (suggested)**: At session end, Claudia suggests "Shall I reflect on this session?"
3. **Phase C (auto)**: `BRAIN_AUTO_REFLECT=true` runs it automatically, auto_save=true

### Test Plan
- Unit: LLM prompt generates valid structured observations (mock LLM)
- Unit: confidence gating works (auto/review/discard thresholds)
- Unit: anti-spam quota limits observations to 5
- Unit: dedup gate blocks duplicate learnings
- Unit: contradiction check warns on conflicts with protected learnings
- Integration: end-to-end session → reflect → auto-save → verify in brain_search

---

## Sprint 3: Quality Scorecard (~8h)

### Problem
We have no way to track if Claudia is improving or degrading over time. `brain_log_session` records what happened but not how well.

### Design (Codex-improved: composite scorecard, not 1-5 score)

**Extended `brain_log_session` schema**:
```json
{
  "project": "claudia",
  "summary": "Implemented procedural memory",
  "tags": ["brain", "memory", "procedural"],
  "quality": {
    "task_completed": true,
    "rework_required": false,
    "user_corrections": 0,
    "tool_errors": 1,
    "tools_used": 14,
    "turns": 8,
    "satisfaction": "high"
  }
}
```

**Quality fields**:
| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `task_completed` | boolean | Agent self-report | Was the main ask fulfilled? |
| `rework_required` | boolean | Agent self-report | Did user ask to redo something? |
| `user_corrections` | integer | Auto-count | Number of "no, do X instead" patterns in transcript |
| `tool_errors` | integer | Auto-count | Number of tool calls that returned errors |
| `tools_used` | integer | Auto-count | Total tool invocations |
| `turns` | integer | Auto-count | Number of user-agent turns |
| `satisfaction` | enum | Agent self-report | `high` / `medium` / `low` |

**Composite score formula** (computed, not stored):
```
score = 10
if !task_completed: score -= 4
if rework_required: score -= 2
score -= min(user_corrections * 0.5, 2)
score -= min(tool_errors * 0.3, 1.5)
if satisfaction == "low": score -= 1
# Floor at 1, cap at 10
```

### Trend Detection

**In `brain_health`**: show last 10 sessions' quality scores as sparkline:
```
Quality trend: ▆▇▇█▅▇▆▇▇█ (avg: 8.2, last: 9.5)
Alert: none
```

**Alert rules**:
- 3 consecutive sessions with score < 6 → ⚠️ "Quality declining"
- `tool_error_rate` > 30% → ⚠️ "High tool error rate"

### Implementation

**File: `claude-local-brain/mcp-server/tools/brain-log-session.js`**
- Extend schema with optional `quality` object
- Store quality data in session file metadata
- Write quality scores to a dedicated SQLite table (or metrics table)

**New file: `claude-local-brain/mcp-server/quality.js`**
- `computeCompositeScore(quality)` → number 1-10
- `getTrend(lastN)` → { scores: number[], avg: number, alert: string|null }
- `formatSparkline(scores)` → string

**File: `claude-local-brain/mcp-server/tools/brain-health.js`**
- Add quality trend section to health report

**File: `claude-local-brain/mcp-server/database.js`**
- New table: `session_quality (session_date TEXT, project TEXT, score REAL, task_completed INTEGER, rework INTEGER, corrections INTEGER, tool_errors INTEGER, tools_used INTEGER, turns INTEGER, satisfaction TEXT)`

**File: `claudia/src/session.js`**
- At session end, auto-count: tool_errors (from tool call results), tools_used, turns
- Pass to brain_log_session as `quality` object

### Test Plan
- Unit: composite score formula (known inputs → expected scores)
- Unit: trend detection (3 low scores → alert)
- Unit: sparkline rendering
- Integration: session with errors → quality score reflects it

---

## Sprint 4: Evolved System Prompt (~16h)

### Problem
CLAUDE.md is static, manually maintained. Claudia doesn't personalize based on learned user preferences, domain knowledge, or error patterns.

### Design (Codex-improved: compiled artifact, dual-layer)

**Directory structure**:
```
~/.claudia/evolved/
  user-preferences.md      # Compiled from preference-type learnings
  domain-knowledge.md      # Compiled from domain_fact learnings
  task-patterns.md         # Compiled from procedure-type learnings
  error-recovery.md        # Compiled from warning-type learnings
  _evolution-log.jsonl     # Append-only log of every compilation
  _version.json            # Current version + timestamp
```

### Dual-Layer Architecture (from Codex)

Each evolved file has two sections:

```markdown
# User Preferences

## Stable (manually confirmed, never expire)
- Responds in Catalan by default
- Prefers direct, concise style
- Uses Scala 2.12 + Spark 3.5.0

## Adaptive (auto-compiled, expires after 30 days without revalidation)
- Prefers small PRs over large ones [expires: 2026-05-01]
- Likes seeing token counts per turn [expires: 2026-05-01]
```

**Stable entries**: promoted from Adaptive after 3+ revalidations (searched/used 3 times), or manually added.
**Adaptive entries**: auto-compiled from brain learnings, expire after 30 days if never re-confirmed.

### Compilation Process

**New tool: `brain_compile_evolved`** (runs on demand or on schedule)

1. Query brain for active learnings by type:
   - `type: preference` → `user-preferences.md`
   - `type: pattern` + `type: procedure` → `task-patterns.md`
   - `type: warning` → `error-recovery.md`
   - `type: learning` with domain facts → `domain-knowledge.md`
2. For each category, select top 20 by vitality + hit_count
3. Compile into markdown (one line per learning, max 50 lines per section)
4. Preserve existing Stable entries, refresh Adaptive entries
5. Expire Adaptive entries older than 30 days without revalidation
6. Size gate: if any file > 200 lines, prune lowest-vitality Adaptive entries
7. Write files + append to `_evolution-log.jsonl`

### System Prompt Integration

**File: `claudia/src/system-prompt.js`**
```javascript
// After existing memoryPrefix, inject evolved context
const evolvedDir = join(homedir(), '.claudia', 'evolved');
const evolvedContext = loadEvolvedContext(evolvedDir);
// evolvedContext = concatenation of all .md files, max 4K tokens
```

**Position in prompt**: After `## Tools` section, before `## Core Rules`:
```
## Evolved Context (auto-compiled from memory)
[contents of evolved/*.md files]
```

### Versioning

`_version.json`:
```json
{
  "version": 7,
  "compiled_at": "2026-04-15T10:30:00Z",
  "entries": { "stable": 12, "adaptive": 23 },
  "source_learnings": 35,
  "total_lines": 87
}
```

`_evolution-log.jsonl` (one line per compilation):
```json
{"version":7,"timestamp":"2026-04-15T10:30:00Z","added":3,"removed":1,"expired":2,"promoted":1}
```

### Implementation

**New file: `claudia/src/evolved-prompt.js`** (~150 LOC)
- `loadEvolvedContext(dir)` → string (reads all .md, concatenates, truncates to 4K tokens)
- `compileEvolvedPrompt(brainClient)` → writes files to `~/.claudia/evolved/`
  - Queries brain via MCP calls
  - Groups by type
  - Applies dual-layer logic (stable vs adaptive)
  - Writes files + version + log

**File: `claudia/src/system-prompt.js`**
- Call `loadEvolvedContext()` and inject after tools section
- Fallback: if directory doesn't exist or is empty, inject nothing (backwards compatible)

**New REPL command: `/evolve`**
- Triggers `compileEvolvedPrompt()` manually
- Shows diff of what changed

**New tool (brain): `brain_compile_evolved`**
- Alternative: compile from brain side, write to a known path
- Pro: brain has direct access to all learnings
- Con: brain shouldn't know about Claudia's file paths
- **Decision**: compile from Claudia side (calls brain_search with filters, processes results locally)

### Safety
- No auto-compilation initially. Manual via `/evolve` command.
- Evolved context is clearly labeled in prompt ("auto-compiled from memory")
- Total injected context capped at 4K tokens (won't bloat prompt)
- _evolution-log.jsonl provides full audit trail
- User can always delete `~/.claudia/evolved/` to reset

### Test Plan
- Unit: loadEvolvedContext reads and concatenates files
- Unit: compileEvolvedPrompt produces correct dual-layer format
- Unit: adaptive entries expire after 30 days
- Unit: stable promotion after 3 revalidations
- Unit: size gate prunes when > 200 lines
- Integration: system prompt includes evolved context after compilation

---

## Future: Evaluation Harness (Parking Lot, ~20h+)

From Codex review. A replay-based evaluation system:
- Corpus of past sessions (from brain session logs)
- Rubrics per task type (coding, search, corporate tool usage)
- Runner that replays sessions against current config and scores them
- Detects if a change to evolved prompt improves or degrades quality

**Prerequisite**: Sprint 3 (quality scorecard) must be live and collecting data.
**Decision**: Defer until Sprints 1-4 are complete and we have 50+ sessions with quality data.

---

## Summary

| Sprint | What | Effort | Changes To | Depends On |
|--------|------|--------|------------|------------|
| **1** | Procedural Memory + Golden Suite Lite | ~14h | Brain: learnings, database, scoring, maintenance, tools | Nothing |
| **2** | Post-Session Reflection | ~14h | Brain: new tool, llm.js. Claudia: brain tools, session | Sprint 1B (contradiction check) |
| **3** | Quality Scorecard | ~8h | Brain: log-session, health, new quality.js. Claudia: session | Nothing (parallel with 2) |
| **4** | Evolved System Prompt | ~16h | Claudia: system-prompt, new evolved-prompt.js, REPL | Sprint 1 + 2 (needs typed learnings + reflection) |
| **Future** | Evaluation Harness | ~20h+ | New subsystem | Sprint 3 (needs quality data) |

**Total estimated effort**: ~52h (Sprints 1-4) + 20h (future)

```
Timeline (assuming 4h/week on this):
Sprint 1: weeks 1-4  (procedural memory + golden suite)
Sprint 2: weeks 5-8  (reflection)
Sprint 3: weeks 7-9  (quality scorecard, parallel with 2)
Sprint 4: weeks 9-13 (evolved prompt)
```

---

## Appendix: Decisions Made

| Decision | Rationale |
|----------|-----------|
| Procedural memory first, not evolved prompt | Codex: "build foundations before the flashy feature" |
| No constitution/5-gate governance | Single user, not enterprise. Overhead unjustified. |
| No triple-judge voting | Too expensive for personal use ($50/day cap in Phantom) |
| Compiled evolved prompt, not directly-editable | Codex: "treat as artifact, not source of truth" |
| Dual-layer (stable/adaptive) | Codex: prevents prompt accretion and stale entries |
| Reflection manual-first, auto later | Avoid memory spam until we validate quality |
| Contradiction detection heuristic, not LLM | Keep costs low; LLM judge is overkill for single user |
| `protected: true` instead of separate golden suite | Simpler; leverages existing learning infrastructure |
| Quality scorecard composite, not 1-5 | Codex: "a single number lies; multiple signals don't" |
