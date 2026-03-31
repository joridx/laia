# Local ONNX Models Setup

## Problema

Zscaler (proxy corporatiu) bloqueja descàrregues de HuggingFace LFS:
- ✅ Fitxers petits (`config.json` <1KB) → OK
- ❌ `tokenizer.json` (16MB) → 403 Forbidden
- ❌ `model_quantized.onnx` (113MB) → 403 Forbidden

## Solució

Descarregar els models **des de casa** (sense Zscaler) i sincronitzar-los.

---

## Opció 1: Script automàtic (recomanat)

### Des de casa (xarxa personal):

```bash
cd mcp-server
node download-models.js
```

Això descarregarà automàticament el model a:
```
node_modules/@huggingface/transformers/.cache/Xenova/paraphrase-multilingual-MiniLM-L12-v2/
```

### Sincronitzar a PC d'oficina:

```bash
# 1. Comprimir el cache
cd node_modules/@huggingface/transformers/.cache
zip -r ~/embeddings-cache.zip Xenova/

# 2. Copiar embeddings-cache.zip a PC d'oficina (USB, OneDrive, email...)

# 3. Extreure al PC d'oficina
cd C:\claude\claude_local_brain\mcp-server\node_modules\@huggingface\transformers\.cache
unzip embeddings-cache.zip
```

---

## Opció 2: Descàrrega manual

### 1. Descarregar fitxers

Des de https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tree/main

Fitxers necessaris:
- `config.json` (~2KB)
- `tokenizer.json` (~16MB) ⚠️
- `tokenizer_config.json` (~1KB)
- `special_tokens_map.json` (~112B)
- `onnx/model_quantized.onnx` (~113MB) ⚠️

### 2. Col·locar al cache

Crear directori:
```bash
mkdir -p "node_modules/@huggingface/transformers/.cache/Xenova/paraphrase-multilingual-MiniLM-L12-v2/onnx"
```

Copiar fitxers:
```
.cache/Xenova/paraphrase-multilingual-MiniLM-L12-v2/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
├── special_tokens_map.json
└── onnx/
    └── model_quantized.onnx
```

---

## Verificar instal·lació

```bash
node -e "import('@huggingface/transformers').then(({pipeline}) => pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {dtype: 'q8'}).then(() => console.log('✓ Model OK')))"
```

Si funciona, veuràs: `✓ Model OK`

---

## Desactivar embeddings temporalment

Si no tens els models i vols que el servidor funcioni sense embeddings:

```bash
# Linux/Mac
export BRAIN_EMBEDDINGS_ENABLED=false

# Windows
set BRAIN_EMBEDDINGS_ENABLED=false
```

O afegir a `~/.claude/settings.json` dins `mcpServers.claude-brain.env`:
```json
{
  "claude-brain": {
    "env": {
      "BRAIN_EMBEDDINGS_ENABLED": "false"
    }
  }
}
```

El servidor funcionarà normalment amb cerca multi-senyal (7 senyals sense embeddings).
