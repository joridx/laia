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
| 🔧 **Tool calling** | `openai/gpt-oss-120b` (Groq) | `/model openai/gpt-oss-120b` |
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

## 🏆 Ranking Combinat — Intel·ligència + Tools + Coneixement

Puntuació final basada en 3 dimensions testejades amb dades reals:
- **IQ Score** (3 punts): lògica trampa, raonament inductiu, codi DP
- **Tool Score** (5 punts): read, grep, bash, multi-tool, brain_search
- **Coneixement**: pregunta factual real (La Sentiu de Sió → comarca de la Noguera)

| # | Model | Provider | IQ | Tools | Coneixement | Velocitat | **Total** | Recomanació |
|---|-------|----------|:--:|:-----:|:-----------:|:---------:|:---------:|-------------|
| 🥇 | **openai/gpt-oss-120b** | Groq | 3/3 | **4/5** | ⚠️ thinking | 🚀 339ms | **7/8** | 🏆 Agent principal |
| 🥈 | **qwen-3-235b** | Cerebras | 2/3 | **4/5** | 🏆 Noguera | 🚀 904ms | **6/8 + 🌍** | Workers + coneixement |
| 🥉 | **kimi-k2-instruct** | Groq | 3/3 | 3/5 | ✅ Noguera | 🐌 3795ms | **6/8** | Second opinion (inestable) |
| 4 | **llama-4-scout** | Groq | 2/3 | 3/5 | ❌ Segarra | 🚀🚀 301ms | **5/8** | Ultra ràpid |
| 4 | **llama-3.3-70b** | Groq | 2/3 | 3/5 | ⚠️ Noguera* | 🚀 462ms | **5/8** | General purpose |
| 6 | **gemini-3.1-flash-lite** | Google | 2/3 | 3/5 | ✅ Noguera | 🐌 1085ms | **5/8** | Backup (20 req/dia) |
| 7 | **qwen3-32b** | Groq | 2.5/3 | 2/5 | ⚠️ thinking | 🐌 921ms | **4.5/8** | Thinking trenca tools |
| 8 | **nemotron-120b** | OpenRouter | ?/3 | 3/5 | ⚠️ thinking | 🐌🐌 6676ms | **3/8** | Massa lent |
| 9 | **llama3.1-8b** | Cerebras | 1/3 | 3/5 | ❌ inventat | 🚀🚀 392ms | **4/8** | Ràpid però inventa |

> \* llama-3.3-70b encerta la comarca (Noguera) però diu que pertany a Térmens (fals — és municipi propi).
>
> 💡 **gpt-oss-120b** és el millor agent free tier: el més intel·ligent (3/3) + millor tool caller (4/5).
> **cerebras:qwen-235b** empata en tools i guanya en coneixement — ideal per workers.
> ⚠️ **kimi-k2** és intel·ligent però inestable (429 freqüents) i lent.
> ❌ **qwen3-32b** el thinking (`<think>`) li trenca els tool calls.
> ❌ **OpenRouter** és 10-20x més lent que Groq/Cerebras.

---

## 🔧 Detalls dels Tests de Tool Calling

5 tests simulant ús real de LAIA amb system prompt + 5 tools (read, bash, grep, write, brain_search):

| Test | Prompt | Tool esperat |
|------|--------|:------------:|
| **Read file** | "Show me the contents of package.json" | `read` |
| **Search text** | "Find all files that import detectProvider" | `grep` |
| **Run command** | "List all JavaScript files in src" | `bash` |
| **Multi-tool** | "Check if there's a test file for providers and show its content" | `grep` o `read` |
| **Brain search** | "Do we have any learnings about rate limits?" | `brain_search` |

### Resultats per model:

| Model | Read | Search | Command | Multi-tool | Brain | **Score** | Avg ms |
|-------|:----:|:------:|:-------:|:----------:|:-----:|:---------:|-------:|
| **gpt-oss-120b** | ✅ read | ✅ grep | ✅ bash | ✅ grep | ⚠️ grep | **4/5** | 339ms |
| **qwen-235b** (Cerebras) | ✅ read | ✅ grep | ✅ bash | ⚠️ bash | ✅ brain | **4/5** | 904ms |
| **kimi-k2** | ✅ read | ✅ grep | ❌ 429 | ✅ grep | ❌ 429 | **3/5** | 3795ms |
| **llama-4-scout** | ✅ read | ✅ grep | ❌ error | ⚠️ bash | ✅ brain | **3/5** | 301ms |
| **llama-3.3-70b** | ❌ error | ✅ grep | ⚠️ grep | ✅ grep | ✅ brain | **3/5** | 462ms |
| **gemini-3.1-flash-lite** | ⚠️ bash | ✅ grep | ✅ bash | ⚠️ bash | ✅ brain | **3/5** | 1085ms |
| **nemotron-120b** (OR) | ✅ read | ⚠️ bash | ✅ bash | ⚠️ bash | ✅ brain | **3/5** | 6676ms |
| **llama3.1-8b** (Cerebras) | ✅ read | ✅ grep | ⚠️ grep | ✅ grep | ⚠️ grep | **3/5** | 392ms |
| **qwen3-32b** | ✅ read | ❌ text | ❌ text | ❌ text | ✅ brain | **2/5** | 921ms |

> **Llegenda**: ✅ Tool correcte · ⚠️ Tool alternatiu vàlid · ❌ Error o no crida tool

### Observacions:

- **gpt-oss-120b** tria la tool exacta esperada en 4/5 casos — el millor tool selector
- **cerebras:qwen-235b** igual de bo (4/5) i sap usar `brain_search` correctament
- **kimi-k2** falla per rate limit (429), no per incapacitat — quan funciona, ho fa bé
- **qwen3-32b** el mode thinking fa que retorni text buit en lloc de cridar tools (2/5)
- **llama-4-scout** molt ràpid (301ms avg) però falla amb `bash` — millor per read/grep
- **nemotron-120b** funciona però és 20x més lent (~6.7s per call)

---

## 🧠 Ranking d'Intel·ligència — Free Tier

Test de raonament avançat amb 3 proves: lògica trampa (sheep=18), raonament inductiu (widgets=5min), i codi DP (palindrome).

| # | Model | Provider | Sheep (=18) | Widgets (=5min) | Codi DP | Velocitat | **Score** |
|---|-------|----------|:-----------:|:---------------:|:-------:|:---------:|:---------:|
| 🥇 | **openai/gpt-oss-120b** | Groq | ✅ 18 | ✅ 5min | ✅ | ~600ms | **3/3** |
| 🥇 | **moonshotai/kimi-k2-instruct** | Groq | ✅ 18 | ✅ 5min | ✅ | ~590ms | **3/3** |
| 🥉 | **qwen/qwen3-32b** | Groq | ✅ 18 | ✅ 5min | ⚠️ thinking leak | ~3300ms | **2.5/3** |
| 4 | **cerebras:qwen-3-235b** | Cerebras | ❌ 21 | ✅ 5min | ✅ | ~530ms | **2/3** |
| 4 | **meta-llama/llama-4-scout** | Groq | ❌ 21 | ✅ 5min | ✅ | ~660ms | **2/3** |
| 4 | **google:gemini-3.1-flash-lite** | Google | ❌ 17 | ✅ 5min | ✅ | ~1370ms | **2/3** |

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

---

## Matriu de Capacitats

| Model | IQ | Tools | Coneixement | Velocitat | Cost | Recomanació |
|-------|:--:|:-----:|:-----------:|:---------:|:----:|-------------|
| openai/gpt-oss-120b | 🏆 3/3 | 🏆 4/5 | ⚠️ | 🚀 339ms | Free | **🥇 Agent principal** |
| cerebras:qwen-3-235b | ⭐ 2/3 | 🏆 4/5 | 🏆 | 🚀 904ms | Free | **🥈 Workers + coneixement** |
| moonshotai/kimi-k2 | 🏆 3/3 | ⭐ 3/5 | ✅ | 🐌 3795ms | Free | Second opinion (inestable) |
| meta-llama/llama-4-scout | ⭐ 2/3 | ⭐ 3/5 | ❌ | 🚀🚀 301ms | Free | Ultra ràpid, read/grep |
| llama-3.3-70b | ⭐ 2/3 | ⭐ 3/5 | ⚠️ | 🚀 462ms | Free | General purpose |
| gemini-3.1-flash-lite | ⭐ 2/3 | ⭐ 3/5 | ✅ | 🐌 1085ms | Free | Backup Google (20 req/dia) |
| qwen3-32b | ⭐ 2.5/3 | ❌ 2/5 | ⚠️ | 🐌 921ms | Free | Thinking trenca tools |
| nvidia/nemotron-120b | ⭐ ?/3 | ⭐ 3/5 | ⚠️ | 🐌🐌 6676ms | Free | Massa lent per agent |
| llama3.1-8b | ⭐ 1/3 | ⭐ 3/5 | ❌ | 🚀🚀 392ms | Free | Ultra ràpid, baixa qualitat |
| gpt-5.3-codex | 🏆 | 🏆 | 🏆 | Variable | Copilot | **El millor per codi** |
| claude-opus-4.6 | 🏆 | 🏆 | 🏆 | Variable | Copilot | **El millor en raonament** |

**Llegenda**: 🏆 Excel·lent · ⭐ Bo · ✅ Correcte · ⚠️ Parcial · ❌ Falla · 🚀 Ràpid · 🐌 Lent

---

## Setup Recomanat per a Ús Diari

```
┌──────────────────────────────────────────────────────┐
│  gpt-oss-120b (Groq)     — 🥇 agent principal       │  🧠 IQ 3/3 + Tools 4/5
│  cerebras:qwen-3-235b    — 🥈 workers + coneixement  │  ⚡ Ràpid + 🌍 Factual
│  kimi-k2 (Groq)          — second opinion             │  🔍 IQ 3/3, inestable
│  gemini-3.1-flash-lite   — backup Google              │  💭 20 req/dia
│  nemotron-120b (OR)      — últim recurs free           │  🔄 Lent però funciona
│  gpt-5.3-codex (Copilot) — codi complex               │  💻 El millor coder
│  claude-opus-4.6 (Copilot)— raonament profund         │  🏆 La millor qualitat
└──────────────────────────────────────────────────────┘
```

---

## Recomanacions per Cas d'Ús

### 🤖 Agent LAIA (ús interactiu amb tools)
```
/model openai/gpt-oss-120b
```
El model gratis més intel·ligent (3/3 IQ) + millor tool caller (4/5). ~339ms. 6000 req/dia a Groq.

### 🌍 Coneixement general (preguntes factuals, investigació)
```
/model cerebras:qwen-3-235b-a22b-instruct-2507
```
🏆 El millor en coneixement factual + 4/5 tools. Ideal també per agent workers.

### 🧠 Raonament complex (arquitectura, plans, debug difícil)
```
/model moonshotai/kimi-k2-instruct
```
3/3 IQ, ideal per second opinion. Inestable (429 freqüents).
O bé `/model claude-opus-4.6` si tens Copilot.

### ⚡ Respostes ràpides i agent workers
```
/model cerebras:qwen-3-235b-a22b-instruct-2507
```
4/5 tools, ràpid (~904ms), bona qualitat. Perfecte per `agent()` workers.

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
