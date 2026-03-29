# 🔍 Avaluació Honesta: Claudia + Claude-Local-Brain

**Data:** 29 març 2026
**Avaluadors:** GPT-5.3-Codex, Claude Sonnet 4.6, Claude Opus 4.6
**Moderador:** Claude Opus 4.6 (sessió activa)

---

## Resum Executiu

Avaluació multi-model independent del sistema Claudia (CLI agent, v1.1.0) + Claude-Local-Brain (MCP server, v2.45.0). Tres models han avaluat el sistema de forma independent i s'han consolidat els resultats.

| Agent | Model | Nota |
|-------|-------|:----:|
| 🟢 Codex | gpt-5.3-codex | **7.8/10** |
| 🔵 Sonnet | claude-sonnet-4.6 | **7.2/10** |
| 🟣 Opus | claude-opus-4.6 | **7.2/10** |
| | **Mitjana** | **7.4/10** |

**Veredicte:** Eina útil i ben construïda que necessita instrumentar-se per pujar de nivell. El salt a 8+ requereix demostrar amb dades que el sistema fa bé el que diu que fa.

---

## Estat Actual del Sistema

### Claudia (CLI Agent)
| Mètrica | Valor |
|---------|-------|
| Versió | 1.1.0 |
| LOC | 6.451 (35 fitxers font) |
| Tests | 254 passant, 0 fallint |
| Dependències | 4 (@claude/providers, @modelcontextprotocol/sdk, fast-glob, yaml) |
| TODO/FIXME/HACK | 0 |
| Runtime | Node.js 24 ESM |
| LLM Backend | GitHub Copilot Business (multi-model) |

### Claude-Local-Brain (MCP Server)
| Mètrica | Valor |
|---------|-------|
| Versió | 2.45.0 |
| LOC | 9.195 (core) + 2.743 (tools) + 2.541 (outlook) = ~14.500 |
| Dependències | 4 (@claude/providers, @huggingface/transformers, @modelcontextprotocol/sdk, zod) |
| Learnings | 1.064 actius |
| Sessions | 133 |
| Projectes | 30 |
| Knowledge files | 144 |
| DB | SQLite + FTS5 + embeddings locals |

---

## ✅ PUNTS FORTS

### 1. Disciplina de dependències excepcional 🟢🔵🟣
4 deps cada component vs ~200 típiques Node.js. Menys superfície d'atac, menys ruptures, menys manteniment. Decisió conscient i ben executada.

### 2. Zero TODO/FIXME/HACK en 20K+ LOC 🟢🔵🟣
254 tests passant amb 0 fallides en un projecte personal és millor que molts projectes professionals. Indica manteniment actiu, no accidental.

### 3. Pipeline de cerca sofisticat 🟢🔵🟣
BM25 + graph expansion + vitality decay + embeddings + LLM reranking + P12.5 dominance penalty. Per un sistema d'un sol desenvolupador, el pipeline de cerca és millor que productes comercials de gestió del coneixement. El vitality decay sol ja resol un problema que la majoria ignoren.

### 4. Massa crítica de dades reals 🟢🔵🟣
1.064 learnings, 133 sessions, 30 projectes. No és prototip, és infraestructura funcional. La prova de foc d'un sistema de memòria és si l'usuari hi confia prou per usar-lo cada dia, i aquí la resposta és sí.

### 5. Integració corporativa real 🟢🔵
35 skills per Jira, Confluence, Jenkins, Outlook, Dynatrace, ServiceNow, SharePoint, Power BI... No és un "toy project", és utilitat operativa diària en un entorn empresarial real.

### 6. Multi-model routing + @claude/providers 🟢🟣
Auto-detecció per model + fallback chain (Copilot → Bedrock → GenAI Lab). Abstracció que paga dividends amb el ritme de canvis als LLMs (models nous cada 2-3 mesos).

### 7. Dual mode (CLI + MCP) 🟢🟣
Funciona com CLI autònom i com MCP server per Claude Code. Maximitza adopció i redueix lock-in d'interfície. Doble ús amb una sola implementació.

---

## 🔴 DEBILITATS CRÍTIQUES

### 1. Bus factor = 1 🟢🔵🟣 — Gravetat: 🔴 ALTA
Un sol usuari, un sol desenvolupador. Si para 3 mesos, tot mor. No hi ha documentació d'operacions, ni runbooks, ni coneixement compartit. No és un problema tècnic — és un problema existencial.

### 2. Zero observabilitat 🟢🔵🟣 — Gravetat: 🔴 ALTA
No es coneix:
- Cost LLM per reranking (quantes crides, quants tokens)
- Latència P50/P95/P99 del pipeline de cerca
- Hits útils vs soroll al retrieval
- Percentatge de learnings que mai es recuperen
- Si el vitality decay mata informació rellevant

*"Estàs pilotant un avió sofisticat sense instruments. Vola, sí. Vola bé? No ho pots demostrar."* — Opus

### 3. Git-sync és una bomba de rellotgeria 🟢🔵🟣 — Gravetat: 🔴 ALTA
SQLite + git = combinació arquitecturalment fràgil. Git no és una base de dades. Un conflicte de merge pot corrompre silenciosament 1.064 learnings. Pull failures admesos com a known issue. Estàs un `git pull` dolent d'una pèrdua de dades significativa.

### 4. Token overhead de 14 tools MCP 🟢🔵🟣 — Gravetat: 🟡 MITJANA
~200 tokens per descripció × 14 tools = ~2.800 tokens per crida. A 100 crides/dia = 280K tokens/dia invisibles. Costos LLM no es mesuren granularment.

### 5. Sense CI/CD 🟢🔵🟣 — Gravetat: 🟡 MITJANA
v2.45.0 sense pipeline automatitzat. Qui verifica que 2.45.0 és millor que 2.44.0? Sense CI/CD, el versionat és decoratiu.

### 6. Acoblament a Copilot Business d'Allianz 🟢🔵🟣 — Gravetat: 🟡 MITJANA
Si l'empresa canvia la política de Copilot, el sistema para. Fallbacks existeixen (Bedrock, GenAI Lab) però no es validen regularment.

### 7. Complexitat de scoring no validada 🔵🟣 — Gravetat: 🟡 MITJANA
6 senyals combinats sense A/B testing ni golden set de queries. Podrien estar anul·lant-se entre ells. Decisions d'optimització basades en intuïció disfressada d'enginyeria.

---

## ⚡ CANVIS URGENTS

| # | Canvi | Esforç | Impacte | Qui ho demana |
|:-:|-------|:------:|:-------:|:-------------:|
| 1 | **Instrumentació mínima** — log JSONL per crida: tool, query, resultats, latència, tokens | 2h | ALT | 🟢🔵🟣 |
| 2 | **Backup SQLite diari** amb timestamp, independent de git-sync | 30min | CRÍTIC | 🔵🟣 |
| 3 | **Reduir tools MCP de 14 a 5-6** essencials; la resta opt-in | 1h | ALT | 🟣 |
| 4 | **Golden set de 30-50 queries** per mesurar qualitat del retrieval objectivament | 1 dia | ALT | 🔵🟣 |
| 5 | **`claudia health`** — health check que verifiqui Copilot, Brain, embeddings, git-sync d'un sol cop | 2h | MITJÀ | 🟢🔵🟣 |

### Prioritat immediata (aquesta setmana):
1. 📊 Log JSONL de crides (2h)
2. 💾 Backup SQLite diari (30min)
3. 🏥 `claudia health` (2h)

---

## 🗑️ COSES INNECESSÀRIES O SIMPLIFICABLES

| Què | Per què | Qui ho diu |
|-----|---------|:----------:|
| **Multi-model debates** | Entretingut, valor pràctic ~0 per un sol usuari. Funcionalitat de demo. | 🔵🟣 |
| **35 skills** | ~10-15 es fan servir; les altres acumulen pols. Auditar ús i arxivar. | 🟢🔵🟣 |
| **GenAI Lab (3r fallback)** | Si arribes al 3r fallback, tens una incidència, no necessites un 3r backend. | 🟢🟣 |
| **brain_web_search** | Si Claudia ja fa cerques web, duplicar-ho al Brain és redundant. | 🟣 |
| **LLM reranking en TOTES les cerques** | Per lookups simples, BM25 + embeddings ja és suficient. Fer-ho condicional. | 🟣 |
| **Semver sense CHANGELOG** | 2.45.0 sense CI/CD és soroll. O versionat real o dates. | 🔵 |

---

## 📊 Desglossat de Puntuació (Opus)

| Factor | Punts |
|--------|:-----:|
| Disciplina tècnica (deps, zero hacks) | +1.5 |
| Massa crítica de dades reals | +1.0 |
| Abstraccions correctes (providers, MCP, YAML) | +0.7 |
| Zero observabilitat | −1.0 |
| No mesurar qualitat del retrieval | −0.8 |
| Complexitat no validada (6 senyals sense A/B) | −0.5 |
| Funcionalitats decoratives | −0.5 |
| **Total** | **7.2/10** |

---

## 📊 Desglossat de Puntuació (Sonnet)

| Factor | Punts |
|--------|:-----:|
| Enginyeria sòlida per entorn personal | +1.5 |
| Integració corporativa real amb utilitat diària | +1.0 |
| Scoring de cerca més bo que productes comercials | +0.7 |
| Git-sync arquitecturalment incorrecte | −1.0 |
| Sense CI/CD en 2.45.0 | −0.8 |
| Token overhead no controlat | −0.5 |
| Acoblament a Copilot/Allianz | −0.5 |
| **Total** | **7.2/10** |

---

## 📊 Desglossat de Puntuació (Codex)

| Factor | Punts |
|--------|:-----:|
| Arquitectura madura per single-dev | +1.5 |
| Ús real amb dades reals | +1.0 |
| Multi-provider robust | +0.8 |
| Bus factor = 1 | −0.5 |
| Sense CI/CD ni gates automàtics | −0.5 |
| Cost no governat | −0.5 |
| Complexitat superior a productització | −0.3 |
| **Total** | **7.8/10** |

---

## Comparativa de Notes

| Àrea | Codex | Sonnet | Opus | Mitjana |
|------|:-----:|:------:|:----:|:-------:|
| Arquitectura | 8.5 | 8.0 | 8.0 | 8.2 |
| Qualitat codi | 9.0 | 8.5 | 8.5 | 8.7 |
| Utilitat real | 8.5 | 8.0 | 7.5 | 8.0 |
| Observabilitat | 4.0 | 3.0 | 3.0 | 3.3 |
| Operacions | 5.0 | 4.0 | 5.0 | 4.7 |
| Escalabilitat | 5.0 | 5.0 | 5.0 | 5.0 |
| **GLOBAL** | **7.8** | **7.2** | **7.2** | **7.4** |

---

## Evolució Històrica

| Data | Avaluació | Nota |
|------|-----------|:----:|
| 2026-03-09 | Primera avaluació (Opus) | 7.4 |
| 2026-03-14 | Codex review | ~7.5 |
| 2026-03-16 | Opus at 8.4 (post-fixes) | 8.4 |
| **2026-03-29** | **Multi-model (3 agents)** | **7.4** |

> La nota ha baixat de 8.4 a 7.4 principalment perquè les debilitats operatives (observabilitat, CI/CD, git-sync) segueixen sense resoldre's malgrat ser identificades repetidament. Codex ho diu clar: *"Sense CI/CD, cada canvi és una aposta."*

---

*Document generat automàticament per Claudia CLI v1.1.0 amb avaluacions independents de 3 models LLM.*
