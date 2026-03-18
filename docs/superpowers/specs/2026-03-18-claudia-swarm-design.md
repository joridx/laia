# claudia swarm — Design Spec

**Data:** 2026-03-18
**Estat:** Approved (v2 post-review)
**Autor:** brainstorming session (Claude Code + claudia/Copilot validation + spec review)

---

## 1. Problema

claudia té una limitació de context window que creix amb la conversa: l'orquestrador acumula historial, contingut de fitxers, resultats d'eines — i s'ofega en detalls. Claude Code resol això amb subagents (`Agent` tool) que corren amb context net i enfocat. claudia no té equivalent.

Objectiu: implementar un sistema de workers in-process que permeti a claudia orquestrar múltiples agents especialitzats, superant la limitació de context window i oferint paral·lelisme real, tot dins l'ecosistema Copilot Business (sense consumir tokens Anthropic).

---

## 2. Casos d'ús principals

- **Orquestrador claudia → N workers**: una instància claude/codex planifica i delega subtasques a workers amb context net.
- **Claude Code → claudia MCP server**: Claude Code delega tasques a workers Copilot, estalviant tokens Anthropic per a la feina d'execució.
- **Paral·lelisme real**: N workers llegeixen/escriuen fitxers independents simultàniament (exemple: refactoritzar 5 mòduls en paral·lel).

---

## 3. Arquitectura

### Mode A — claudia com a orquestrador

```
claudia REPL (model: claude o codex, orquestrador)
  system prompt: rol orquestrador + instruccions de delegació
  context: pla general + summaris de resultats (context petit)
      │
      ├── agent({prompt, files?, model?, depth?})  ──► worker 1 (history=[], context net)
      ├── agent({prompt, files?, model?, depth?})  ──► worker 2 (history=[], context net)  [Promise.allSettled + semàfor]
      └── agent({prompt, files?, model?, depth?})  ──► worker N (history=[], context net)
```

**Clau:** l'orquestrador rep només *summaris* dels resultats. El contingut complet (fitxers llegits, outputs d'eines) queda al context del worker i es descarta. El context de l'orquestrador no creix amb els detalls d'execució.

### Mode B — claudia com a MCP server

```
Claude Code (Anthropic tokens — planificació)
    └── MCP tool: claudia.agent() ──────────────────────────────────┐
                                                                     ▼
claudia --mcp (Copilot tokens — execució)
    ├── worker 1 (in-process, context net)
    ├── worker 2 (in-process, context net)
    └── worker N (in-process, context net)
```

Un sol core (`src/tools/agent.js`), dos modes d'accés.

---

## 4. Components

### 4.1 `src/tools/agent.js` — el tool agent (NOU)

```javascript
// Signatura del tool (schema per l'LLM)
agent({
  prompt,      // Tasca + instruccions per al worker (string, requerit)
  files?,      // Fitxers a injectar al context del worker (array de paths, opcional)
  model?,      // Model override (defecte: router decideix)
  timeout?,    // Timeout en ms (defecte: 60000)
})
// Retorna: { text, success, tokensUsed, workerId }
```

**Comportament intern (passos):**
1. Genera un `workerId` únic (ex. `worker-1`, per logs i debug)
2. Calcula `depth = parentDepth + 1` (passat com a paràmetre runtime, **no** env var — veure C4)
3. Si `depth >= MAX_DEPTH (3)` → retorna `{success: false, error: "max recursion depth exceeded"}`
4. Crea un `PermissionContext` propi via `createPermissionContext({autoApprove: true})`
5. Crea un `ToolRegistry` propi via `createToolRegistry(config)`, **sense** l'`agent` tool (no recursivitat per defecte)
6. Llegeix els `files` via la lògica existent de `attach.js` (format XML `<file path="..." lang="...">`, límits: 100KB/file, 500KB total). Fitxer no trobat → skip silenciós + warning al result.
7. Construeix `workerSystemPrompt = buildWorkerSystemPrompt({workerId, depth, workspaceRoot, fileContents})`
8. Crea un `AbortController` + setTimeout per al timeout; el `signal` es passa cap avall fins a les crides HTTP
9. Crida `runAgentTurn` **directament** (no via `runTurn`) amb:
   - `tools: workerRegistry.getSchemas()`
   - `executeTool: permCtx.check(name, args) → workerRegistry.execute(name, args)`
   - `signal` (per cancel·lació)
   - `history: []`
   - `systemPrompt: workerSystemPrompt`
10. Retorna `{text, success: true, tokensUsed: usage.total_tokens, workerId}`

**Paral·lelisme (gestionat al callback `executeTool` d'`agent.js`):**

Quan l'LLM orquestrador genera N crides `agent` en un sol torn, el batch de tool calls que retorna `runAgentTurn` és processat per un nou helper `dispatchToolBatch(calls, executeTool)` a `agent.js`. Aquest helper:
- Detecta si **totes** les crides del batch són `agent` calls → usa `Promise.allSettled` + semàfor (màx 4 concurrents)
- Si el batch és mixt (alguna crida no és `agent`) → execució seqüencial (comportament actual)
- `llm.js` **no canvia** — el loop intern continua cridant `executeTool` per cada crida individualment; el batch paralel es gestiona a nivell d'`agent.js` interceptant el resultat del loop.

> **Nota implementació:** `runAgentTurn` retorna ja tots els tool calls d'un torn com a array. El `dispatchToolBatch` opera sobre aquest array abans de retornar els resultats al LLM.

**Semàfor zero-dependència** (no s'afegeix `p-limit`):
```javascript
function createSemaphore(max) {
  let count = 0;
  const queue = [];
  const acquire = () => count < max
    ? Promise.resolve(count++)
    : new Promise(r => queue.push(r));
  const release = () => { count--; queue.shift()?.(); };
  return { acquire, release };
}
```

### 4.2 `src/mcp-server.js` — MCP server mode (NOU)

- Usa `@modelcontextprotocol/sdk` (ja a `node_modules` via brain MCP client)
- Transport: `StdioServerTransport`
- Exposa un sol tool: `agent`
- Schema MCP (`{name, description, inputSchema}` JSON Schema) adaptat des del schema Copilot de `src/tools/agent.js`. L'`agent.js` exporta tant el schema Copilot com una funció `execute` crua; `mcp-server.js` registra `execute` sota el schema MCP.
- **Regla crítica:** cap worker pot escriure a `process.stdout` (corromp el protocol JSON-RPC). Tots els logs de workers van a `process.stderr` amb prefix `[worker-{id}]`. El logger del server es redirigeix a stderr.
- Cancel·lació: si el client MCP envia cancel·lació, l'`AbortController` del worker corresponent s'activa.
- Límit: màxim 8 workers concurrents en mode MCP (configurable, semàfor propi).
- `runWorkerTurn` MUST NOT cridar `runOneShot`. Brain lifecycle és responsabilitat exclusiva del servidor MCP (inicia 1 cop a `startMcpServer`, para al tancament).

### 4.3 Refactors de fitxers existents

#### `src/permissions.js`

**Canvi:** substituir flags globals per un context per instància.

```javascript
export function createPermissionContext({ autoApprove = false } = {}) {
  const approved = new Set();
  return {
    async check(name, args) {
      if (autoApprove || approved.has(name)) return true;
      // ... prompt interactiu (si rl disponible)
    },
    approveSession(name) { approved.add(name); },
  };
}
// Backwards-compat per REPL interactiu (sense canvis d'API externs)
export const defaultContext = createPermissionContext();
export async function checkPermission(name, args) {
  return defaultContext.check(name, args);
}
export function setAutoApprove(val) {
  // Deprecated: manté backwards compat per runOneShot
  defaultContext._autoApprove = val;
}
```

#### `src/agent.js`

- Eliminar el singleton `let client = null`. Cada crida a `runAgentTurn` crea el seu propi `LLMClient` via `createLLMClient(config)`.
- Afegir `dispatchToolBatch(calls, executeTool, semaphore)` per al paral·lelisme agent calls.
- Afegir `runAgentTurn` accepta opcionalment `signal: AbortSignal` — es passa a `client.call()` per cancel·lar en-flight HTTP. (Veure també `llm.js` — C3.)
- `runTurn` i `runOneShot` no canvien de comportament extern.
- **`runWorkerTurn` NO existeix com a funció separada** — el worker crida `runAgentTurn` directament des de `src/tools/agent.js` amb paràmetres explícits.

#### `src/tools/index.js` + tots els fitxers de tools

**Canvi:** fer el registry instanciable sense trencar l'API actual.

```javascript
// Cada tool file (read.js, write.js, bash.js, etc.) canvia:
// ABANS: export function registerReadTool() { registry.set(...) }
// DESPRÉS: export function registerReadTool(reg = defaultRegistry) { reg.set(...) }

export function createToolRegistry() {
  const reg = new Map();
  return {
    set: (name, def) => reg.set(name, def),
    get: (name) => reg.get(name),
    getSchemas: () => [...reg.values()].map(d => d.schema),
    execute: (name, args, callId) => reg.get(name)?.execute(args, callId),
  };
}
export const defaultRegistry = createToolRegistry();
// Backwards-compat
export function getToolSchemas() { return defaultRegistry.getSchemas(); }
export function registerBuiltinTools(config, registry = defaultRegistry) {
  registerReadTool(registry); registerWriteTool(config, registry); // ...etc
}
```

**Fitxers de tools afectats:** `read.js`, `write.js`, `edit.js`, `bash.js`, `glob.js`, `grep.js`, `command.js`, `git.js`, `brain.js` — tots han d'acceptar `registry` com a paràmetre opcional de les seves funcions `register*Tool`.

#### `src/system-prompt.js`

Afegir `buildWorkerSystemPrompt({workerId, depth, workspaceRoot, fileContents})`:
- Sense instruccions de REPL (`/save`, `/load`, `/model`, etc.)
- Sense instruccions de brain (`brain_*` tools)
- Sense instruccions de sessions
- Instrucció explícita: "You are a focused worker agent (ID: {workerId}, depth: {depth}). Complete the task and return a concise result. Do not ask clarifying questions."
- Si `fileContents` present → inclou el bloc XML `<files>...</files>` al system prompt

#### `src/llm.js`

- `runAgentTurn` (i les funcions internes `runResponsesTurn`, `runChatTurn`) accepten un paràmetre opcional `signal: AbortSignal`.
- El `signal` es passa a `apiCall` i `streamingApiCall` com a opció del `fetch` (propietat estàndard `signal` a `RequestInit`).
- Això permet que el timeout de l'`AbortController` del worker cancel·li realment la crida HTTP en-flight, no només el wrapper.

#### `bin/claudia.js`

```javascript
else if (a === '--mcp') args.mcp = true;
// ...
if (args.mcp) {
  const { startMcpServer } = await import('../src/mcp-server.js');
  await startMcpServer({ config, logger });
}
```

---

## 5. Flux de dades (ReAct dinàmic)

```
Usuari: "refactoritza el sistema de routing per suportar cost-based routing"
  │
  ▼
Orquestrador (model: claude, history creixent però petit — només summaris)
  └── raona: cal entendre l'arquitectura actual i els tests
  └── crida en paral·lel (depth=1):
        agent("llegeix src/router.js i descriu l'arquitectura de routing actual")
        agent("llegeix tests/router.test.js i identifica gaps de cobertura")
  │
  ▼
[dispatchToolBatch → Promise.allSettled — ~15s concurrent]
  Worker 1 (depth=1): llegeix router.js → retorna summari de 200 paraules
  Worker 2 (depth=1): llegeix tests → retorna llista de gaps
  │
  ▼
Orquestrador (context: pla + 2 summaris curts, NO els fitxers complets)
  └── raona: ara tinc prou context, puc dissenyar el canvi
  └── crida (depth=1):
        agent("implementa cost-based routing a src/router.js: [disseny concís]",
              files=["src/router.js"])
  │
  ▼
Worker 3 (depth=1): llegeix src/router.js via files injection, implementa, escriu fitxer
  └── retorna: "Implementat. Afegits: costScore, COST_WEIGHTS, tie-breaking per cost."
  │
  ▼
Orquestrador: "Fet. Routing actualitzat amb cost-based tie-breaking."
```

---

## 6. Gestió d'errors i robustesa

| Escenari | Comportament |
|----------|-------------|
| Worker timeout | `AbortController` cancel·la fetch HTTP en-flight (via `signal`), retorna `{success: false, error: "timeout"}` |
| Worker uncaught exception | `try/catch` a l'agent tool, retorna error, orquestrador continua |
| Worker falla tool | El worker gestiona internament i retorna summari de l'error |
| N workers, M fallen | `Promise.allSettled` → orquestrador rep tots els resultats (èxits + errors) |
| Recursió excessiva | `depth >= MAX_DEPTH (3)` → error immediat sense executar (guard per paràmetre, no env var) |
| MCP stdout corruption | Workers escriuen 0 bytes a stdout. Logger redirigit a stderr amb prefix `[worker-{id}]`. |
| Brain lifecycle | MCP server (o REPL) inicia Brain 1 cop. Workers no criden `startBrain/stopBrain`. |
| `files` path no existeix | Skip silenciós + `{warning: "file not found: ..."}` al result del worker |
| Batch mixt (agent + altres tools) | Execució seqüencial (comportament actual). Només batches 100% agent calls van en paral·lel. |

---

## 7. Testing

| Test | Tipus | Descripció |
|------|-------|------------|
| `agent tool returns result` | Unit | Mock `runAgentTurn`, verifica retorn `{text, success, tokensUsed, workerId}` |
| `parallel agent calls use Promise.allSettled` | Unit | 3 agent calls en batch, verifica execució concurrent via `dispatchToolBatch` |
| `semaphore caps concurrency at 4` | Unit | 10 agents, verifica màx 4 concurrents simultàniament |
| `timeout triggers AbortController` | Unit | Worker que no acaba, verifica timeout error + HTTP cancel·lació |
| `recursion guard blocks depth >= 3` | Unit | `depth=3`, verifica error immediat sense cridar `runAgentTurn` |
| `permission context isolated per worker` | Unit | 2 workers, 1 aprova tool, l'altre no la té aprovada |
| `tool registry isolated per worker` | Unit | Workers no comparteixen entrades del registry; worker no té `agent` tool |
| `files injection uses attach limits` | Unit | Fitxer >100KB → skip + warning; total >500KB → truncat |
| `MCP server tool call returns result` | Integration | Connectar com a MCP client, cridar `agent`, verificar resultat |
| `brain not stopped by worker` | Integration | 2 workers en paral·lel, brain MCP segueix viu al final |
| `stdout clean in MCP mode` | Integration | Capturar stdout, verificar 0 bytes no-MCP protocol |
| `AbortSignal propagates to fetch` | Unit | Mock fetch, verifica que `signal` arribat és el del AbortController del worker |

---

## 8. Fitxers afectats

```
NOU:     src/tools/agent.js          — el tool agent + dispatchToolBatch + semàfor
NOU:     src/mcp-server.js           — MCP server mode + schema adapter
MODIF:   src/permissions.js          — createPermissionContext() instanciable, backwards compat
MODIF:   src/agent.js                — sense singleton client, dispatchToolBatch, signal param
MODIF:   src/tools/index.js          — createToolRegistry() + defaultRegistry + backwards compat
MODIF:   src/tools/read.js           — registerReadTool(registry?) param
MODIF:   src/tools/write.js          — registerWriteTool(config, registry?) param
MODIF:   src/tools/edit.js           — registerEditTool(config, registry?) param
MODIF:   src/tools/bash.js           — registerBashTool(registry?) param
MODIF:   src/tools/glob.js           — registerGlobTool(registry?) param
MODIF:   src/tools/grep.js           — registerGrepTool(registry?) param
MODIF:   src/tools/command.js        — registerCommandTool(registry?) param
MODIF:   src/tools/git.js            — registerGitTools(registry?) param
MODIF:   src/tools/brain.js          — registerBrainTools(registry?) param
MODIF:   src/system-prompt.js        — buildWorkerSystemPrompt()
MODIF:   src/llm.js                  — signal: AbortSignal a runAgentTurn, apiCall, streamingApiCall
MODIF:   bin/claudia.js              — flag --mcp
NOU:     tests/agent-tool.test.js    — 12 nous tests (veure secció 7)
```

---

## 9. Estimació d'esforç

| Fase | Esforç | Inclou |
|------|--------|--------|
| Refactors prerequisits (permissions, registry, signal) | 1 dia | 9 tool files + permissions + llm.js, tests existents verds |
| `src/tools/agent.js` + paral·lelisme + semàfor | 1 dia | dispatchToolBatch, AbortController, recursion guard, files injection |
| `src/mcp-server.js` + `--mcp` flag | 1 dia | stdio transport, cancellation, stdout discipline, schema adapter |
| Tests nous | 0.5 dia | 12 tests (secció 7) |
| **Total MVP** | **~3.5 dies** | |

---

## 10. Fora d'abast (ara)

- Workers amb subsets d'eines específiques per domini (tool registry filtering)
- Streaming de resultats de workers cap a l'orquestrador en temps real
- Persistència d'estat compartit entre workers (shared memory)
- Dashboard de monitoratge de workers
- Autenticació/autorització per al MCP server (local only per ara)
- `p-limit` com a dependència (substituït per semàfor zero-deps)
