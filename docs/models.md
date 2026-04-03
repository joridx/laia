# LAIA — Models Disponibles

> Guia completa de tots els models LLM disponibles a LAIA, amb benchmarks i recomanacions.
>
> Última actualització: 2026-04-03 · Benchmarks executats des de Barcelona

---

## Resum Ràpid

| Ús | Model recomanat | Comanda |
|----|-----------------|---------|
| 🏆 **Agent principal** | `cerebras:qwen-3-235b-a22b-instruct-2507` | `/model cerebras:qwen-3-235b-a22b-instruct-2507` |
| ⚡ **Respostes ràpides** | `llama-3.1-8b-instant` (Groq) | `/model llama-3.1-8b-instant` |
| 🔧 **Tool calling** | `meta-llama/llama-4-scout-17b-16e-instruct` (Groq) | `/model meta-llama/llama-4-scout-17b-16e-instruct` |
| 🧠 **Raonament complex** | `gemini-2.5-flash` (Google) | `/model gemini-2.5-flash` |
| 💻 **Codi (amb tools)** | `gpt-5.3-codex` (Copilot) | `/model gpt-5.3-codex` |
| 🤖 **Agent workers** | `llama-3.3-70b-versatile` (Groq) | `/model llama-3.3-70b-versatile` |
| 📝 **Second opinion** | `openai/gpt-oss-120b` (Groq) | `/model openai/gpt-oss-120b` |

---

## Providers Configurats

| Provider | Endpoint | Free Tier | Variable d'entorn | Velocitat |
|----------|----------|-----------|-------------------|-----------|
| **Copilot** | `api.business.githubcopilot.com` | ✅ (subscripció GitHub) | apps.json (auto) | Variable |
| **Google** | `generativelanguage.googleapis.com` | ✅ 20 req/dia/model | `GOOGLE_API_KEY` | Mitjana |
| **Groq** | `api.groq.com` | ✅ 6000 req/dia, 6M tok/dia | `GROQ_API_KEY` | 🚀 Ràpid |
| **Cerebras** | `api.cerebras.ai` | ✅ 30 req/min, 1M tok/min | `CEREBRAS_API_KEY` | 🚀🚀 Ultràpid |
| **OpenAI** | `api.openai.com` | 💰 De pagament | `OPENAI_API_KEY` | Mitjana |
| **Anthropic** | `api.anthropic.com` | 💰 De pagament | `ANTHROPIC_API_KEY` | Mitjana |
| **Ollama** | `localhost:11434` | ✅ Local (sense límits) | — | Depèn del HW |

Les claus es configuren a `~/.laia/.env`:
```bash
GOOGLE_API_KEY=AIza...
GROQ_API_KEY=gsk_...
CEREBRAS_API_KEY=csk-...
```

---

## Benchmark Complet

### Metodologia

4 tests per model, executats seqüencialment amb `max_tokens=800`:

1. **Codi** — Generar una funció JS one-liner (top 3 únics d'un array)
2. **Raonament** — Problema lògic trampa ("totes menys 8 moren")
3. **Tool calling** — Cridar `read("package.json")` correctament
4. **Català** — Explicar Montserrat en 1 frase en català

### Resultats

#### 🏅 Cerebras (Wafer-Scale Engine — el hardware més ràpid)

| Model | Params | Codi | Raonament | Tool Call | Català | Mitjana |
|-------|--------|------|-----------|-----------|--------|---------|
| **qwen-3-235b-a22b-instruct-2507** | 235B (MoE 22B) | ✅ 530ms | ✅ 325ms | ✅ 752ms | ✅ 401ms | **502ms** |
| llama3.1-8b | 8B | ❌ 687ms | ❌ 3545ms | ✅ 14224ms | ✅ 905ms | 4840ms |

> 💡 **Qwen 235B a Cerebras** és el millor model gratis: ràpid, precís, amb tool calling. El llama 8B és massa petit per a ús agent.

#### 🏅 Groq (LPU Inference — velocitat consistent)

| Model | Params | Codi | Raonament | Tool Call | Català | Mitjana |
|-------|--------|------|-----------|-----------|--------|---------|
| **llama-3.1-8b-instant** | 8B | ✅ 128ms | ❌ 84ms | ✅ 212ms | ✅ 240ms | **166ms** |
| **llama-3.3-70b-versatile** | 70B | ✅ 249ms | ❌ 170ms | ✅ 281ms | ✅ 546ms | **312ms** |
| **moonshotai/kimi-k2-instruct** | 1T (MoE 32B) | ✅ 324ms | ❌ 288ms | ❌ 458ms | ✅ 343ms | **353ms** |
| **meta-llama/llama-4-scout-17b-16e-instruct** | 109B (MoE 17B) | ✅ 982ms | ✅ 137ms | ✅ 225ms | ✅ 267ms | **403ms** |
| **openai/gpt-oss-20b** | 20B | ✅ 336ms | ❌ 136ms | ✅ 164ms | ✅ 243ms | **220ms** |
| **openai/gpt-oss-120b** | 120B | ✅ 419ms | ❌ 183ms | ✅ 242ms | ✅ 364ms | **302ms** |
| **qwen/qwen3-32b** | 32B | ✅ 1604ms | ❌ 232ms | ✅ 359ms | ✅ 1021ms | **804ms** |

> 💡 **Llama 4 Scout** és el millor de Groq: l'únic que encerta el raonament + tool calling perfecte + molt ràpid.
> **gpt-oss-120b** és interessant com a second opinion (120B params, bona qualitat).
> **qwen3-32b** fa "thinking" intern que el fa lent però és precís en codi.

#### 🏅 Google (Gemini — thinking models)

| Model | Params | Codi | Raonament | Tool Call | Català | Mitjana |
|-------|--------|------|-----------|-----------|--------|---------|
| **gemini-3.1-flash-lite-preview** | ~MoE | ✅ 640ms | ✅ 1348ms | ✅ 586ms | ✅ 1268ms | **961ms** |
| **gemini-2.5-flash** | ~MoE | ✅ 3313ms | ✅ 1044ms | ✅ 1285ms | ✅ 4228ms | **2468ms** |
| **gemini-3-flash-preview** | ~MoE | ✅ 26288ms | ❌ 12491ms | ✅ 14846ms | ✅ 48212ms | 25459ms |
| gemini-2.5-flash-lite-preview | ~MoE | ❌ 91ms | ❌ 88ms | ❌ 90ms | ❌ 92ms | — |

> ⚠️ **Free tier: 20 requests/dia per model** (no 1500 com diu la doc antiga). Cada model té comptador independent,
> així que repartint entre 3 models (2.5-flash + 3-flash-preview + 3.1-flash-lite) tens ~60 req/dia.
>
> 💡 **gemini-2.5-flash** és el rei del raonament: el "thinking" intern fa que encert sempre, però triga.
> **gemini-3.1-flash-lite-preview** és sorprenentment bo i molt més ràpid.
> ⚠️ **gemini-3-flash-preview** funciona però és massa lent (12-48s). No recomanat.
> ⚠️ **gemini-2.5-flash-lite** no funciona (respostes buides).
> ❌ **Tots els models "Pro"** (2.5-pro, 3-pro, 3.1-pro) tenen quota 0 — requereixen pagament.
> ❌ **gemini-2.0-flash / 2.0-flash-lite** — eliminats del free tier (quota 0).

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

| Model | Codi | Raonament | Tool Call | Català | Velocitat | Cost |
|-------|:----:|:---------:|:---------:|:------:|:---------:|:----:|
| cerebras:qwen-3-235b | ✅ | ✅ | ✅ | ✅ | 🚀🚀 502ms | Free |
| gemini-2.5-flash | ✅ | ✅ | ✅ | ✅ | 🐌 2468ms | Free |
| gemini-3.1-flash-lite-preview | ✅ | ✅ | ✅ | ✅ | 🚀 961ms | Free |
| meta-llama/llama-4-scout | ✅ | ✅ | ✅ | ✅ | 🚀🚀 403ms | Free |
| llama-3.3-70b-versatile | ✅ | ❌ | ✅ | ✅ | 🚀🚀 312ms | Free |
| openai/gpt-oss-120b | ✅ | ❌ | ✅ | ✅ | 🚀🚀 302ms | Free |
| openai/gpt-oss-20b | ✅ | ❌ | ✅ | ✅ | 🚀🚀🚀 220ms | Free |
| moonshotai/kimi-k2-instruct | ✅ | ❌ | ❌ | ✅ | 🚀🚀 353ms | Free |
| llama-3.1-8b-instant | ✅ | ❌ | ✅ | ✅ | 🚀🚀🚀 166ms | Free |
| qwen/qwen3-32b | ✅ | ❌ | ✅ | ✅ | 🐌 804ms | Free |
| gpt-5.3-codex | 🏆 | ✅ | ✅ | ✅ | Variable | Copilot |
| claude-opus-4.6 | 🏆 | 🏆 | ✅ | ✅ | Variable | Copilot |

**Llegenda**: ✅ Correcte · ❌ Incorrecte · 🏆 Excel·lent · 🚀 Ràpid · 🐌 Lent

---

## Recomanacions per Cas d'Ús

### 🤖 Agent LAIA (ús interactiu amb tools)
```
/model cerebras:qwen-3-235b-a22b-instruct-2507
```
El millor equilibri velocitat/qualitat/tool-calling en free tier. 235B params amb 500ms de mitjana.

### 💻 Coding intens (refactors, nous fitxers)
```
/model gpt-5.3-codex
```
El codex de GitHub Copilot és imbatible per codi: 400K context, /responses endpoint natiu.

### 🧠 Raonament complex (arquitectura, plans, debug difícil)
```
/model claude-opus-4.6
```
O bé `gemini-2.5-flash` si prefereixes free tier. Ambdós fan "thinking" profund.

### ⚡ Respostes ràpides (preguntes simples, one-shots)
```
/model llama-3.1-8b-instant
```
166ms de mitjana. Perfecte per a `agent()` workers en paral·lel.

### 🔍 Second opinion / Validació
```
/model openai/gpt-oss-120b
```
Model gran (120B) amb perspectiva diferent. Ideal per revisar codi o plans.

### 🌐 Multi-model review
```bash
# Des del terminal
laia --model cerebras:qwen-3-235b-a22b-instruct-2507 -p "Revisa aquest codi: ..."
laia --model gemini-2.5-flash -p "Revisa aquest codi: ..."
laia --model openai/gpt-oss-120b -p "Revisa aquest codi: ..."
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
| **OpenRouter** | 28 models gratis | ✅ Rate limited | `openrouter.ai/api/v1` — aggregator |
| **DeepSeek** | V3, R1 (reasoning) | ~10M tok gratis | `api.deepseek.com/v1` |

---

## Rate Limits (Free Tier)

| Provider | RPM | RPD | Tokens/dia | Notes |
|----------|-----|-----|-----------|-------|
| **Cerebras** | 30 | ~43K | 1M/min | Molt generós |
| **Groq** | 30 | 6000 | 6M | El més generós |
| **Google** | 10 | **20 per model** | 250K input | Cada model té comptador independent. Repartir entre 3 models = ~60 req/dia |
| **Copilot** | — | — | — | Flat rate (subscripció) |

---

*Generat automàticament per LAIA · [github.com/joridx/laia](https://github.com/joridx/laia)*
