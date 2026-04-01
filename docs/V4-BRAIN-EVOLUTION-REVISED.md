# V4 — Brain Evolution (Restructured Post-V5)

**Date:** 2026-04-01
**Status:** Restructured after V5 Claude Code Adoption revealed ~80% overlap
**Original plan:** 5 sprints, 72h estimated
**Revised plan:** 4 integration tracks, ~37h estimated (49% reduction)
**Review:** gpt-5.3-codex overlap analysis

---

## Overlap Analysis

| V4 Original Item | V5 Coverage | What Exists | What's Missing |
|-------------------|:-:|-------------|----------------|
| Procedural Memory | ~95% | brain supports `type: procedure`, `trigger_intents`, `preconditions`, `steps` | Outcome tracking adapter (success/failure per step, retry logic) |
| Golden Suite Lite | ~90% | brain supports `protected: true`, decay immunity in staleness checks | Auto-promotion (learning → golden after N confirmations), contradiction detection (new learning vs existing) |
| Post-Session Reflection | ~85% | `brain_reflect_session` tool exists, V5 session-notes captures 9-section summaries, compaction summarizes context | Dedupe pipeline (same insight extracted twice), confidence-gated auto-save (only save if confidence > threshold), session ID tracking |
| Quality Scorecard | ~85% | `brain_health` tool exists with basic stats | Composite score formula, sparkline/trend tracking over time, regression alerts when score drops, wiring to /review and /debug |
| Evolved System Prompt | ~75% | `evolved-prompt.js` exists, `~/.laia/evolved/` has 4 compiled files (domain-knowledge, error-recovery, task-patterns, user-preferences), V5 compaction + typed-memory cover adaptive layer | `/evolve` command (interactive promote/demote/expire), deterministic precedence stack, bounded budget per section |
| Evaluation Harness | ~25% | V5 gives building blocks: session-notes (structured summaries), coordinator traces (phase history, worker results), mailbox logs | Deterministic replay format, rubric definitions, before/after regression gates, corpus management |

---

## 3 Architectural Conflicts to Resolve

### Conflict 1: typed-memory vs brain learnings (TWO SOURCES OF TRUTH)

**Problem:**
- `memory/typed-memory.js` stores memories in `~/.laia/memories/{type}/` as `.md` files with frontmatter
- Brain server stores learnings in `~/laia-data/learnings/` as JSON entries
- Both systems can store similar information (e.g., "user prefers vitest over jest")
- No sync, no dedup, no ownership rules

**Resolution — Ownership Matrix:**

| Data Class | Owner | Why |
|------------|-------|-----|
| Procedures (workflows, how-to) | **Brain** | Has trigger_intents, steps, outcome tracking |
| Learnings (facts, patterns, warnings) | **Brain** | Has tags, search, auto-expire, protected flag |
| User preferences | **Typed Memory** (`user/`) | Simpler, file-based, human-editable |
| Project context | **Typed Memory** (`project/`) | Per-project, lives in `.laia/memories/` |
| Feedback/corrections | **Typed Memory** (`feedback/`) | Session-scoped, auto-expires |
| References (URLs, external pointers) | **Typed Memory** (`reference/`) | Static, rarely changes |

**Bridge rules:**
1. On session end, `feedback/` entries with >3 confirmations → promote to brain learning
2. Brain learnings tagged `#user-pref` → mirror to typed-memory `user/` for prompt injection
3. Never duplicate: if brain has it, typed-memory points to it (not copies)

### Conflict 2: session-notes vs brain session log (DOUBLE SUMMARIZATION)

**Problem:**
- `memory/session-notes.js` writes 9-section summaries to `~/.laia/sessions/{id}/notes.md`
- `brain_log_session` writes session summaries to `~/laia-data/sessions/`
- Both triggered at session end → duplicate work, duplicate storage

**Resolution — Pipeline:**
```
Session End
  ├─→ session-notes.js writes 9-section summary (CAPTURE layer)
  ├─→ brain_reflect_session reads the summary (LEARNING layer)
  │     ├─→ Extracts new learnings (confidence > 0.7)
  │     ├─→ Dedupes against existing learnings (cosine similarity > 0.85 = skip)
  │     └─→ Saves curated learnings to brain (with session_id tag)
  └─→ brain_log_session saves metadata only (duration, tokens, tools used)
```

**Key rule:** Session-notes = raw structured capture. Brain = curated learnings. No overlap.

### Conflict 3: compaction vs evolved prompt (CONTEXT BUDGET COLLISION)

**Problem:**
- Compaction injects a potentially large summary (2-8KB) into the context
- Evolved prompt injects compiled sections (~1-3KB per section, 4 sections)
- Typed memory injects user/project memories
- LAIA.md hierarchy injects project docs
- Combined: can exceed useful context budget before user's actual task

**Resolution — Precedence Stack with Budgets:**

| Priority | Section | Max Budget | Notes |
|:--------:|---------|:----------:|-------|
| 1 | Safety + Core Rules | ~1KB | Never trimmed |
| 2 | Identity + Tools | ~2KB | Never trimmed |
| 3 | Evolved Stable (domain-knowledge, error-recovery) | ~3KB | Compiled, rarely changes |
| 4 | LAIA.md (project context) | ~4KB | Trimmed if over budget |
| 5 | Typed Memory (relevant entries) | ~2KB | Top-K by relevance |
| 6 | Compacted Session (if active) | ~4KB | 9-section summary |
| 7 | Evolved Adaptive (task-patterns, user-preferences) | ~2KB | Expires, lower priority |
| 8 | Output Style | ~0.5KB | Optional |
| **Total** | | **~18.5KB** | Fits in any model's system prompt budget |

---

## Revised Tracks

### Track 1: Memory Unification (1-2 days)

**Goal:** Single source of truth per data class. No duplicate storage.

**Tasks:**
1. Define ownership matrix in code (config constant)
2. Add `owner` field to typed-memory entries
3. Bridge: promote confirmed feedback → brain learning
4. Bridge: mirror brain `#user-pref` → typed-memory `user/`
5. Dedupe check on save: if exists in owner system, skip/link
6. Update `buildMemoryIndex()` to respect ownership (no double-inject)

**Acceptance criteria:**
- No information exists in both systems simultaneously
- Typed memory `user/` and brain `#user-pref` stay in sync
- `/memory list` shows owner for each entry

### Track 2: Reflection Pipeline (0.5-1 day)

**Goal:** Session capture → curated learning extraction without duplicates.

**Tasks:**
1. Hook session-notes completion → trigger brain_reflect
2. Add session_id to all extracted learnings (dedupe key)
3. Implement similarity check before save (substring match, not full cosine)
4. Confidence threshold: only auto-save if reflect confidence > 0.7
5. brain_log_session: metadata only (remove summary, point to session-notes)

**Acceptance criteria:**
- One session never produces duplicate learnings
- Low-confidence learnings flagged but not auto-saved
- `brain_health` shows extraction stats

### Track 3: Prompt/Context Governance (0.5-1 day)

**Goal:** Deterministic, bounded system prompt assembly.

**Tasks:**
1. Implement priority-based budget allocation in `buildSystemPrompt()`
2. Add byte counting per section with truncation
3. Create `/evolve` command (promote/demote/expire evolved entries)
4. Test: verify total prompt stays under model-specific limits
5. Document precedence stack in OPERATIONS.md

**Acceptance criteria:**
- System prompt never exceeds 20KB
- Each section respects its budget
- `/evolve` can promote a learning to stable evolved section

### Track 4: Evaluation Harness (2-3 days) — DEFERRED

**Goal:** Automated quality regression detection.

**Tasks:**
1. Define replay format (JSON: session transcript + expected outcomes)
2. Build rubric system (per-skill scoring criteria)
3. Before/after gates for prompt/memory/compiler changes
4. Corpus management (add/remove/tag test sessions)

**Blocked by:** Tracks 1-3 (needs stable memory + prompt system first)

---

## Dependencies

```
Track 1 (Memory Unification)
  └─→ Track 2 (Reflection Pipeline) — needs ownership rules
  └─→ Track 3 (Prompt Governance) — needs memory budget rules
        └─→ Track 4 (Evaluation Harness) — needs stable system
```

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Brain server API changes break bridge | HIGH | Version brain API, add contract tests |
| Typed memory files hand-edited by user | MEDIUM | Validate on load, warn on malformed |
| Compaction summary too large | MEDIUM | Hard cap at 4KB, truncate oldest sections |
| Evolved prompt stale after brain changes | LOW | `/evolve` recompiles on demand |
