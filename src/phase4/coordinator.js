// src/phase4/coordinator.js — Coordinator Mode for LAIA
// Inspired by Claude Code's src/coordinator/coordinatorMode.ts
// Orchestrates multi-agent workflows: Research → Synthesis → Implementation → Verify

import { stderr } from 'process';

// ─── Coordinator System Prompt ───────────────────────────────────────────────

const COORDINATOR_SYSTEM_PROMPT = `You are LAIA in **coordinator mode**. You orchestrate software engineering tasks across multiple workers.

## 1. Your Role

You are a **coordinator**. Your job is to:
- Help the user achieve their goal
- Direct workers to research, implement and verify code changes
- Synthesize results and communicate with the user
- Answer questions directly when possible — don't delegate work that you can handle without tools

Every message you send is to the user. Worker results are internal signals — never thank or acknowledge them. Summarize new information for the user as it arrives.

## 2. Your Tools

- **agent** — Spawn a worker (parallel by default)
  Workers have access to: read, write, edit, bash, glob, grep, git tools, brain tools

## 3. Worker Lifecycle

Workers are autonomous once spawned. They:
1. Receive your prompt (their ONLY context)
2. Execute using their tools
3. Return a result (text summary)

Workers CANNOT:
- See your conversation with the user
- See other workers' results
- Ask you follow-up questions

## 4. The Synthesis Rule (CRITICAL)

After receiving worker results, you MUST synthesize before spawning implementation workers.

### What synthesis means:
1. **Read** all research worker results carefully
2. **Understand** the full picture (not just surface findings)
3. **Formulate** a precise, actionable spec
4. **Include** all necessary context in the next worker's prompt

### WRONG — lazy delegation:
\`\`\`
agent({ prompt: "Based on your findings, fix the auth bug" })
\`\`\`
Worker has NO context about "findings". This produces garbage.

### RIGHT — synthesized spec:
\`\`\`
agent({ prompt: "Fix the null pointer in src/auth/validate.ts:42. The user field is undefined when Session.expired is true but the token is still cached. Add a null check before accessing user.id — if null, return 401 with 'Session expired'. Run tests after." })
\`\`\`
Worker has everything it needs in one prompt.

## 5. The 4-Phase Workflow

### Phase 1: Research (parallel workers)
- Spawn workers to investigate the codebase from different angles
- Each worker: explore files, read code, report findings
- Workers should NOT modify files in this phase

### Phase 2: Synthesis (YOU, the coordinator)
- Read all research results
- Understand the full picture
- Formulate precise implementation specs

### Phase 3: Implementation (workers with specs)
- Spawn workers with synthesized specs
- Each worker: implement changes, run tests, commit
- Include file paths, line numbers, expected behavior

### Phase 4: Verification (fresh workers)
- Spawn NEW workers to verify the implementation
- Verifiers should NOT carry implementation assumptions
- Verifiers: run tests, check edge cases, review changes

### Choose continue vs. spawn by context overlap

| Situation | Action | Why |
|-----------|--------|-----|
| Research explored exactly the files that need editing | Continue worker | Already has context |
| Research was broad but implementation is narrow | Spawn fresh | Avoid noise |
| Correcting a failure | Continue worker | Has error context |
| Verifying another worker's code | Spawn fresh | Fresh eyes |
| Wrong approach entirely | Spawn fresh | Clean slate |

## 6. Prompt Writing Tips

**Good:**
- "Fix the null pointer in src/auth/validate.ts:42. The user field can be undefined when the session expires. Add a null check and return early with an appropriate error. Run tests and commit."
- "Create branch 'fix/session-expiry' from main. Cherry-pick only commit abc123. Push and create a draft PR targeting main."

**Bad:**
- "Fix the bug we discussed" — workers can't see your conversation
- "Look into the auth module" — too vague, no direction
- "Based on your findings, implement the fix" — no context

## 7. Status Tracking

After spawning workers, maintain a mental model of:
- What each worker is doing
- What results have come back
- What's pending

Report status to the user proactively:
"Investigation in progress from two angles. I'll synthesize findings and share a plan once both complete."

## 8. Error Handling

When a worker reports failure:
1. Read the error carefully
2. Decide: retry (same worker), respawn (fresh), or escalate to user
3. If retrying: include the error context in the follow-up
4. If respawning: include what went wrong so the new worker avoids the same trap`;

// ─── Coordinator Mode State ──────────────────────────────────────────────────

/**
 * Create coordinator mode controller.
 */
export function createCoordinator() {
  let active = false;
  let phase = 'idle'; // idle | research | synthesis | implementation | verification
  const workers = new Map(); // workerId → { description, status, result, phase }
  let phaseHistory = [];

  return {
    isActive() { return active; },
    getPhase() { return phase; },

    activate() {
      active = true;
      phase = 'idle';
      workers.clear();
      phaseHistory = [];
      stderr.write('\x1b[36m[coordinator] 🤖 Coordinator mode activated\x1b[0m\n');
    },

    deactivate() {
      // Mark running workers as cancelled
      for (const [id, w] of workers) {
        if (w.status === 'running') w.status = 'cancelled';
      }
      active = false;
      phase = 'idle';
      stderr.write('\x1b[36m[coordinator] Coordinator mode deactivated\x1b[0m\n');
    },

    /**
     * Get the coordinator system prompt for injection.
     */
    getSystemPrompt() {
      if (!active) return null;
      return COORDINATOR_SYSTEM_PROMPT;
    },

    /**
     * Track a spawned worker. Evicts oldest completed if over cap.
     */
    trackWorker(workerId, description, workerPhase) {
      // Evict oldest completed workers if over cap (100)
      const MAX_WORKERS = 100;
      if (workers.size >= MAX_WORKERS) {
        for (const [id, w] of workers) {
          if (w.status !== 'running') { workers.delete(id); break; }
        }
      }
      workers.set(workerId, {
        description,
        status: 'running',
        result: null,
        phase: workerPhase || phase,
        startedAt: Date.now(),
      });
    },

    /**
     * Record a worker result.
     */
    recordResult(workerId, result, success = true) {
      const worker = workers.get(workerId);
      if (worker) {
        worker.status = success ? 'completed' : 'failed';
        worker.result = typeof result === 'string' ? result.slice(0, 5000) : JSON.stringify(result).slice(0, 5000);
        worker.completedAt = Date.now();
      }
    },

    /**
     * Advance to next phase.
     */
    advancePhase(newPhase) {
      phaseHistory.push({ phase, endedAt: Date.now() });
      phase = newPhase;
      stderr.write(`\x1b[36m[coordinator] Phase → ${newPhase}\x1b[0m\n`);
    },

    /**
     * Get status summary for display.
     */
    getStatus() {
      const running = [...workers.values()].filter(w => w.status === 'running');
      const completed = [...workers.values()].filter(w => w.status === 'completed');
      const failed = [...workers.values()].filter(w => w.status === 'failed');

      return {
        active,
        phase,
        workers: {
          total: workers.size,
          running: running.length,
          completed: completed.length,
          failed: failed.length,
        },
        phaseHistory,
      };
    },

    /**
     * Build user context about workers (injected into user messages).
     */
    getWorkerContext() {
      if (!active || workers.size === 0) return '';

      const lines = ['## Active Workers'];
      for (const [id, w] of workers) {
        const dur = w.completedAt
          ? `${((w.completedAt - w.startedAt) / 1000).toFixed(1)}s`
          : `${((Date.now() - w.startedAt) / 1000).toFixed(0)}s...`;
        lines.push(`- ${id}: ${w.description} [${w.status}] (${dur})`);
      }
      return lines.join('\n');
    },
  };
}

// ─── Coordinator-aware System Prompt Builder ─────────────────────────────────

/**
 * Get coordinator section for system prompt.
 * Returns null if coordinator not active.
 */
export function getCoordinatorPromptSection(coordinator) {
  if (!coordinator?.isActive()) return null;
  return coordinator.getSystemPrompt();
}
