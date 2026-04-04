# LAIA × Nextcloud — Pla d'Integració

> Document generat 2026-04-03 amb consens OPUS+CODEX (3 rondes de discussió).
> Basat en anàlisi d'Istota (github.com/muinyc/istota) — bot AI auto-allotjat dins Nextcloud.

## Índex

1. [Visió General](#visió-general)
2. [Estat Actual de LAIA](#estat-actual-de-laia)
3. [Funcionalitats a Adoptar](#funcionalitats-a-adoptar)
4. [Millores de Disseny Transferibles](#millores-de-disseny-transferibles)
5. [Què NO Copiar](#què-no-copiar)
6. [Arquitectura Objectiu](#arquitectura-objectiu)
7. [Sprint 1 — Sleep Cycle + Memòria Ambient](#sprint-1--sleep-cycle--memòria-ambient)
8. [Sprint 2 — Talk + Confirmation Flow + CRON.md](#sprint-2--talk--confirmation-flow--cronmd)
9. [Sprint 3 — Daemon + Reports + Notificacions](#sprint-3--daemon--reports--notificacions)
10. [Sprint 4 — Heartbeat + Briefings](#sprint-4--heartbeat--briefings)
11. [Model d'Execució Híbrid](#model-dexecució-híbrid)
12. [Decisió Final: Què és millor a cada projecte](#decisió-final)

---

## Visió General

LAIA és un agent CLI de Node.js amb brain/memòria persistent. L'usuari té un servidor Nextcloud propi.
L'objectiu és evolucionar LAIA d'**agent reactiu** (CLI que espera input) a **agent proactiu** (daemon que monitora, consolida, i notifica) aprofitant Nextcloud com a plataforma d'interacció, emmagatzematge i autenticació.

**Inspiració:** Istota (Python, 28K LOC, 26 skills) és un bot AI que viu dins Nextcloud com a usuari regular, amb Claude Code CLI com a motor d'execució. Adoptem els seus millors patrons sense perdre la identitat de LAIA (motor propi, multi-provider, brain avançat).

---

## Estat Actual de LAIA

### Què ja tenim (16K LOC)

| Component | Detall |
|---|---|
| **Brain** | BM25 + embeddings, typed memory (user/feedback/project/reference), reflection pipeline, bridge promotion |
| **Memòria** | unified-view (4KB typed + 8KB total budget, 15 entries/type), session-notes (9 seccions), evolved-prompt (stable + adaptive) |
| **Hooks** | Bus amb 8 events: SessionStart/End, PreToolUse/PostToolUse, PreCompact/PostCompact, TaskStarted/Completed |
| **Skills** | 5 bundled (/batch, /simplify, /verify, /init, /skillify) + intent-matcher (keyword scoring, threshold 0.3) |
| **Coordinador** | Multi-agent orchestration (4 fases) amb mailbox pattern |
| **Tools** | 13 tools: bash, read, write, edit, glob, grep, git (diff/status/log), brain (search/remember/context), agent, run_command |
| **Services** | plan-engine, doctor, commit, review, debug, compaction, suggestions, tips, magic-docs |
| **Nextcloud** | Skill bàsic WebDAV (ls, download, upload, mkdir, delete, search, share) via curl |
| **Secrets** | Encrypted-at-rest (.secrets.enc + .secrets.key), get_secret() shell function |
| **Feature flags** | 12 flags amb file + env override layering |

### Arquitectura de memòria actual (7 capes al system prompt)

LAIA ja té un sistema sofisticat de memòria governada per `prompt-governance.js`:

```
P1 — SAFETY + CORE RULES         [PINNED, mai truncat]
P2 — IDENTITY + TOOLS             [PINNED]
P3 — EVOLVED STABLE               [PINNED, ~3KB max]
     └── Learnings confirmats manualment (warnings, patrons, preferències)
     └── 4 fitxers: user-preferences.md, task-patterns.md,
         error-recovery.md, domain-knowledge.md
     └── Promotion: 3+ revalidations → stable. 30-day expiry → drop.
P4 — TASK CONTEXT                  [CONTEXTUAL]
     └── Corporate, plan, coordinator context
P5 — TYPED MEMORY                  [4KB budget, 15 entries/type max]
     └── user / feedback / project / reference (unified-view.js)
     └── Dedup: entries promogudes al brain → excloses
     └── Staleness warnings per entry
P6 — EVOLVED ADAPTIVE              [primer a truncar, 30-day expiry]
     └── Learnings automàtics recents
P7 — OUTPUT STYLE                  [OPCIONAL]

Budget total: 20KB (default), hard cap 32KB
Truncation: bottom-up (P7 primer), per-entry, mai substring
```

A més, al primer torn de cada sessió, el system prompt instrueix:
> *"SESSION START: call brain_get_context to recover what was decided/implemented in previous sessions"*

Aquest `brain_get_context` retorna: sessions recents del projecte, warnings, learnings rellevants, git sync status. **Ja és una forma de memòria ambient**, però depèn d'una tool call (no és auto-injectat).

### Què realment falta (gap real, no sobreestimat)

| Component | Impacte | Nota |
|---|---|---|
| ❌ Daemon/scheduler | No pot ser proactiu | |
| ❌ Talk integration | Només CLI (no mòbil, no asincronia) | |
| ❌ Sleep cycle | No hi ha consolidació temporal de memòria | El brain acumula sense comprimir |
| ⚠️ Memòria temporal | No sap "què va passar ahir" sense tool call | brain_get_context ho cobreix parcialment |
| ⚠️ Auto-recall per prompt | brain_search existeix però l'agent l'ha d'invocar | Istota ho fa automàticament (BM25 amb el prompt) |
| ❌ Briefings | No genera resums proactius | |
| ❌ Heartbeat monitoring | No monitora res | |
| ❌ Notificacions multi-canal | Només output a terminal | |
| ❌ CRON.md / TASKS.md patterns | No hi ha tasques declaratives | |
| ❌ Confirmation flow | No demana confirmació per accions perilloses | |
| ❌ Web UI / reports estàtics | No hi ha interfície visual |

---

## Funcionalitats a Adoptar

### Ranking final (consens OPUS+CODEX)

| # | Funcionalitat | Valor | Cost | Dependències |
|---|---|---|---|---|
| **1** | Sleep Cycle (consolidació nocturna) | 🔴 Molt alt | Baix | Hooks existents |
| **2** | Tancar 3 forats de memòria (daily + auto-recall + tasks) | 🔴 Molt alt | Molt baix (~100 LOC) | Sleep cycle (A), hooks (B), WebDAV (C) |
| **3** | Talk integration (entrada/sortida) | 🔴 Molt alt | Mitjà | Nextcloud WebDAV existent |
| **4** | TASKS.md + CRON.md patterns | 🟠 Alt | Baix | Talk (per escriptura d'estat) |
| **5** | Confirmation flow | 🟠 Alt | Baix | Talk (per yes/no) |
| **6** | Daemon/scheduler | 🟠 Alt | Alt | Sleep cycle, Talk, CRON.md |
| **7** | Static reports + OIDC auth | 🟠 Alt | Baix | Daemon/nginx |
| **8** | Notificacions multi-canal | 🟡 Mitjà | Baix | Talk, email, ntfy |
| **9** | Heartbeat monitoring | 🟡 Mitjà | Mitjà | Daemon, notificacions |
| **10** | Briefings programats | 🟡 Mitjà | Alt | Daemon, calendar, feeds, email |

> **Nota (revisió post-anàlisi):** La funcionalitat #2 original era "Memòria ambient (auto-injectada)" amb cost Baix. Després d'analitzar l'arquitectura existent (prompt-governance 7 capes, evolved-prompt, unified-view), resulta que el que falta són 3 micro-integracions (~100 LOC total), no un sistema complet. El cost real és "Molt baix" i és el millor ROI de tot el roadmap.

---

## Millores de Disseny Transferibles

### D'Istota cap a LAIA

| Patró | Referència Istota | Aplicació a LAIA |
|---|---|---|
| **Markdown-as-config** | `cron_loader.py`, `heartbeat.py` — TOML dins blocs ` ```toml ``` ` de fitxers .md | Configuració de jobs/heartbeat editable des de Nextcloud |
| **Content-hash dedup** | `tasks_file_poller.py` — SHA de text normalitzat | Processament idempotent de TASKS.md |
| **TTL cache amb fallback stale** | `talk_poller.py` — cache de converses amb clock monotònic | Resiliència contra fallades de Nextcloud API |
| **Multi-surface dispatch** | `notifications.py` — cascade: explicit → user → global | Routing flexible de notificacions |
| **Budget-aware truncation** | `sleep_cycle.py` — head 40% + tail 60% per preservar conclusions | Gestió de context window per consolidació |
| **Graceful shutdown + file-lock** | `scheduler.py` — `fcntl` lock, signal handlers | Operació segura single-instance del daemon |
| **OIDC via Nextcloud** | `web_app.py` — authlib + FastAPI, SIGHUP reload | Autenticació de reports estàtics |
| **Canal-agnòstic** | Tot el core és independent de la font d'input | Facilita afegir canals nous (Talk, email, webhook) |

---

## Què NO Copiar

| Element | Raó |
|---|---|
| **Web UI SvelteKit gran** | LAIA és CLI-first. Static reports sí; SPA pesada no. |
| **Les 26 skills "as-is"** | Portarien Python; millor crear skills natius a LAIA (JS/prompt). |
| **Model .md com a font PRINCIPAL de memòria** | Brain de LAIA ja és superior. .md com a capa ambient, no com a reemplaçament. |
| **Subprocess-only execution** | LAIA és motor propi multi-provider. No necessita Claude Code CLI com a middleware. |
| **Bubblewrap sandbox** | Linux-specific. LAIA corre a dev machines. Considerar contenidor més endavant. |
| **OCS API per Talk** | LAIA ja té secrets management; usar httpx natiu o fetch. |

---

## Arquitectura Objectiu

```
┌─────────────────────────────────────────────────────────────────┐
│                        LAIA CORE (Node.js)                      │
│                                                                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  ┌───────────┐ │
│  │  Brain    │  │  Hooks    │  │ Plan Engine  │  │ Evolved   │ │
│  │ ambient + │  │ bus (10+  │  │  risk/cost   │  │ Prompt    │ │
│  │ consult.  │  │ events)   │  │  routing     │  │ compiler  │ │
│  └──────────┘  └───────────┘  └──────────────┘  └───────────┘ │
│                                                                 │
│  ┌─ Skill Runtime Layer ──────────────────────────────────────┐ │
│  │  native (default)  │  subprocess (sandbox)  │  prompt-only │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─ I/O Channels ────────────────────────────────────────────┐  │
│  │  CLI (repl)  │  Talk (poller)  │  TASKS.md  │  CRON.md   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ Output Surfaces ─────────────────────────────────────────┐  │
│  │  Terminal  │  Talk  │  Email  │  ntfy  │  Static HTML     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ Scheduler (daemon mode) ─────────────────────────────────┐  │
│  │  Sleep Cycle │ CRON jobs │ Heartbeat │ Briefings │ Poller │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ Human Gate ──────────────────────────────────────────────┐  │
│  │  Confirmation policies (always / risk-based / never)      │  │
│  │  Approval via Talk (yes/no) or CLI (interactive prompt)   │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Sprint 1 — Sleep Cycle + Memòria Ambient

**Durada estimada:** 1 setmana
**Objectiu:** Consolidació automàtica de memòria + context ambient sense query.

### 1.1 Sleep Cycle

**Què fa:** Al final de cada sessió (o via cron nocturn), analitza les interaccions del dia i n'extreu memòries compactes.

**Implementació:**

```
src/services/sleep-cycle.js
```

| Component | Detall |
|---|---|
| **Trigger** | Hook `SessionEnd` + cron extern (`0 3 * * *` via crontab) |
| **Input** | Session notes del dia (de `~/laia-data/memory/sessions/`) |
| **Procés** | 1. Recull sessions del dia → 2. Budget-aware truncation (40% head + 60% tail) → 3. Prompt LLM amb memòries existents (per dedup) → 4. LLM retorna bullets o `NO_NEW_MEMORIES` sentinel |
| **Output** | `~/laia-data/memory/daily/YYYY-MM-DD.md` — memories consolidades |
| **Dedup** | Prompt inclou memòries existents amb instrucció "NO repetir" |
| **Budget** | 50K chars màxim de day data, distribució proporcional per sessió |

**Patrons d'Istota adoptats:**
- Budget-aware truncation (head 40% + tail 60%)
- Sentinel `NO_NEW_MEMORIES` per evitar fitxers buits
- Dedup via prompt-level injection

**Fitxers a crear:**

```javascript
// src/services/sleep-cycle.js
export async function runSleepCycle(options = {}) {
  // 1. Collect today's session notes
  // 2. Budget-aware truncation
  // 3. Build extraction prompt with existing memories
  // 4. Call LLM (sonnet for cost, opus for quality)
  // 5. Parse output, skip if NO_NEW_MEMORIES
  // 6. Write to ~/laia-data/memory/daily/YYYY-MM-DD.md
  // 7. Emit hook: SleepCycleCompleted
}
```

**Nou hook:** `SleepCycleCompleted` → payload: `{ date, memoriesExtracted, file }`

**Cron entry (manual):**
```bash
# ~/.laia/crontab
0 3 * * * cd /home/yuri/laia && node bin/laia.js --sleep-cycle
```

**CLI flag:**
```bash
laia --sleep-cycle          # executar manualment
laia --sleep-cycle --dry    # veure què extrauria sense escriure
```

### 1.2 Memòria Ambient — Tancar els 3 forats reals

LAIA ja té 7 capes de memòria governades. El que falta NO és "tot un sistema ambient" — són **3 peces concretes** que tanquen els forats amb la infra existent.

#### Forat A: Daily Memories (output del sleep cycle → P5)

**Problema:** LAIA no sap què va passar ahir si l'agent no fa `brain_get_context`.

**Solució:** El sleep cycle genera `~/laia-data/memory/daily/YYYY-MM-DD.md`. Afegir-los a `unified-view.js` (P5 Typed Memory) com a nou tipus `daily`.

```javascript
// Afegir a unified-view.js:
import { loadDailyMemories } from './daily-loader.js';

// Dins buildUnifiedMemoryContext(), després dels typed memories:
const dailyMemories = loadDailyMemories(3); // últims 3 dies
if (dailyMemories) {
  lines.push('## Recent Days', '', dailyMemories, '');
  currentBytes += Buffer.byteLength(dailyMemories);
}
```

**Fitxer nou:** `src/memory/daily-loader.js` (~40 LOC)
- Llegeix `~/laia-data/memory/daily/YYYY-MM-DD.md` dels últims N dies
- Respecta el budget de P5 (4KB compartit amb typed memories)
- Si no hi ha sleep cycle output → no injecta res (graceful)

**Efecte:** "Ahir l'usuari va migrar el servei X a Kubernetes" apareix al prompt sense que l'agent busqui.

#### Forat B: Auto-Recall BM25 (cerca implícita amb el prompt)

**Problema:** `brain_search` existeix però l'agent l'ha d'invocar. Istota fa cerca automàtica (línia 1851 d'executor.py):
```python
recalled_memories = _recall_memories(config, conn, task)
# → search(conn, user_id, task.prompt, limit=3)
```

**Solució:** Hook `SessionStart` que fa brain_search amb el primer missatge de l'usuari i injecta el resultat com a P4 (Task Context).

```javascript
// Afegir a hooks/auto-recall.js:
import { emit } from './bus.js';

export async function onSessionStart({ userMessage, brainSearch }) {
  if (!userMessage) return;
  const results = await brainSearch(userMessage, { limit: 3 });
  if (results?.length) {
    // Injectar com a context P4 via prompt-governance
    return {
      contextChunk: {
        id: 'auto-recall',
        text: formatRecallResults(results),
        priority: PRIORITY.TASK_CONTEXT,
        maxChars: 2000,
      }
    };
  }
}
```

**Fitxer nou:** `src/hooks/auto-recall.js` (~60 LOC)
- Cerca BM25+embeddings amb el primer missatge
- Injecta top-3 resultats com a P4 Task Context
- Budget: 2KB max dins el pressupost de P4
- Si brain no disponible → no-op (graceful)
- **Guardes (consens amb CODEX):**
  - Timeout curt (2s) per no penalitzar primer torn
  - Skip si missatge trivial (< 10 chars o salutació)
  - Llindar mínim de score (descartar resultats soroll)
  - Cache per sessió (no relançar si ja s'ha fet)

**Efecte:** "Quina era l'URL de staging?" → l'agent ja ho sap abans de pensar a buscar.

#### Forat C: Active Tasks (TASKS.md → P5)

**Problema:** LAIA no sap què tens entre mans.

**Solució:** Si TASKS.md existeix a Nextcloud, carregar-lo i afegir tasques pendents a P5.

```javascript
// Afegir a unified-view.js o daily-loader.js:
const pendingTasks = loadActiveTasks(); // des de cache local, actualitzat per poller
if (pendingTasks) {
  lines.push('## Active Tasks', '', pendingTasks, '');
}
```

**Integrat amb:** `src/channels/tasks-file.js` (que ja està al Sprint 1.3)
- El poller descarrega TASKS.md periòdicament
- `loadActiveTasks()` llegeix la cache local (no WebDAV en calent)
- Budget: 0.5KB dins P5

#### Resum: què toquem i què NO

```diff
  prompt-governance.js (P1-P7):  NO es toca — ja és correcte
  evolved-prompt.js:              NO es toca — ja compila learnings
  unified-view.js:                MODIFICAR — afegir daily memories + active tasks a P5
  system-prompt.js:               NO es toca — ja munta les 7 capes
+ src/memory/daily-loader.js     NOU — carrega daily memories (~40 LOC)
+ src/hooks/auto-recall.js       NOU — cerca implícita al SessionStart (~60 LOC)
```

**Total: ~100 LOC nous + ~20 LOC modificats. Zero canvi arquitectural.**

#### Sub-budgets P5 (consens amb CODEX)

P5 Typed Memory (4KB total) es divideix en sub-budgets interns:

| Sub-capa | Budget | Font |
|---|---|---|
| Typed memories (user/feedback/project/reference) | 2.5KB | unified-view.js (existent) |
| Daily memories (últims 3 dies) | 1.0KB | daily-loader.js (nou) |
| Active tasks (TASKS.md) | 0.5KB | tasks-file.js cache (nou) |

Si es detecta truncació recurrent → ampliar P5 a 6KB (decisió basada en telemetria, no a priori).

#### Quality Gates (consens amb CODEX)

Mètriques d'èxit post-implementació:

| Mètrica | Target |
|---|---|
| % sessions amb recall útil (no buit) | > 60% |
| % truncació P5 (informació perduda) | < 10% |
| Latència extra primer torn (auto-recall) | < 2s |
| Incidències de context erroni (fals positiu) | < 5% |

**Rollout:** Feature flags independents per cada forat (A/B/C) permetent rollback individual:
```json
{
  "daily_memories_enabled": true,
  "auto_recall_enabled": true,
  "tasks_ingest_enabled": true
}
```

#### Comparativa amb Istota

| Aspecte | Istota | LAIA (després dels 3 forats) |
|---|---|---|
| Preferències d'usuari | USER.md literal, carregat sencer | P3 Evolved Stable (compilat, amb expiry) ✅ millor |
| Context de conversa | CHANNEL.md literal | Session notes + P4 context ⚠️ equivalent |
| Memòria temporal | Dated memories (últims N dies) | Daily memories a P5 (amb budget) ✅ equivalent |
| Auto-recall | BM25 automàtic amb el prompt | Hook SessionStart BM25+embeddings ✅ equivalent |
| Dedup/ownership | No (fitxers literals) | Ownership matrix + bridge promotion ✅ millor |
| Budget governance | Cap fix per memòria (head+tail truncation) | 7 prioritats amb bottom-up truncation ✅ millor |
| Staleness | No | Warnings + 30-day adaptive expiry ✅ millor |

### 1.3 TASKS.md Ingest

**Què fa:** Monitora un fitxer TASKS.md a Nextcloud (via WebDAV) per rebre tasques.

**Implementació:**

```
src/channels/tasks-file.js
```

| Component | Detall |
|---|---|
| **Format** | Markdown checkboxes: `- [ ]` pendent, `- [~]` en curs, `- [x]` completat, `- [!]` error |
| **Polling** | Cada 60s (configurable) via WebDAV PROPFIND + GET si etag canviat |
| **Dedup** | Content-hash SHA256 del text normalitzat (sense timestamps ni status) |
| **Escriptura** | Actualitza markers d'estat via WebDAV PUT després de completar |

**Secrets necessaris:** `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_PASSWORD` (ja existents)

**Ruta Nextcloud:** `/LAIA/TASKS.md` (configurable)

---

## Sprint 2 — Talk + Confirmation Flow + CRON.md

**Durada estimada:** 1-2 setmanes
**Objectiu:** LAIA accessible des de Nextcloud Talk (mòbil/desktop) + tasques programades.

### 2.1 Talk Integration

**Què fa:** LAIA escolta missatges de Nextcloud Talk i respon per la mateixa via.

**Implementació:**

```
src/channels/talk.js        — Talk API client
src/channels/talk-poller.js — Polling loop
```

| Component | Detall |
|---|---|
| **API** | Nextcloud Talk **User API** (no Bot API) — com fa Istota |
| **Auth** | App password (ja a secrets store) |
| **Polling** | Long-poll amb `lookIntoFuture=1` per cada conversa |
| **Caching** | TTL 60s per conversation list, 300s per participants |
| **Stale fallback** | Si API falla, usar cache expirada |
| **@mention** | En grups (≥3 participants), només respon si @mencionat |
| **Attachments** | Fitxers compartits al xat → descarregats i processats |

**Secrets nous necessaris:**
```
NEXTCLOUD_TALK_TOKEN    # Token de la conversa 1:1 amb l'usuari
```

**Flow:**
```
Talk message → talk-poller.js → parse + clean → task queue
                                                    ↓
task queue → LAIA core (LLM) → result → talk.js → Talk response
```

**Patrons d'Istota adoptats:**
- `clean_message_content()` — substituir `{file0}` i `{mention-user0}` per text llegible
- `is_bot_mentioned()` — només activar per @mention en grups
- `extract_attachments()` — descarregar fitxers compartits
- TTL cache amb clock monotònic per resiliència

### 2.2 Confirmation Flow

**Què fa:** Quan LAIA detecta una acció de risc, pausa i demana confirmació via Talk (o CLI interactiu).

**Implementació:**

```
src/services/confirmation.js
```

| Component | Detall |
|---|---|
| **Detecció** | Regex sobre output LLM: `(?:proceed|confirm|approve|continue)\??` |
| **Pausa** | Task marcada com `pending_confirmation` a la cua |
| **Aprovació** | Via Talk: resposta "sí"/"yes" → reprèn. "no"/"cancel" → cancela |
| **Via CLI** | Prompt interactiu estàndard (readline) |
| **Timeout** | 30 min (configurable). Si expira → cancel·lat |

**Risk levels per skill:**

```yaml
# A skill.toml
[risk]
level = "high"          # high/medium/low/safe
requires_confirmation = true
dangerous_operations = ["delete", "deploy", "transfer"]
```

### 2.3 CRON.md Parser

**Què fa:** L'usuari escriu jobs programats en format Markdown amb blocs TOML, LAIA els converteix en cron jobs.

**Implementació:**

```
src/channels/cron-file.js
```

**Format d'entrada (CRON.md a Nextcloud):**

```markdown
# Scheduled Jobs

## Briefing matinal
\```toml
name = "morning-briefing"
cron = "0 7 * * 1-5"
prompt = "Genera el briefing del matí: calendari, emails pendents, tasques"
\```

## Backup check
\```toml
name = "backup-health"
cron = "0 22 * * *"
command = "restic snapshots --latest 1 --json"
silent_unless_action = true
\```
```

| Component | Detall |
|---|---|
| **Parsing** | Regex extreu blocs ` ```toml ``` ` → `tomli`-equivalent (TOML.parse en JS) |
| **Validació** | Camps requerits: `name`, `cron`. Mutualment exclusius: `prompt` vs `command` |
| **Sync** | Compara amb jobs actius, actualitza/crea/elimina diferencial |
| **Execució** | `croniter`-equivalent en JS per determinar next run |

**Dependència nova:** `cron-parser` (npm) per expressions cron.

**Ruta Nextcloud:** `/LAIA/CRON.md`

---

## Sprint 3 — Daemon + Reports + Notificacions

**Durada estimada:** 1-2 setmanes
**Objectiu:** Mode daemon persistent + reports visuals + notificacions push.

### 3.1 Daemon Mode

**Què fa:** `laia daemon` engega un procés persistent que coordina Talk polling, CRON jobs, sleep cycle, i heartbeat.

**Implementació:**

```
src/daemon/index.js          — Entry point
src/daemon/scheduler.js      — Main loop
src/daemon/task-queue.js     — SQLite task queue
src/daemon/worker-pool.js    — Workers amb concurrència controlada
```

| Component | Detall |
|---|---|
| **Entry** | `laia daemon [--foreground] [--port 3847]` |
| **Process** | Single process, signal handlers (SIGTERM, SIGHUP) |
| **Lock** | `flock` sobre `~/.laia/daemon.lock` |
| **Main loop** | `setInterval` amb cicles de: poll Talk → check CRON → process queue |
| **Task queue** | SQLite (mateixa DB del brain?) amb lifecycle: `pending → locked → running → completed/failed` |
| **Workers** | Pool de 2-4 workers (configurable), un per tasca concurrent |
| **Graceful shutdown** | Flag `shutdownRequested`, acabar tasca actual, guardar estat |
| **Config reload** | SIGHUP → recarrega config sense restart |
| **Health** | Endpoint HTTP `/health` (port configurable) |

**Flags nous:**
```json
{
  "daemon_enabled": true,
  "daemon_port": 3847,
  "daemon_max_workers": 2,
  "daemon_poll_interval_ms": 30000
}
```

**Systemd service (exemple):**
```ini
[Unit]
Description=LAIA AI Agent Daemon
After=network.target

[Service]
ExecStart=/usr/bin/node /home/yuri/laia/bin/laia.js daemon
WorkingDirectory=/home/yuri
Restart=on-failure
RestartSec=10
EnvironmentFile=/home/yuri/.laia/.env

[Install]
WantedBy=multi-user.target
```

### 3.2 Static Reports + OIDC Auth

**Què fa:** Serveix HTML estàtic (briefings, heartbeat, task history) protegit per login Nextcloud.

**Implementació:**

```
src/daemon/web-server.js    — Mini HTTP server (Fastify o http natiu)
src/reports/                — Generadors de reports HTML
```

| Component | Detall |
|---|---|
| **Server** | Integrat al daemon, mateix port (3847) |
| **Auth** | nginx `auth_request` → `/api/auth-check` → valida session cookie Nextcloud OIDC |
| **Reports** | HTML generat per templates (no SPA, no build step) |
| **Rutes** | `/reports/briefing/latest`, `/reports/heartbeat`, `/reports/tasks` |

**nginx config (exemple):**
```nginx
location /laia/ {
    auth_request /laia/api/auth-check;
    error_page 401 = @nc_login;
    proxy_pass http://127.0.0.1:3847/;
}
```

**Reports HTML:**
- Briefing del matí (últim generat)
- Dashboard heartbeat (últims resultats)
- Historial de tasques (últimes 50, amb estat)

### 3.3 Notificacions Multi-Canal

**Què fa:** Dispatcher unificat que envia notificacions per Talk, email, o ntfy segons preferències.

**Implementació:**

```
src/services/notifications.js
```

| Surface | Mètode | Dependència |
|---|---|---|
| **Talk** | POST a Nextcloud Talk API | talk.js |
| **Email** | SMTP via nodemailer o script existent | Secrets SMTP |
| **ntfy** | HTTP POST a ntfy.sh (self-hosted o públic) | Secret NTFY_TOPIC |

**Dispatch logic:**
```javascript
export async function notify(message, { surface = 'talk', user, subject }) {
  // surface: 'talk' | 'email' | 'ntfy' | 'both' | 'all'
  // Cascading resolution: explicit → user config → global config
  const results = await Promise.allSettled([
    surface.includes('talk') && sendTalk(message, user),
    surface.includes('email') && sendEmail(message, user, subject),
    surface.includes('ntfy') && sendNtfy(message, user),
  ]);
  // Log failures but don't throw if at least one succeeded
}
```

**Secrets nous:**
```
NTFY_TOPIC      # Topic ntfy (push notifications)
NTFY_TOKEN      # Auth token (opcional si self-hosted)
SMTP_HOST       # Servidor SMTP
SMTP_USER       # Usuari SMTP
SMTP_PASSWORD   # Password SMTP
```

---

## Sprint 4 — Heartbeat + Briefings

**Durada estimada:** 1-2 setmanes
**Objectiu:** Monitoring proactiu + resums diaris automàtics.

### 4.1 Heartbeat Monitoring

**Què fa:** Executa checks periòdics definits per l'usuari i notifica quan algo falla.

**Implementació:**

```
src/services/heartbeat.js
```

**Configuració (HEARTBEAT.md a Nextcloud, format Markdown+TOML):**

```markdown
# Heartbeat Monitoring

## Settings
\```toml
conversation_token = "abc123"
quiet_hours = ["23:00-07:00"]
default_cooldown_minutes = 60
\```

## Server health
\```toml
name = "main-server"
type = "url-health"
url = "https://example.com/health"
expected_status = 200
interval_minutes = 5
\```

## Nextcloud sync
\```toml
name = "nc-webdav"
type = "shell-command"
command = "curl -sf -u $NC_USER:$NC_PASS $NC_URL/remote.php/dav/ -o /dev/null"
\```

## Backups
\```toml
name = "restic-backup"
type = "shell-command"
command = "restic snapshots --latest 1 --json | jq '.[0].time'"
max_age_hours = 26
\```
```

| Check Type | Descripció |
|---|---|
| `url-health` | HTTP GET, valida status code |
| `shell-command` | Executa comanda, exit code 0 = healthy |
| `file-watch` | Comprova que fitxer existeix i no és massa vell |
| `calendar-conflicts` | Comprova conflictes al calendari Nextcloud |

**Features:**
- Quiet hours (cross-midnight support, e.g. `23:00-07:00`)
- Cooldown per check (no spam)
- Interval per check (no tots cada cicle)
- Stale/recovered detection
- Notificació via surface configurat

### 4.2 Briefings Programats

**Què fa:** Genera resums matinals/vespertins amb calendari, emails, tasques, mercats, feeds.

**Implementació:**

```
src/services/briefing.js
```

**Configuració (BRIEFINGS.md a Nextcloud):**

```markdown
# Briefings

## Morning
\```toml
name = "morning"
cron = "0 7 * * 1-5"
conversation_token = "abc123"
sections = ["calendar", "emails", "tasks", "weather"]
\```

## Evening
\```toml
name = "evening"
cron = "0 20 * * *"
sections = ["day-summary", "tomorrow-preview"]
\```
```

| Secció | Font |
|---|---|
| `calendar` | CalDAV via Nextcloud |
| `emails` | IMAP inbox (últimes no llegides) |
| `tasks` | TASKS.md pendents |
| `weather` | API pública (OpenMeteo, sense key) |
| `feeds` | RSS/Miniflux (si configurat) |
| `day-summary` | Sleep cycle del dia |
| `tomorrow-preview` | Calendari de demà |

**Output:** Missatge de text per Talk + opcionalment HTML report estàtic.

---

## Model d'Execució Híbrid

**Consens OPUS+CODEX:** LAIA manté motor propi com a default, amb backends pluggables.

### Contracte de Skill (extensió)

```yaml
# skill.toml / SKILL.md frontmatter
schema: 2                           # Nova versió
name: nextcloud-calendar
execution_mode: native              # native | subprocess | prompt-only
risk:
  level: low                        # high | medium | low | safe
  requires_confirmation: false
  dangerous_operations: []
```

| Mode | Quan usar |
|---|---|
| `native` | Default. Codi/tools directes dins el procés LAIA. Ràpid. |
| `subprocess` | Skills de tercers, operacions arriscades, o quan cal sandbox. |
| `prompt-only` | Skills que són pures instruccions per al LLM (com els actuals). |

### Política d'execució

```
if skill.risk.level === 'high' && !skill.requires_confirmation:
  → auto-switch a subprocess + confirm
if skill.execution_mode === 'subprocess':
  → spawn isolat (env net, timeout)
else:
  → native (default, dins el procés)
```

---

## Decisió Final

### Què és millor a cada projecte

| Aspecte | Istota ✅ | LAIA ✅ |
|---|---|---|
| **Operativa daemon** | Més madur (383 commits) | - |
| **Nextcloud integration** | Molt més profunda (26 skills) | - |
| **Sleep cycle** | Més sofisticat (conversation grouping) | - |
| **Talk UX** | Progress messages, file handling | - |
| **Heartbeat** | 6 check types | - |
| **Brain/memòria** | - | Més avançat (embeddings + typed + reflection + bridge) |
| **Multi-provider** | - | Natiu (no lligat a Anthropic) |
| **Skills system** | - | Més flexible (intent matching + hot reload + bundled) |
| **Hooks/events** | - | Arquitectura extensible (8+ events) |
| **Multi-agent** | - | Coordinator mode, /batch (5-20 workers) |
| **Evolved prompt** | - | Auto-compilació (stable + adaptive, 30-day expiry) |
| **Developer tools** | - | Git, review, commit, debug, plan engine |
| **Secrets management** | - | Encrypted-at-rest amb get_secret() |

### Conclusió

> **LAIA té millor cervell; Istota té millor cos.**
>
> L'objectiu és donar a LAIA el cos operatiu d'Istota (daemon, canals, monitors, notificacions) muntat sobre el brain/hook system existent — que és tècnicament superior.
>
> No migrem a subprocess-only. Evolucionem LAIA a un orquestrador amb backends pluggables, on native és el camí ràpid i subprocess el camí segur.

### Nota sobre memòria (revisió post-anàlisi profunda)

La primera versió d'aquest document sobreestimava el treball de memòria ambient perquè no tenia present que `prompt-governance.js` (7 capes P1-P7), `evolved-prompt.js` (dual-layer stable+adaptive), `unified-view.js` (ownership matrix + dedup), i `brain_get_context` (tool call al primer torn) ja cobreixen el 80% del que Istota fa amb USER.md/CHANNEL.md/dated memories.

**El gap real és de 3 forats (~100 LOC nous), no d'un sistema ambient complet.** La infra de governance existent és superior a la d'Istota (que no té budgets, prioritats, ownership, ni staleness management). Només cal alimentar-la amb dades noves (daily memories, auto-recall, active tasks).

### DoD / Go-No-Go (consens OPUS+CODEX)

Finestra de revisió: **30 dies** després de completar Sprint 1.

| Criteri | Target | Go/No-Go |
|---|---|---|
| Sleep cycle genera daily memories | ≥ 80% dels dies amb sessions | Go per Sprint 2 |
| Auto-recall retorna resultats útils | > 60% sessions | Go per ampliar budget |
| Truncació P5 (info perduda) | < 10% | Go per mantenir 4KB (si >10%, ampliar a 6KB) |
| Latència primer torn | < 2s extra | Go (si >2s, optimitzar o desactivar) |
| Falsos positius auto-recall | < 5% | Go (si >5%, pujar llindar score) |

Si algun criteri falla → rollback via feature flag individual (A/B/C).

---

## Resum de Fitxers per Sprint

### Sprint 1 (4-5 fitxers nous, ~300 LOC)
```
src/services/sleep-cycle.js      — Consolidació nocturna (~150 LOC)
src/memory/daily-loader.js        — Carrega daily memories a P5 (~40 LOC)
src/hooks/auto-recall.js          — Cerca implícita SessionStart (~60 LOC)
src/channels/tasks-file.js        — TASKS.md polling via WebDAV (~100 LOC)
+ modificar: src/memory/unified-view.js (~20 LOC)
```

### Sprint 2 (4-6 fitxers nous)
```
src/channels/talk.js              — Nextcloud Talk API client
src/channels/talk-poller.js       — Talk polling loop
src/channels/cron-file.js         — CRON.md parser
src/services/confirmation.js      — Confirmation flow
```

### Sprint 3 (5-7 fitxers nous)
```
src/daemon/index.js               — Daemon entry point
src/daemon/scheduler.js           — Main loop
src/daemon/task-queue.js          — SQLite task queue
src/daemon/worker-pool.js         — Worker pool
src/daemon/web-server.js          — HTTP server per reports
src/services/notifications.js     — Multi-channel dispatcher
```

### Sprint 4 (2-3 fitxers nous)
```
src/services/heartbeat.js         — Health monitoring
src/services/briefing.js          — Scheduled briefings
```

**Total: ~16-20 fitxers nous, estimació 3-5K LOC**

---

*Document viu. Actualitzar a mesura que avancin els sprints.*
