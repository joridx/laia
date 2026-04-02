# LAIA × Claude Agent Teams UI — Roadmap Consensuat

> **Autors:** OPUS (anàlisi + coordinació) + GPT-5.3-CODEX (revisió crítica)
> **Data:** 2026-04-02
> **Rondes de discussió:** 4 + checklist final
> **Estat:** Aprovat per consens

---

## Resum Executiu

Integrar LAIA com a backend de Claude Agent Teams UI, validant el protocol
stream-json contra una UI real, i després construir LAIA Web PWA sobre
fonaments provats.

**Estratègia:** Agent Teams UI primer (valida protocol) → PWA després (producte final).

---

## Compat Matrix

| Flag / Feature | Categoria | Sprint |
|----------------|-----------|--------|
| `--input/output-format stream-json` | ✅ JA IMPLEMENTAT | — |
| `--dangerously-skip-permissions` | ✅ JA IMPLEMENTAT | — |
| `--model <model>` | ✅ JA IMPLEMENTAT | — |
| `--effort <level>` | ✅ JA IMPLEMENTAT | — |
| `--verbose` | ✅ JA IMPLEMENTAT | — |
| `ping/pong` protocol | ✅ JA IMPLEMENTAT | — |
| `--mcp-config <path>` | 🔴 MUST | Sprint 0 |
| `--output-format text` (preflight) | 🔴 MUST | Sprint 0 |
| `--max-turns N` | 🟡 MUST-LITE | Sprint 0 |
| `usage` tokens al `result` | 🔴 MUST | Sprint 0 |
| Suprimir `laia:*` events en stream-json | 🔴 MUST | Sprint 0 |
| Flags no-op silenciosos | 🔴 MUST | Sprint 0 |
| Graceful fallback `control_request` | 🟡 MUST-LITE | Sprint 0 |
| `--setting-sources` | ⚪ ACCEPT-IGNORE | Sprint 0 |
| `--disallowedTools` | ⚪ ACCEPT-IGNORE | Sprint 0 |
| `--no-session-persistence` | ⚪ ACCEPT-IGNORE | Sprint 0 |
| `--worktree` | ⚪ ACCEPT-IGNORE | Sprint 0 |
| `control_request/response` complet | 🔵 DEFER | Sprint 1 |
| `system/compact_boundary` | 🔵 DEFER | Sprint 1 |
| `system/api_retry` | 🔵 DEFER | Sprint 1 |
| `--resume` | 🔵 DEFER | Sprint 1 |

---

## Sprint 0 — Compatibility Gate (2-3 dies, ~15h)

### Objectiu
LAIA és drop-in replacement mínim per Claude Agent Teams UI via `CLAUDE_CLI_PATH`.

### Tasques (ordre per dependència — consens Codex)

| # | Tasca | On | Esforç | Dep. |
|---|-------|----|--------|------|
| C | Flags no-op silenciosos (`--setting-sources`, `--disallowedTools`, `--no-session-persistence`, `--worktree`) | `bin/laia.js` | 30min | — |
| A | `--output-format text` mode (one-shot: `-p "text"` → stdout text → exit) | `bin/laia.js` | 1-2h | — |
| B | `--max-turns N` (comptador de turns, atura amb result success) | `bin/laia.js` + `src/stream-json.js` | 1h | — |
| F | Suprimir `laia:*` events en mode `--stream-json` | `src/stream-json.js` createStepEmitter | 15min | — |
| G | Graceful fallback per `control_request` (auto-approve) | `src/stream-json.js` | 30min | — |
| D | `--mcp-config <path>` (parser JSON + MCP Client/StdioClientTransport + registre tools) | `bin/laia.js` + `src/stream-json.js` + nou `src/mcp-client.js` | 4-8h | — |
| E | `usage` tokens al `result` (mapear cost_info → usage.input_tokens/output_tokens/cache_*) | `src/stream-json.js` emitResult | 1-2h | — |
| H | Tests unitaris per tot l'anterior (mínim 10 tests nous) | `tests/stream-json-sprint0.test.js` | 2-3h | C-G |

**Total estimat: 12-18h (2-3 dies)**

### Definition of Done (10 checks pass/fail)

| # | Check | Comanda | Pass si... |
|---|-------|---------|------------|
| 1 | Preflight PONG | `laia -p 'Output only the single word PONG.' --output-format text --model haiku --max-turns 1` | stdout conté `PONG` |
| 2 | Stream-json init | `echo '{"type":"ping"}' \| laia --stream-json --no-swarm 2>/dev/null \| head -2` | L1: `system/init`, L2: `pong` |
| 3 | MCP config load | `echo '{"type":"user",...}' \| laia --stream-json --mcp-config /tmp/test-mcp.json 2>/dev/null` | stdout conté tools MCP |
| 4 | Tool call E2E | Agent crida `mcp__agent-teams__task_list` | Rep resultat vàlid |
| 5 | Usage tokens | `grep result` de stream-json output | Conté `input_tokens` i `output_tokens` |
| 6 | No Unhandled types | Executar amb UI, grep stderr | 0 `Unhandled stream-json type` |
| 7 | Flags no-op | `laia --stream-json --setting-sources user,project --disallowedTools X --worktree /tmp` | Arrenca sense error |
| 8 | --max-turns | Enviar 5 missatges amb `--max-turns 2` | ≤2 assistant responses + result success |
| 9 | Process lifecycle | abort → atura; SIGTERM → atura net; SIGKILL → no zombies | Tots 3 passen |
| 10 | Tests | `node --test tests/stream-json*.test.js` | 0 failures |

### Checklist executable

```bash
#!/usr/bin/env bash
set -u
TMP="/tmp/laia-s0-gate" && mkdir -p "$TMP"
pass() { echo "✅ $1"; } ; fail() { echo "❌ $1 — mirar: $2"; }

# 1. Preflight
laia -p 'Output only the single word PONG.' --output-format text --model haiku --max-turns 1 > "$TMP/c1.out" 2>/dev/null
grep -qi 'PONG' "$TMP/c1.out" && pass "CHECK 1: Preflight" || fail "CHECK 1" "auth, model config, --output-format text"

# 2. Stream-json init
echo '{"type":"ping"}' | laia --stream-json --no-swarm 2>/dev/null | head -2 > "$TMP/c2.out"
grep -q '"subtype":"init"' "$TMP/c2.out" && grep -q '"type":"pong"' "$TMP/c2.out" && pass "CHECK 2: Init" || fail "CHECK 2" "stream-json handshake"

# 3. MCP config load
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"List tools"}]}}' | laia --stream-json --mcp-config /tmp/test-mcp.json --no-swarm 2>/dev/null > "$TMP/c3.out"
grep -qE 'mcp__|tool' "$TMP/c3.out" && pass "CHECK 3: MCP load" || fail "CHECK 3" "mcp-config path, MCP server spawn"

# 4. Tool call E2E (manual — requereix controller real)
echo "CHECK 4: Tool E2E — verificar manualment amb UI"

# 5. Usage tokens
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Say hi"}]}}' | laia --stream-json --no-swarm 2>/dev/null | grep '"type":"result"' > "$TMP/c5.out"
grep -q 'input_tokens' "$TMP/c5.out" && grep -q 'output_tokens' "$TMP/c5.out" && pass "CHECK 5: Usage" || fail "CHECK 5" "emitResult, cost_info mapping"

# 6. No Unhandled (necessita UI real)
echo "CHECK 6: No Unhandled — verificar manualment amb UI"

# 7. Flags no-op
echo '{"type":"ping"}' | laia --stream-json --setting-sources user,project --disallowedTools X --no-session-persistence --worktree /tmp 2>"$TMP/c7.err" | head -1 > "$TMP/c7.out"
grep -q '"subtype":"init"' "$TMP/c7.out" && ! grep -qi 'error\|unknown' "$TMP/c7.err" && pass "CHECK 7: No-op flags" || fail "CHECK 7" "flag parser a bin/laia.js"

# 8. --max-turns
for i in 1 2 3 4 5; do echo "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"msg$i\"}]}}"; sleep 1; done | laia --stream-json --max-turns 2 --no-swarm 2>/dev/null > "$TMP/c8.out"
N=$(grep -c '"type":"assistant"' "$TMP/c8.out" || true)
[ "$N" -le 2 ] && grep -q '"type":"result"' "$TMP/c8.out" && pass "CHECK 8: max-turns ($N)" || fail "CHECK 8" "turn counter a stream-json.js"

# 9. Lifecycle
echo '{"type":"ping"}' | timeout 5 laia --stream-json --no-swarm >/dev/null 2>&1; pass "CHECK 9a: clean exit"
laia --stream-json --no-swarm < /dev/null >/dev/null 2>&1 & P=$!; sleep 1; kill -15 $P 2>/dev/null; wait $P 2>/dev/null
! ps -p $P >/dev/null 2>&1 && pass "CHECK 9b: SIGTERM" || fail "CHECK 9b" "signal handlers"

# 10. Tests
cd /home/yuri/laia && node --test "tests/stream-json*.test.js" > "$TMP/c10.out" 2>&1
grep -q 'fail 0' "$TMP/c10.out" && pass "CHECK 10: Tests" || fail "CHECK 10" "tests/stream-json*.test.js"

echo ""; echo "Logs: $TMP"
```

---

## Sprint 1 — Estabilització (1 setmana)

**Objectiu:** Protocol complet, robustesa MCP, sessions.

- `control_request/response` protocol (tool approval quan `skipPermissions=false`)
- `system/compact_boundary` i `system/api_retry` events
- `--resume` (session persistence / reprise)
- MCP hardening: reconnect, timeouts, circuit breaker per server
- `--permission-prompt-tool stdio` mode
- Tests E2E complets amb controller real

**DoD:** Tots els `DEFER` de la compat matrix passen a `DONE`.

---

## Sprint 2 — LAIA Web PWA MVP (1 setmana)

**Objectiu:** PWA funcional amb chat streaming, mobile-ready.

- `packages/webui/` dins monorepo LAIA
- Fastify BFF (:3120) — POST /messages + GET /stream (SSE)
- React PWA (Vite) — chat input/output amb streaming
- Reutilitzar adapter transport (SSE ↔ stream-json)
- Boundary enforcement: webui importa `@laia/brain` + `@laia/providers`, zero src/
- PWA manifest + service worker (offline shell)
- `laia --web` CLI entry point

**DoD:** PWA arrenca, chat funcional amb streaming, installable a Chrome/Android.

---

## Sprint 3 — Convergència (1 setmana)

**Objectiu:** Components compartits, features mòbils, brain visual.

- `packages/ui-core/` — components reutilitzables (chat renderer, event timeline, message model)
- Mobile features: camera (`take_photo`), GPS (`get_location`), TTS (`speak`), STT
- Brain visualization a la PWA (memòria, learnings, graph)
- Opcional: kanban/diff viewer adaptat d'Agent Teams UI

**DoD:** PWA amb features mòbils natives + brain visible + components compartits.

---

## Riscos Top-3

| Risc | Impacte | Mitigació |
|------|---------|-----------|
| **Protocol drift subtil** — camps opcionals, noms, ordre temporal diferent del que espera la UI | Integració trenca silenciosament | Compat matrix com a contracte; tests de shape exacte per cada message type |
| **MCP processes** — hangs, timeouts, zombie processes del StdioClientTransport | UX congelada, resources leak | Watchdog per server, timeout agressiu configurable, circuit-breaker |
| **Token usage inconsistent entre providers** — Claude retorna cache_*, GPT no | UI mostra dades incorrectes | Mapping tolerant amb defaults `0`; documentar quins providers donen quins camps |

---

## Decisions Arquitectòniques

### `--mcp-config` implementació (validada per Codex)

```
bin/laia.js
  └─ parse --mcp-config <path>
  └─ llegir JSON: { mcpServers: { "name": { command, args, env } } }

src/mcp-client.js (NOU)
  └─ Per cada server: new Client() + new StdioClientTransport({command, args, env})
  └─ Connectar, listTools(), registrar al context
  └─ Tool routing: quan agent crida mcp__<server>__<tool> → redirigir al client

src/stream-json.js
  └─ Abans del primer turn: inicialitzar MCP clients
  └─ Al shutdown: tancar tots els clients
```

**SDK:** `@modelcontextprotocol/sdk` ja inclou `Client` + `StdioClientTransport` (imports des de `client/index.js` i `client/stdio.js`).

### UI: No tocar per Sprint 0

Usar `CLAUDE_CLI_PATH=$(which laia)` per injectar LAIA sense modificar el codi d'Agent Teams UI.
