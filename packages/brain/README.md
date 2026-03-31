# laia-brain

Brain engine de LAIA — MCP Server per a memòria persistent local.

## Descripció

Aquest paquet implementa el servidor MCP (Model Context Protocol) que proporciona a LAIA un sistema de memòria persistent. Permet emmagatzemar, cercar i recuperar coneixement de forma local mitjançant embeddings i base de dades SQLite.

## Funcionalitats

- **Memòria persistent**: Emmagatzema fets, decisions i context entre sessions
- **Cerca semàntica**: Utilitza embeddings (HuggingFace Transformers) per trobar informació rellevant
- **Base de dades local**: SQLite via `better-sqlite3` per a emmagatzematge lleuger
- **Protocol MCP**: Exposat com a servidor MCP estàndard

## Ús

```bash
# Iniciar el servidor
npm start

# Executar tests
npm test
```

## Dependències clau

- `@modelcontextprotocol/sdk` — SDK del protocol MCP
- `@huggingface/transformers` — Generació d'embeddings locals
- `better-sqlite3` — Base de dades SQLite (opcional)
- `@laia/providers` — Proveïdors de models (paquet local compartit)
