

# LAIA Architectural Review — Structural Problems Blocking V4 Evolution

---

## 🔴 1. God Object: `repl.js` (1356 LOC) Is the Application, Not Just the REPL

**Location:** `src/repl.js` — the entire file

**Problem:** `runRepl()` is a single 400+ line function that owns:
- Brain lifecycle (`startBrain`/`stopBrain`)
- Tool registration (`registerBuiltinTools`)
- Context/session management (autosave, fork, restore)
- Turn execution loop (spinner, streaming, feedback, auto-commit, undo)
- Slash command dispatch (another ~400 lines in `handleSlashCommand`)
- UI rendering (cat animation, prompt building, suggestions)
- Keyboard event handling (Esc interrupt, Tab picker)
- Token accounting

Every V4 feature (post-session reflection, quality scorecard, evolved system prompt) will need to hook into this function's local variables (`context`, `sessionTokens`, `turnAbort`, `planMode`, `effort`, `router`, `undoStack`, `autoCommitter`). There's no way to access them from outside — they're all closures inside `runRepl`.

**Specific pain point — turn execution is duplicated:** The turn execution logic (spinner setup, `runTurn`, streaming, context update, auto-commit, feedback) appears twice — once in the main loop (lines ~295–395) and again in the slash command `default` handler (lines ~620–680). Any V4 hook (e.g., post-turn reflection, scorecard collection) must be added to both locations.

**V4 Blocker:** Procedural memory needs post-turn hooks. Quality scorecard needs pre/post turn instrumentation. Post-session reflection needs session lifecycle events. None of these can be added without either (a) making `runRepl` even larger or (b) extracting the core concepts.

**Proposed refactoring:**

```
src/
  repl/
    index.js          # readline setup, prompt, keypress — thin shell
    turn-runner.js    # executeTurn({ input, config, context, ... }) → result
    slash-commands.js  # handleSlashCommand — pure dispatch, returns effects
    ui.js             # spinner, cat banner, suggestions, prompt builder
    lifecycle.js       # startSession, endSession, autosave/restore hooks
```

The critical extraction is `TurnRunner` — a single function that both the main loop and slash-command handler call:

```js
// src/repl/turn-runner.js
export async function executeTurn({ input, config, context, logger, router,
  attachManager, autoCommitter, undoStack, planMode, effort, signal, onStep }) {
  // 1. Pre-turn hooks (V4: scorecard start, procedural memory lookup)
  // 2. Context preparation (attachments, compaction)
  // 3. runTurn()
  // 4. Post-turn hooks (V4: reflection, feedback, scorecard)
  // 5. Auto-commit, undo
  // 6. Return { text, usage, turnMessages, suggestions }
}
```

---

## 🔴 2. Global Mutable Singletons Block Testability and Multi-Session

**Location:** `src/tools/index.js:defaultRegistry`, `src/permissions.js:defaultContext`, `src/brain/client.js:client/transport`

**Problem:** Three global singletons with mutable module-level state:

**`src/brain/client.js` lines 48-49:**
```js
let client = null;
let transport = null;
```
One brain connection for the entire process. If MCP server mode needs a separate brain context per request, or if V4 post-session reflection runs after `stopBrain()`, it fails.

**`src/tools/index.js` — `defaultRegistry` (a global `Map`):**
Every tool registers into a single shared map. The `agent` tool is conditionally added/removed via `/swarm` toggle (repl.js line ~547):
```js
const { registerAgentTool } = await import('./tools/agent.js');
registerAgentTool(config, defaultRegistry);
// ...
defaultRegistry.delete('agent');
```
Workers share the same registry as the parent. Tool schemas returned by `getToolSchemas()` are the same for parent and worker — the worker filters post-hoc in `tools/agent.js:171-173`. This is fragile: any new V4 tool that should be parent-only or worker-only requires ad-hoc filtering.

**`src/permissions.js` — module-level `defaultContext`:**
```js
export function setReadlineInterface(rl) { defaultContext.setReadlineInterface(rl); }
export async function checkPermission(toolName, args) { return defaultContext.checkPermission(toolName, args); }
```
Workers create their own `createPermissionContext({ autoApprove: true })` but the parent's `checkPermission` import from `agent.js` hits the global. This works only because `agent.js` imports `checkPermission` (global) while `tools/agent.js` creates a local context. If V4 adds permission scopes (e.g., different policies per profile), the global is a wall.

**V4 Blocker:** Quality scorecard needs per-turn isolated tool tracking. Procedural memory agents may need independent brain connections. Post-session reflection may need to run tools after the main session's brain is stopped.

**Proposed refactoring — Session container object:**

```js
// src/session-container.js
export function createSessionContainer({ config, logger }) {
  const toolRegistry = new Map();
  const brain = createBrainClient();      // own lifecycle
  const permissions = createPermissionContext();
  const context = createContext();

  return {
    toolRegistry,
    brain,
    permissions,
    context,
    config,
    logger,
    // V4 hooks
    onTurnComplete: [],   // (turnResult) => void
    onSessionEnd: [],     // () => void
  };
}
```

Register tools into the container's registry instead of a global. Pass the container through `runTurn` → `runAgentTurn` → `executeTool`.

Migration path: keep `defaultRegistry` as a fallback that delegates to a "current session" container, so existing code doesn't break in one step.

---

## 🔴 3. `agent.js` Creates a New LLM Client Per Turn — No Client Lifecycle

**Location:** `src/agent.js:createClient()` called inside `runTurn()` (line 26)

```js
export async function runTurn({ input, config, ... } = {}) {
  const llmClient = createClient(config);   // ← NEW client every turn
  ...
}
```

**Problem:** `createLLMClient` resolves the provider, builds auth headers infrastructure, etc. — lightweight now but architecturally wrong. There's no place to:
- Cache tokens across turns (auth.js does this internally, but the LLM client doesn't know)
- Track cumulative usage across turns (each client is ephemeral)
- Apply evolved system prompts (V4) that depend on client state
- Implement connection pooling or keep-alive for HTTP/2

More critically: `config.model` is read at turn start, but the auto-router modifies `effectiveConfig.model` in `repl.js`. The client is created from `config` in `runTurn`, but the router decision is made in `repl.js` — so `repl.js` creates a modified config copy and passes it. This is the seam where V4's "evolved system prompt" (which depends on model choice + session history) has nowhere to live.

**V4 Blocker:** Evolved system prompt needs to be built with access to session state, model history, and procedural memory results. Currently `buildSystemPrompt` is called inside `runTurn` with only `config` — no session context.

**Proposed refactoring:**

```js
// src/agent.js
export function createAgent({ config, logger, session }) {
  let client = null;
  let currentModel = config.model;

  function ensureClient(model) {
    if (!client || model !== currentModel) {
      client = createLLMClient({ ... });
      currentModel = model;
    }
    return client;
  }

  async function runTurn({ input, model, planMode, effort, signal, onStep }) {
    const llm = ensureClient(model ?? config.model);
    const systemPrompt = buildSystemPrompt({
      ...config,
      model: currentModel,
      sessionContext: session?.context,  // V4: procedural memory, evolved prompt
    });
    // ...
  }

  return { runTurn, getClient: () => client };
}
```

---

## 🔴 4. Config Is a Plain Object Mutated In-Place — No Schema, No Reactivity

**Location:** `src/config.js`, and ~15 call sites that mutate `config` properties

**Problem:** `loadConfig()` returns a plain object. Then it's mutated freely:
- `repl.js` line ~537: `config.swarm = !config.swarm;`  
- `repl.js` `handleModelCommand`: `config.model = target;`  
- `repl.js` local `planMode` and `effort` are separate variables that shadow what might be in `config`

The config has no validation, no change notification, no derived values. V4's "evolved system prompt" needs to react to config changes (model switch → different prompt strategy). Quality scorecard needs to know which config was active for each turn.

**Specific structural issue:** `config.js` performs side effects at module load time (lines 7-15):
```js
if (process.env.CLAUDE_BRAIN_PATH && !process.env.LAIA_BRAIN_PATH) {
  process.stderr.write('⚠️ ...');
  process.env.LAIA_BRAIN_PATH = process.env.CLAUDE_BRAIN_PATH;
}
```
This runs when any module imports `normalizeEffort` from config.js — including in tests. Module-level side effects that write to stderr and modify `process.env` are untestable.

**V4 Blocker:** Procedural memory needs config snapshots per turn. Evolved system prompt needs reactive config. Quality scorecard needs immutable config records.

**Proposed refactoring:**

```js
// src/config.js
export function createConfig(initial) {
  const _state = Object.freeze({ ...DEFAULTS, ...initial });
  const _listeners = new Set();

  return {
    get(key) { return _state[key]; },
    snapshot() { return { ..._state }; },
    derive(overrides) {
      // Returns a new frozen config — never mutates
      return createConfig({ ..._state, ...overrides });
    },
    onChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); },
  };
}
```

Move legacy migration to an explicit `migrateLegacyEnv()` called once from `bin/laia.js`, not at import time.

---

## 🔴 5. Brain Client Is a Leaky Process-Level Singleton with No Error Recovery

**Location:** `src/brain/client.js` — entire module

**Problem analysis by function:**

**`startBrain()` (lines 50-78):** Creates one `Client` + `StdioClientTransport` in module-level `let client`, `let transport`. If the brain child process crashes mid-session, `client` is still non-null but broken. Every subsequent `callBrainTool()` will throw. No reconnection logic exists.

**`stopBrain()` (lines 80-85):** Sets `client = null`. But `repl.js` calls `stopBrain()` on exit. If V4 post-session reflection needs brain access after the REPL loop ends (to log session summary), it's gone.

**`callBrainTool()` (lines 87-93):** No timeout, no retry, no circuit breaker. A hung brain process blocks the entire agent turn indefinitely.

**Architectural mismatch:** The brain is an MCP server spawned as a child process. But all the tools in `src/tools/brain.js` are thin wrappers around `callBrainTool`. The brain's tool definitions live in `packages/brain/tools/`, and the *same* tools are re-wrapped in `src/tools/brain.js` with slightly different schemas. This means:
- Tool parameter schemas may drift between brain server and client wrapper
- Error messages are double-wrapped (`Brain search unavailable: ${err.message}`)
- Adding a brain tool requires changes in 3 places: `packages/brain/tools/`, `src/tools/brain.js`, `src/system-prompt.js`

**V4 Blocker:** Procedural memory needs reliable, long-lived brain connections. Post-session reflection needs brain access after REPL shutdown. Quality scorecard needs brain health status.

**Proposed refactoring:**

```js
// src/brain/client.js
export function createBrainConnection({ brainPath, verbose }) {
  let client = null;
  let transport = null;
  let healthy = true;

  async function ensureConnected() {
    if (client && healthy) return client;
    if (client) await disconnect();  // reconnect
    // ... spawn + connect
    transport.process.on('exit', () => { healthy = false; });
    return client;
  }

  async function call(toolName, args, { timeoutMs = 30_000 } = {}) {
    const c = await ensureConnected();
    return Promise.race([
      c.callTool({ name: toolName, arguments: args }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`brain:${toolName} timeout`)), timeoutMs)),
    ]);
  }

  async function disconnect() { ... }

  return { call, disconnect, isHealthy: () => healthy };
}
```

---

## 🟡 6. LLM Dual-Endpoint Architecture Needs an Adapter Layer

**Location:** `src/llm.js` — `runResponsesTurn()` (lines 215-270), `runChatTurn()` (lines 300-420)

**Problem:** Two nearly-identical 100+ line functions with duplicated logic for:
- Tool call extraction + execution loop
- Turn message assembly
- Timeout handling  
- Error classification

The `DONE_TOOL` workaround (lines 280-295) is an API proxy quirk injected directly into the core agent loop. This creates invisible coupling: if the Copilot proxy fixes their `tool_choice: "auto"` behavior, removing `DONE_TOOL` requires understanding its tendrils through `runChatTurn`.

**Growing issue:** `withTimeout` is declared *inside* `runResponsesTurn` (lines 238-242) as a local function, then used in the same scope. This is the only place timeouts are applied to tool execution. `runChatTurn` doesn't have per-tool timeouts at all.

```js
// Inside runResponsesTurn only:
const TOOL_TIMEOUT_MS = 60000;
async function withTimeout(promise, ms, name, callId) { ... }
```

**V4 impact:** Quality scorecard needs to instrument tool execution timing uniformly across both endpoints. Evolved system prompt may need to adapt based on endpoint capabilities (reasoning support, streaming support). Currently these are hardcoded in if-branches.

**Proposed refactoring — Normalize at the adapter boundary:**

```js
// src/llm/adapters/responses.js
export function createResponsesAdapter(client) {
  return {
    async *runTurn({ messages, tools, effort, signal }) {
      // Yields normalized events: { type: 'text'|'tool_calls'|'done'|'error', ... }
    }
  };
}

// src/llm/adapters/chat-completions.js
export function createChatAdapter(client) {
  return {
    async *runTurn({ messages, tools, effort, signal }) {
      // Same normalized event interface
      // DONE_TOOL quirk lives HERE, not in the agent loop
    }
  };
}

// src/llm/agent-loop.js
export async function runAgentLoop({ adapter, systemPrompt, input, history, tools,
  executeTool, maxIterations, signal, onStep }) {
  // Single implementation that consumes normalized events
}
```

---

## 🟡 7. Tool Registry Has No Lifecycle — Schema vs. Execution Are Coupled

**Location:** `src/tools/index.js` (98 LOC, not shown in full but inferred from exports)

**Problem inferred from usage patterns:**

Each tool module exports a `registerXTool(config, registry)` function that pushes `{ description, parameters, execute }` into the registry. The schema (sent to the LLM) and the executor (run locally) are the same object.

This means:
1. **Tool schemas are computed at registration time**, not at turn time. If V4's evolved system prompt wants to dynamically adjust tool descriptions based on context (e.g., "you're working on a Python project, bash examples should use python3"), it can't.

2. **No tool middleware.** Every cross-cutting concern (permission checking, timing, logging) is handled ad-hoc in `agent.js`:
```js
// src/agent.js lines 47-59
executeTool: async (name, args, callId) => {
  if (blockedTools?.has(name)) return { error: ... };
  const allowed = await checkPermission(name, args);
  if (!allowed) throw new Error('User denied permission');
  const t0 = Date.now();
  const result = await dispatchTool(name, args, callId);
  const durationMs = Date.now() - t0;
  logger.logToolStats?.({ ... });
  return result;
},
```
This is duplicated in `tools/agent.js` (worker's `workerExecuteTool`, lines 115-140) with different behavior (auto-approve, namespace injection). V4's quality scorecard needs to wrap *every* tool execution with timing + success/failure tracking. Currently that requires modifying both `agent.js` and `tools/agent.js`.

3. **Tool names are stringly-typed with no validation.** `blockedTools?.has(name)` relies on matching strings between `PLAN_MODE_EXCLUDED_TOOLS` array and whatever `tool_calls[].function.name` the LLM emits. A typo in either side silently fails.

**Proposed refactoring:**

```js
// src/tools/registry.js
export function createToolRegistry() {
  const tools = new Map();
  const middleware = [];  // [(name, args, next) => result]

  return {
    register(name, { schema, execute }) { ... },
    getSchemas({ exclude, include } = {}) { ... },
    use(middlewareFn) { middleware.push(middlewareFn); },
    async execute(name, args, callId) {
      // Runs through middleware chain, then tool.execute
    },
  };
}

// Usage in V4:
registry.use(timingMiddleware);      // quality scorecard
registry.use(permissionMiddleware);  // replaces checkPermission
registry.use(planModeMiddleware);    // replaces blockedTools set
```

---

## 🟡 8. System Prompt Is a Monolithic String Template — Unextensible

**Location:** `src/system-prompt.js:buildSystemPrompt()` (lines 3-90)

**Problem:** The entire system prompt is a single template literal with hardcoded sections. The function signature takes `{ workspaceRoot, model, brainPath, corporateHint, planMode }` — five parameters, none of which carry session state.

V4 features need to inject dynamic content:
- **Procedural memory:** "In your last 3 sessions on this project, you learned: ..."
- **Evolved system prompt:** Sections that adapt based on agent performance history
- **Quality scorecard:** "Your current quality score is X. Focus on Y."

Currently, adding any of these means concatenating more strings into an already 90-line template literal with manual `\n\n` management.

**Proposed refactoring — Composable prompt sections:**

```js
// src/system-prompt.js
export function buildSystemPrompt({ sections }) {
  // sections: [{ id, priority, content }]
  // Sorted by priority, deduplicated by id, joined with section headers
  return sections
    .sort((a, b) => a.priority - b.priority)
    .map(s => s.content)
    .join('\n\n');
}

// src/system-prompt/sections/
//   identity.js       → { id: 'identity', priority: 0, build(ctx) }
//   tools.js           → { id: 'tools', priority: 10, build(ctx) }
//   memory.js          → { id: 'memory', priority: 20, build(ctx) }
//   plan-mode.js       → { id: 'plan-mode', priority: 30, build(ctx) }
//   procedural.js      → V4: { id: 'procedural', priority: 25, build(ctx) }
//   scorecard.js       → V4: { id: 'scorecard', priority: 35, build(ctx) }
```

---

## 🟡 9. Turn Messages / Context Store Are Poorly Separated

**Location:** `src/context.js` — `addUser()` called *before* `runTurn()`, `addTurn()` called *after* in `repl.js`

**Problem:** The conversation context has a subtle protocol that must be followed correctly:

```js
// repl.js lines ~305-310 (main loop)
context.addUser(typeof llmInput === 'string' ? llmInput : llmInput.text);  // BEFORE
const result = await runTurn({ ... history: context.getHistory() ... });    // DURING
context.addTurn({ assistantText: text, turnMessages: result.turnMessages }); // AFTER
```

This three-step protocol is also followed in the slash-command default handler (lines ~635-665). If either caller gets the order wrong, or forgets `addUser`, the context corrupts silently — `getHistory()` returns misaligned messages.

The `context` object stores two parallel arrays (`messages` and `turns`) that must stay in sync. The comment on line 34 acknowledges this:
```js
// Atomic post-turn recording: stores assistant reply and full turn transcript
// in one call to prevent messages/turns desync (architecture review finding #2).
```

But `addUser()` is still separate. The "atomic" fix was incomplete.

**V4 impact:** Procedural memory and post-session reflection need to iterate over completed turns with metadata (timing, model used, tool count). The current `turns` array is a raw array of message arrays with no metadata.

**Proposed refactoring:**

```js
// src/context.js
function addTurn({ userInput, assistantText, turnMessages, metadata = {} }) {
  // Stores user + assistant + transcript atomically
  // metadata: { model, effort, durationMs, toolsUsed, timestamp }
  const turn = {
    user: userInput,
    messages: turnMessages,
    metadata: { ...metadata, ts: Date.now() },
  };
  turns.push(turn);
  // V4: quality scorecard can iterate turns with metadata
}
```

Move `addUser()` inside `addTurn()` or make `runTurn` responsible for calling it.

---

## 🟡 10. No Structured Error Domain — Errors Are Strings with Ad-Hoc Properties

**Location:** `src/llm.js:makeError()` (line ~520), used everywhere

```js
function makeError(message, props = {}) {
  return Object.assign(new Error(message), props);
}
```

**Problem:** Errors carry arbitrary properties (`retriable`, `reauth`, `status`, `contextExceeded`, `retryAfterMs`, `partialText`) via `Object.assign` on plain `Error` objects. There's no way to:
- Type-check an error (is this a rate limit? a context overflow? an auth failure?)
- Recover partial work (the `partialText` property is set in a catch block, line ~199)
- Distinguish LLM errors from tool errors from brain errors

In `repl.js` the catch block (lines ~390-400) does basic string matching:
```js
const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || turnAbort?.signal?.aborted;
```

**V4 impact:** Quality scorecard needs to categorize errors. Evolved system prompt may retry with different parameters on context overflow. Procedural memory should record error patterns.

**Proposed refactoring:**

```js
// src/errors.js
export class LLMError extends Error {
  constructor(message, { status, retriable = false, code } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retriable = retriable;
    this.code = code;   // 'rate_limit' | 'context_exceeded' | 'auth' | 'timeout'
  }
}

export class ToolError extends Error { ... }
export class BrainError extends Error { ... }
```

---

## 🟢 11. Router Is Hard-Coded Keyword Lists — Won't Scale but Acceptable for Now

**Location:** `src/router.js` — `CORPORATE_KEYWORDS` (line 15), `CODING_KEYWORDS` (line 24)

The keyword-based routing with fuzzy edit distance is clever but brittle. Adding a new model or domain requires editing arrays and if-else chains. For V4, the router might need to consider session history, tool usage patterns, or quality scores.

**Why 🟢:** The router is isolated, self-contained, and has a clean `route()` → `{ model, domain }` interface. It can be replaced without touching other modules. The keyword approach works well enough for now, and the `recordToolsUsed()` feedback mechanism shows it was designed with evolution in mind.

---

## 🟢 12. `genai-client.js` (268 LOC) Exists Alongside `llm.js` — Unclear Boundary

**Location:** `src/genai-client.js` — not imported by any `src/` file in the import graph

This file creates a GenAI client but nothing in `src/` imports it. It may be used by `bin/laia.js` directly or be dead code from the fork. Either way, having two LLM client implementations (`llm.js` and `genai-client.js`) is confusing but not blocking since `llm.js` is clearly the canonical path.

**Why 🟢:** If it's dead code, delete it. If it's an alternative entry point (e.g., for the `--genai` flag), document it. Not structurally blocking.

---

## Summary — Priority Matrix

| # | Issue | Severity | V4 Feature Blocked |
|---|-------|----------|-------------------|
| 1 | `repl.js` god object — no turn extraction | 🔴 | All V4 hooks |
| 2 | Global mutable singletons (registry, brain, permissions) | 🔴 | Multi-agent, testing |
| 3 | LLM client created per turn, no lifecycle | 🔴 | Evolved system prompt |
| 4 | Config is mutable plain object with import side effects | 🔴 | Scorecard, evolved prompt |
| 5 | Brain client: no reconnect, no timeout, singleton | 🔴 | Procedural memory, reflection |
| 6 | Dual-endpoint code duplication in llm.js | 🟡 | Scorecard instrumentation |
| 7 | Tool registry has no middleware/lifecycle | 🟡 | Scorecard, permissions |
| 8 | System prompt is monolithic template | 🟡 | Evolved prompt, procedural memory |
| 9 | Context store: split addUser/addTurn protocol | 🟡 | Turn metadata for scorecard |
| 10 | Unstructured error domain | 🟡 | Error categorization for scorecard |
| 11 | Hard-coded router keywords | 🟢 | — |
| 12 | Unclear genai-client.js boundary | 🟢 | — |

**Recommended attack order:** 1 → 5 → 2 → 4 → 3 → 7 → 8 → 9 → 6 → 10. Extract the turn runner from repl.js first (unblocks all hooks), fix brain reliability (unblocks procedural memory), then introduce the session container (unblocks clean dependency injection for everything else).
