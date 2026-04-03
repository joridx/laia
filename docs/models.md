# LAIA — Models Disponibles

> Guia completa de tots els models LLM disponibles a LAIA, amb benchmarks i recomanacions.
>
> Última actualització: 2026-04-03 · Benchmarks executats des de Barcelona

---

## Resum Ràpid

| Ús | Model recomanat | Comanda |
|----|-----------------|---------| 
| 🏆 **Agent principal** | `openai/gpt-oss-120b` (Groq) | `/model openai/gpt-oss-120b` |
| 🧠 **Raonament complex** | `moonshotai/kimi-k2-instruct` (Groq) | `/model moonshotai/kimi-k2-instruct` |
| ⚡ **Respostes ràpides** | `cerebras:qwen-3-235b-a22b-instruct-2507` | `/model cerebras:qwen-3-235b-a22b-instruct-2507` |
| 🔧 **Tool calling** | `meta-llama/llama-4-scout-17b-16e-instruct` (Groq) | `/model meta-llama/llama-4-scout-17b-16e-instruct` |
| 🌍 **Coneixement general** | `cerebras:qwen-3-235b-a22b-instruct-2507` | `/model cerebras:qwen-3-235b-a22b-instruct-2507` |
| 💻 **Codi (amb tools)** | `gpt-5.3-codex` (Copilot) | `/model gpt-5.3-codex` |
| 🤖 **Agent workers** | `cerebras:qwen-3-235b-a22b-instruct-2507` | `/model cerebras:qwen-3-235b-a22b-instruct-2507` |
| 📝 **Second opinion** | `moonshotai/kimi-k2-instruct` (Groq) | `/model moonshotai/kimi-k2-instruct` |

---

## Providers Configurats

| Provider | Endpoint | Free Tier | Variable d'entorn | Velocitat |
|----------|----------|-----------|-------------------|-----------|
| **Copilot** | `api.business.githubcopilot.com` | ✅ (subscripció GitHub) | apps.json (auto) | Variable |
| **Groq** | `api.groq.com` | ✅ 6000 req/dia, 6M tok/dia | `GROQ_API_KEY` | 🚀 Ràpid |
| **Cerebras** | `api.cerebras.ai` | ✅ 30 req/min, 1M tok/min | `CEREBRAS_API_KEY` | 🚀🚀 Ultràpid |
| **Google** | `generativelanguage.googleapis.com` | ⚠️ 20 req/dia/model | `GOOGLE_API_KEY` | Mitjana |
| **OpenRouter** | `openrouter.ai/api/v1` | ✅ ~16 models gratis amb tools | `OPENROUTER_API_KEY` | Variable |
| **OpenAI** | `api.openai.com` | 💰 De pagament | `OPENAI_API_KEY` | Mitjana |
| **Anthropic** | `api.anthropic.com` | 💰 De pagament | `ANTHROPIC_API_KEY` | Mitjana |
| **Ollama** | `localhost:11434` | ✅ Local (sense límits) | — | Depèn del HW |

Les claus es configuren a `~/.laia/.env`:
```bash
GROQ_API_KEY=gsk_...
CEREBRAS_API_KEY=csk-...
GOOGLE_API_KEY=AIza...
OPENROUTER_API_KEY=sk-or-v1-...
```

---

## 🏆 Ranking d'Intel·ligència — Free Tier

Test de raonament avançat amb 3 proves: lògica trampa (sheep=18), raonament inductiu (widgets=5min), i codi DP (palindrome).

| # | Model | Provider | Sheep (=18) | Widgets (=5min) | Codi DP | Velocitat | **Score** |
|---|-------|----------|:-----------:|:---------------:|:-------:|:---------:|:---------:|
| 🥇 | **openai/gpt-oss-120b** | Groq | ✅ 18 | ✅ 5min | ✅ | ~600ms | **3/3** |
| 🥇 | **moonshotai/kimi-k2-instruct** | Groq | ✅ 18 | ✅ 5min | ✅ | ~590ms | **3/3** |
| 🥉 | **qwen/qwen3-32b** | Groq | ✅ 18 | ✅ 5min | ⚠️ thinking leak | ~3300ms | **2.5/3** |
| 4 | **cerebras:qwen-3-235b** | Cerebras | ❌ 21 | ✅ 5min | ✅ | ~530ms | **2/3** |
| 4 | **meta-llama/llama-4-scout** | Groq | ❌ 21 | ✅ 5min | ✅ | ~660ms | **2/3** |
| 4 | **google:gemini-3.1-flash-lite** | Google | ❌ 17 | ✅ 5min | ✅ | ~1370ms | **2/3** |

> 💡 **gpt-oss-120b** i **kimi-k2** són els models gratis més intel·ligents, amb 3/3 tests correctes i ~600ms.
> ⚠️ **kimi-k2** al·lucina tool calls — no usar com a agent principal, sí com a second opinion.
> ⚠️ **qwen3-32b** filtra tokens de "thinking" (`<think>...</think>`) al output.

---

## 🌍 Ranking de Coneixement General — Free Tier

Test amb pregunta real de coneixement factual: *"Donem info del poble La Sentiu de Sió: on és, comarca, habitants..."*
La resposta correcta: **comarca de la Noguera**, província de Lleida, municipi propi.

| # | Model | Provider | Temps | Comarca | Qualitat | Observacions |
|---|-------|----------|------:|:-------:|:--------:|-------------|
| 🥇 | **cerebras:qwen-3-235b** | Cerebras | 7.7s | ✅ Noguera | 🏆 Molt completa | Municipi, comarca, província — tot correcte |
| 🥈 | **groq:kimi-k2** | Groq | 1.9s | ✅ Noguera | Bona | Precís, bona estructura |
| 🥉 | **google:gemini-3.1-lite** | Google | 2.9s | ✅ Noguera | Bona | Menciona el riu Sió correctament |
| 4 | **groq:llama-3.3-70b** | Groq | 1.9s | ✅ Noguera | ⚠️ | Diu que pertany a Térmens (fals — és municipi propi) |
| 5 | **groq:llama-4-scout** | Groq | 1.0s | ❌ Segarra | ❌ | Comarca incorrecta, inventa dades |
| 6 | **cerebras:llama-8b** | Cerebras | 0.6s | ❌ Pla d'Urgell | ❌ | Tot inventat |
| — | **groq:gpt-oss-120b** | Groq | 1.1s | — | (empty) | Thinking esgota max_tokens |
| — | **groq:qwen3-32b** | Groq | 1.1s | — | (thinking raw) | Mostra `<think>` sense arribar a respondre |
| — | **google:gemini-3-flash** | Google | 56.6s | — | (empty) | Thinking massiu, 56s per res |
| — | **openrouter:nemotron-120b** | OpenRouter | 10.6s | — | (thinking raw) | Thinking visible, no arriba a resposta útil |
| — | **openrouter:qwen3.6-plus** | OpenRouter | 0.9s | ❌ Error | 429 | Rate limited constantment |
| — | **openrouter:qwen3-coder** | OpenRouter | 0.5s | ❌ Error | 429 | Rate limited constantment |

> 🏆 **cerebras:qwen-3-235b** és el millor en coneixement factual — la resposta més completa i correcta.
> 💡 **kimi-k2** és ràpid i precís, bona alternativa.
> ⚠️ Models amb "thinking" (gpt-oss-120b, qwen3-32b, nemotron) gasten tokens en raonament intern i no arriben a respondre amb `max_tokens` limitats.
> ❌ **OpenRouter free tier** — molt poc fiable (429 constants, thinking raw).

---

## Benchmark Complet

### Metodologia

**Ronda 1** — 4 tests per model (`max_tokens=800`):

1. **Codi** — Generar una funció JS one-liner (top 3 únics d'un array)
2. **Raonament** — Problema lògic trampa ("totes menys 8 moren")
3. **Tool calling** — Cridar `read("package.json")` correctament
4. **Català** — Explicar Montserrat en 1 frase en català

**Ronda 2** — 3 tests de raonament avançat:

1. **Sheep** — "17 sheep, all but 9 die, buys 5, 2 give birth to twins" (=18)
2. **Widgets** — "5 machines 5 min 5 widgets, 100 machines 100 widgets?" (=5min)
3. **Codi DP** — Longest palindromic substring amb dynamic programming

**Ronda 3** — Coneixement factual:

1. **La Sentiu de Sió** — Preguntes sobre un poble real (comarca, habitants, ubicació)

### Resultats per Provider

#### 🏅 Groq (LPU Inference — el millor free tier)

| Model | Params | Codi | Raonament | Tool Call | Català | Coneixement | Mitjana | IQ Score |
|-------|--------|------|-----------|-----------|--------|:-----------:|---------|:--------:|
| **openai/gpt-oss-120b** | 120B | ✅ 419ms | ✅ 617ms | ✅ 242ms | ✅ 364ms | ⚠️ thinking | **410ms** | 🏆 **3/3** |
| **moonshotai/kimi-k2-instruct** | 1T (MoE 32B) | ✅ 324ms | ✅ 590ms | ❌ 458ms | ✅ 343ms | ✅ Noguera | **429ms** | 🏆 **3/3** |
| **meta-llama/llama-4-scout** | 109B (MoE 17B) | ✅ 982ms | ❌ 199ms | ✅ 225ms | ✅ 267ms | ❌ Segarra | **403ms** | 2/3 |
| **llama-3.3-70b-versatile** | 70B | ✅ 249ms | ❌ 170ms | ✅ 281ms | ✅ 546ms | ⚠️ Noguera* | **312ms** | 2/3 |
| **qwen/qwen3-32b** | 32B | ✅ 1604ms | ✅ 1158ms | ✅ 359ms | ✅ 1021ms | ⚠️ thinking | **1036ms** | 2.5/3 |
| **openai/gpt-oss-20b** | 20B | ✅ 336ms | ❌ 136ms | ✅ 164ms | ✅ 243ms | — | **220ms** | 1/3 |
| **llama-3.1-8b-instant** | 8B | ✅ 128ms | ❌ 84ms | ✅ 212ms | ✅ 240ms | — | **166ms** | 1/3 |

> \* llama-3.3-70b diu que La Sentiu de Sió pertany a Térmens (incorrecte — és municipi propi).
>
> 💡 **gpt-oss-120b** és el rei: el model gratis més intel·ligent (3/3) amb tool calling perfecte.
> **kimi-k2** igual d'intel·ligent amb bon coneixement factual — ideal per second opinion.
> **llama-4-scout** és el millor tool caller de Groq, molt ràpid per agent workers.

#### 🏅 Cerebras (Wafer-Scale Engine — el hardware més ràpid)

| Model | Params | Codi | Raonament | Tool Call | Català | Coneixement | Mitjana | IQ Score |
|-------|--------|------|-----------|-----------|--------|:-----------:|---------|:--------:|
| **qwen-3-235b-a22b-instruct-2507** | 235B (MoE 22B) | ✅ 530ms | ❌ 396ms | ✅ 752ms | ✅ 401ms | 🏆 Noguera | **520ms** | 2/3 |
| llama3.1-8b | 8B | ❌ 687ms | ❌ 3545ms | ✅ 14224ms | ✅ 905ms | ❌ Pla d'Urgell | 4840ms | 0/3 |

> 💡 **Qwen 235B a Cerebras** — el millor en coneixement factual de tot el free tier.
> Falla en raonament trampa, però excel·lent en codi, tools i coneixement general.
> Ideal per agent workers i respostes ràpides.
> ⚠️ llama3.1-8b és massa petit per a ús agent — inventa dades.

#### 🏅 Google (Gemini — thinking models)

| Model | Params | Codi | Raonament | Tool Call | Català | Coneixement | Mitjana | IQ Score |
|-------|--------|------|-----------|-----------|--------|:-----------:|---------|:--------:|
| **gemini-2.5-flash** | ~MoE | ✅ 3313ms | ✅ 1044ms | ✅ 1285ms | ✅ 4228ms | — (quota) | **2468ms** | 2/3 |
| **gemini-3.1-flash-lite-preview** | ~MoE | ✅ 640ms | ❌ 1134ms | ✅ 586ms | ✅ 1268ms | ✅ Noguera | **907ms** | 2/3 |
| **gemini-3-flash-preview** | ~MoE | ✅ 26288ms | ❌ 12491ms | ✅ 14846ms | ✅ 48212ms | ❌ (empty) | 25459ms | 1/3 |
| gemini-2.5-flash-lite-preview | ~MoE | ❌ 91ms | ❌ 88ms | ❌ 90ms | ❌ 92ms | — | — | — |

> ⚠️ **Free tier: 20 requests/dia per model** (no 1500 com diu la doc antiga). Cada model té comptador independent,
> així que repartint entre 3 models (2.5-flash + 3-flash-preview + 3.1-flash-lite) tens ~60 req/dia.
>
> 💡 **gemini-2.5-flash** fa "thinking" profund i és precís, però molt lent i amb quota molt limitada.
> **gemini-3.1-flash-lite-preview** és més ràpid, bon coneixement factual — bona opció backup.
> ⚠️ **gemini-3-flash-preview** massa lent (12-48s) i buida amb preguntes de coneixement. No recomanat.
> ⚠️ **gemini-2.5-flash-lite** no funciona (respostes buides).
> ❌ **Tots els models "Pro"** (2.5-pro, 3-pro, 3.1-pro) tenen quota 0 — requereixen pagament.
> ❌ **gemini-2.0-flash / 2.0-flash-lite** — eliminats del free tier (quota 0).

#### 🏅 OpenRouter (Aggregator — models de tercers)

| Model | Params | Tool Call | Coneixement | Temps | Notes |
|-------|--------|:---------:|:-----------:|------:|-------|
| **nvidia/nemotron-3-super-120b:free** | 120B MoE | ✅ | ⚠️ thinking raw | 10.6s | Funciona però lent, mostra thinking |
| **qwen/qwen3.6-plus:free** | ~MoE | ✅ | ❌ 429 | 0.9s | Constantment rate limited |
| **qwen/qwen3-coder:free** | 480B MoE | ✅ | ❌ 429 | 0.5s | Constantment rate limited |

> ⚠️ **OpenRouter free tier és poc fiable** — molts models estan constantment en 429 perquè comparteixen
> quota amb tots els users free. Només **nemotron-120b** funciona de forma regular.
> 💡 Útil com a últim recurs — té 16 models gratis amb tool support.
> El free tier millora afegint targeta de crèdit (sense gastar) a [openrouter.ai/settings](https://openrouter.ai/settings).

#### 🏅 Copilot (GitHub — inclòs amb subscripció)

| Model | Codi | Tool Call | Raonament | Notes |
|-------|------|-----------|-----------|-------|
| **gpt-5.3-codex** | 🏆 Excel·lent | ✅ Natiu | ✅ | El millor per codi, usa /responses endpoint |
| **claude-opus-4.6** | 🏆 Excel·lent | ✅ | 🏆 | El millor en raonament complex i output llarg |
| claude-sonnet-4.6 | Molt bo | ✅ | Molt bo | Ràpid, bon equilibri |
| gpt-5-mini | Bo | ✅ | Bo | Econòmic, ràpid |

> 💡 Copilot no té límit de requests (subscripció flat), però depèn de la disponibilitat del servei.

---

## Matriu de Capacitats

| Model | Intel·ligència | Codi | Tool Call | Coneixement | Velocitat | Cost | Recomanació |
|-------|:--------------:|:----:|:---------:|:-----------:|:---------:|:----:|-------------|
| openai/gpt-oss-120b | 🏆 3/3 | ✅ | ✅ | ⚠️ | 🚀 410ms | Free | **Agent principal** |
| moonshotai/kimi-k2 | 🏆 3/3 | ✅ | ❌ | ✅ | 🚀 429ms | Free | **Second opinion / raonament** |
| cerebras:qwen-3-235b | ⭐ 2/3 | ✅ | ✅ | 🏆 | 🚀🚀 520ms | Free | **Workers / coneixement** |
| qwen/qwen3-32b | ⭐ 2.5/3 | ✅ | ✅ | ⚠️ | 🐌 1036ms | Free | Thinking model econòmic |
| meta-llama/llama-4-scout | ⭐ 2/3 | ✅ | ✅ | ❌ | 🚀 403ms | Free | **Millor tool caller gratis** |
| gemini-2.5-flash | ⭐ 2/3 | ✅ | ✅ | ✅ | 🐌 2468ms | Free | Thinking profund (20 req/dia) |
| gemini-3.1-flash-lite | ⭐ 2/3 | ✅ | ✅ | ✅ | 🚀 907ms | Free | Backup Google |
| llama-3.3-70b | ⭐ 2/3 | ✅ | ✅ | ⚠️ | 🚀🚀 312ms | Free | General purpose |
| nvidia/nemotron-120b | ⭐ ?/3 | ✅ | ✅ | ⚠️ | 🐌 10.6s | Free | Backup OpenRouter |
| gpt-oss-20b | ⭐ 1/3 | ✅ | ✅ | — | 🚀🚀🚀 220ms | Free | Tasques trivials |
| llama-3.1-8b | ⭐ 1/3 | ✅ | ✅ | ❌ | 🚀🚀🚀 166ms | Free | Ultra ràpid, baixa qualitat |
| gpt-5.3-codex | 🏆 | 🏆 | ✅ | 🏆 | Variable | Copilot | **El millor per codi** |
| claude-opus-4.6 | 🏆 | 🏆 | ✅ | 🏆 | Variable | Copilot | **El millor en raonament** |

**Llegenda**: 🏆 Excel·lent · ⭐ Bo · ✅ Correcte · ⚠️ Parcial · ❌ Falla · 🚀 Ràpid · 🐌 Lent

---

## Recomanacions per Cas d'Ús

### 🤖 Agent LAIA (ús interactiu amb tools)
```
/model openai/gpt-oss-120b
```
El model gratis més intel·ligent (3/3) amb tool calling perfecte i ~600ms. 6000 req/dia a Groq.

### 🧠 Raonament complex (arquitectura, plans, debug difícil)
```
/model moonshotai/kimi-k2-instruct
```
Igual d'intel·ligent que gpt-oss-120b (3/3), ideal per second opinion. No usar per agent (falla tools).
O bé `/model claude-opus-4.6` si tens Copilot.

### 🌍 Coneixement general (preguntes factuals, investigació)
```
/model cerebras:qwen-3-235b-a22b-instruct-2507
```
🏆 El millor en coneixement factual del free tier. Respostes completes i correctes.

### ⚡ Respostes ràpides i agent workers
```
/model cerebras:qwen-3-235b-a22b-instruct-2507
```
El més ràpid del món (~500ms), bona qualitat, tool calling correcte. Perfecte per `agent()` workers.

### 🔧 Tool calling intensiu (multi-tool, paral·lel)
```
/model meta-llama/llama-4-scout-17b-16e-instruct
```
El tool caller més fiable i ràpid (~230ms per tool call) del free tier.

### 💻 Coding intens (refactors, nous fitxers)
```
/model gpt-5.3-codex
```
El codex de GitHub Copilot és imbatible per codi: 400K context, /responses endpoint natiu.

### 🔍 Multi-model review
```bash
# Des del terminal — 3 perspectives diferents
laia --model openai/gpt-oss-120b -p "Revisa aquest codi: ..."
laia --model moonshotai/kimi-k2-instruct -p "Revisa aquest codi: ..."
laia --model cerebras:qwen-3-235b-a22b-instruct-2507 -p "Revisa aquest codi: ..."
```

---

## Setup Recomanat per a Ús Diari

```
┌─────────────────────────────────────────────────┐
│  gpt-oss-120b (Groq)     — agent principal      │  🧠 Intel·ligent + Tools
│  cerebras:qwen-3-235b    — workers + coneixement │  ⚡ Ultra ràpid + 🌍 Factual
│  kimi-k2 (Groq)          — second opinion        │  🔍 Raonament
│  gemini-3.1-flash-lite   — backup Google         │  💭 20 req/dia
│  nemotron-120b (OR)      — últim recurs free      │  🔄 OpenRouter backup
│  gpt-5.3-codex (Copilot) — codi complex          │  💻 Codi expert
│  claude-opus-4.6 (Copilot)— raonament profund    │  🏆 La millor qualitat
└─────────────────────────────────────────────────┘
```

---

## Com Afegir Nous Providers

Qualsevol provider OpenAI-compatible es pot afegir en 2 minuts:

1. **Obtenir API key** del provider
2. **Afegir a `~/.laia/.env`**:
   ```bash
   NEWPROVIDER_API_KEY=xxx
   ```
3. **Registrar a `packages/providers/src/providers.js`**:
   ```js
   newprovider: {
     id: 'newprovider',
     baseUrlDefault: 'https://api.newprovider.com/v1',
     auth: 'bearer',
     tokenEnv: 'NEWPROVIDER_API_KEY',
     supports: { chat: true, responses: false, listModels: true },
     extraHeaders: {},
     quirks: {},
   },
   ```
4. **Usar**: `/model newprovider:model-name`

### Providers pendents d'integrar

| Provider | Models | Free Tier | Notes |
|----------|--------|-----------|-------|
| **SambaNova** | Llama 4, DeepSeek V3/R1 | ✅ Unlimited (beta) | `api.sambanova.ai/v1` |
| **Mistral** | Mistral Small, Codestral | ✅ 1B tok/mes | `api.mistral.ai/v1` |
| **DeepSeek** | V3, R1 (reasoning) | ~10M tok gratis | `api.deepseek.com/v1` |

---

## Rate Limits (Free Tier)

| Provider | RPM | RPD | Tokens | Notes |
|----------|-----|-----|--------|-------|
| **Groq** | 30 | 6000 | 6M/dia | 🏆 El més generós. ⚠️ TPM per model varia (8K-30K) |
| **Cerebras** | 30 | ~43K | 1M/min | Ultra ràpid, molt generós |
| **Google** | 10 | **20 per model** | 250K input | ⚠️ Molt limitat. Repartir entre 3 models = ~60 req/dia |
| **OpenRouter** | 10 (200 amb targeta) | Sense límit aparent | Sense límit TPM | ⚠️ 429 freqüents per congestió |
| **Copilot** | — | — | — | Flat rate (subscripció) |

### ⚠️ Nota sobre Groq TPM (Tokens Per Minute)

Els models grans de Groq tenen TPM molt baix en free tier. El system prompt de LAIA (~5K-7K tokens) pot esgotar la quota amb 1-2 torns:

| Model (Groq) | TPM Limit | Torns/min amb LAIA |
|---------------|-----------|--------------------|
| gpt-oss-120b | 8,000 | ~1 |
| kimi-k2 | 10,000 | ~1 |
| qwen3-32b | 6,000 | ~1 |
| llama-4-scout | 30,000 | ~3-4 |
| llama-3.3-70b | 12,000 | ~1-2 |

### Estratègia anti-rate-limit:

1. **Principal**: Groq (gpt-oss-120b) — si dóna 429, esperar 1 min o canviar model
2. **Alternativa ràpida**: Cerebras (qwen-3-235b) — 30 req/min, quasi il·limitat
3. **Backup**: Google (gemini-3.1-flash-lite) — 20 req/dia per model
4. **Últim recurs free**: OpenRouter (nemotron-120b) — lent però funciona
5. **Sense límits**: Copilot — subscripció flat

---

*Generat automàticament per LAIA · [github.com/joridx/laia](https://github.com/joridx/laia)*
