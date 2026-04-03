# Extended Brain Memory — Nextcloud Knowledge Store
**Date**: 2026-04-03
**Status**: Proposed
**Adapted from**: Claudia (Opus 4.6) + Yuri — original document
**Adapted for LAIA by**: LAIA (Sonnet 4) + Yuri
**Related**: [Agent Mailbox System](./2026-04-03-agent-mailbox-system.md) (companion document, pending adaptation)

---

## 1. Vision & Problem Statement

### The Problem
The Brain's knowledge is limited to **short Markdown text** (~2KB per learning). Real-world knowledge lives in rich files: PDFs, diagrams, spreadsheets, presentations, code. When an agent works with these files, the knowledge it extracts **dies with the session**.

### The Solution
Extend the Brain so learnings can **reference files stored in Nextcloud**. The agent already reads and understands the file during the session — we just need to **persist the file alongside the learning** so any agent can retrieve it later.

### Key Insight
In **90% of cases**, the agent already has full context of the file when creating the learning. It just read the PDF, analyzed the Excel, or generated the diagram. The summary is a natural byproduct of the agent's work — **not a separate extraction step**. We just need a way to say: "this learning has an associated file at this location."

### Multi-Device Synergy
LAIA runs on multiple devices (PC, Termux on mobile, etc.). Nextcloud is the **sync layer** that makes knowledge available everywhere:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  PC (LAIA)  │     │ Mòbil       │     │ Qualsevol   │
│  ~/laia/    │     │ Termux+LAIA │     │ dispositiu  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────┬───────┘───────────────────┘
                   ▼
          ┌────────────────┐
          │   Nextcloud    │
          │  (self-hosted) │
          │  /knowledge/   │
          └────────────────┘
```

The `laia-data` git repo works for learnings (lightweight text), but for PDFs, images, excels... git is not practical. Nextcloud fills that gap.

---

## 2. Architecture

### 2.1 How It Works

```
DURING A SESSION (the natural flow):

User: "Analitza aquest PDF de l'API de Phoenix"

Agent:
  1. Downloads/reads the PDF                        ← agent already does this
  2. Understands the content                        ← agent already does this
  3. Creates a brain learning with summary          ← agent already does this
  4. Uploads PDF to Nextcloud /knowledge/           ← NEW: persist the file
  5. Adds nc:// URI to the learning                 ← NEW: link them

LATER (any agent, any device):

User: "Quins endpoints té l'API de Phoenix?"

Agent:
  1. brain_search("Phoenix API endpoints")          ← finds the learning
  2. Reads summary → answers from summary           ← usually enough
  3. If needs more detail:
     → Downloads nc:///knowledge/docs/phoenix-api.pdf  ← retrieves full file
     → Reads specific section → precise answer
```

### 2.2 Two-Tier System

```
┌─────────────────────────────────────────────────┐
│                    BRAIN                         │
│                                                  │
│  learning: "Phoenix API Spec"                    │
│  description: "23 REST endpoints, OAuth2..."     │
│  tags: [phoenix, api, spec]                      │
│  attachments:                                    │
│    └── nc:///knowledge/docs/phoenix-api.pdf      │  ← reference only
│                                                  │
│  The agent ALREADY knew all this when it         │
│  created the learning. No extraction needed.     │
│                                                  │
└────────────────────┬────────────────────────────┘
                     │ on-demand download (when summary isn't enough)
                     ▼
┌─────────────────────────────────────────────────┐
│                 NEXTCLOUD                        │
│           /knowledge/docs/phoenix-api.pdf        │  ← full file
└─────────────────────────────────────────────────┘
```

---

## 3. Attachment Schema

### 3.1 Brain Learning with Attachments

```json
{
  "type": "learning",
  "title": "Phoenix API Specification v3",
  "description": "REST API amb 23 endpoints. Auth via OAuth2 amb JWT tokens. Rate limit 100 req/min. Webhooks per events. 4 dominis: Auth (3), Users (6), Orders (10), Webhooks (4).",
  "tags": ["phoenix", "api", "spec", "rest", "oauth2"],
  "attachments": [
    {
      "uri": "nc:///knowledge/docs/phoenix-api-spec-v3.pdf",
      "mime": "application/pdf",
      "label": "Phoenix API Spec v3 (complet)"
    },
    {
      "uri": "nc:///knowledge/diagrams/phoenix-architecture-v2.png",
      "mime": "image/png",
      "label": "Phoenix Architecture Diagram"
    }
  ]
}
```

### 3.2 Attachment Fields

| Field | Required | Description |
|-------|----------|-------------|
| `uri` | ✅ | Nextcloud path: `nc:///path/to/file` |
| `mime` | ✅ | MIME type (helps agent know how to handle it) |
| `label` | ✅ | Human-readable description |

That's it. Three fields. The agent already knows what the file contains — it just processed it. No need for `sha256`, `indexed_at`, `chunks`, `summary` in the attachment itself. The learning's `description` **is** the summary.

### 3.3 URI Protocol

```
nc:///knowledge/docs/phoenix-api.pdf
│     │
│     └── relative path within Nextcloud user files
│         resolves to: ${NC_URL}/remote.php/dav/files/${NC_USER}/knowledge/docs/phoenix-api.pdf
│
└── protocol identifier (Nextcloud reference)
```

---

## 4. Agent Workflow

### 4.1 Creating a Learning with Attachment (the main flow)

```
User: "Llegeix aquest PDF i guarda'l al brain"

Agent:
  1. Reads the PDF (via local file or download)
  2. Understands content, extracts key info
  3. Uploads to Nextcloud:
     /nextcloud upload ~/docs/phoenix-api.pdf knowledge/docs/phoenix-api-spec-v3.pdf
  4. Creates brain learning:
     brain_remember({
       title: "Phoenix API Specification v3",
       description: "23 REST endpoints across 4 domains...",
       tags: ["phoenix", "api", "spec"],
       attachments: [{
         uri: "nc:///knowledge/docs/phoenix-api-spec-v3.pdf",
         mime: "application/pdf",
         label: "Phoenix API Spec v3"
       }]
     })
```

### 4.2 Retrieving Knowledge (later, any agent, any device)

```
User: "Quin és el rate limit de l'API de Phoenix?"

Agent:
  1. brain_search("Phoenix API rate limit")
     → Found: "Phoenix API Specification v3"
     → Description says: "Rate limit 100 req/min"
     → ✅ Answer from summary alone — no download needed

User: "Mostra'm el format exacte del POST /orders"

Agent:
  1. brain_search("Phoenix API orders")
     → Found same learning, but description doesn't have the exact JSON schema
  2. Sees attachment: nc:///knowledge/docs/phoenix-api-spec-v3.pdf
  3. Downloads:
     /nextcloud download knowledge/docs/phoenix-api-spec-v3.pdf /tmp/
  4. Reads the PDF, finds the Orders section
  5. Responds with the exact schema
```

### 4.3 Types of Files Worth Persisting

| Type | Example | Why |
|------|---------|-----|
| **API specs** | PDF/DOCX with endpoint details | Too detailed for a summary |
| **Architecture diagrams** | PNG/SVG with system overview | Visual, can't be fully described in text |
| **Spreadsheets** | Excel with server inventory, configs | Structured data, many rows |
| **Presentations** | PPTX from a tech talk | Slides with context |
| **Generated reports** | PDF/MD reports the agent created | Preserve the full output |
| **Code files** | Scripts, configs the agent worked with | Reference implementation |
| **Screenshots** | UI captures, error screenshots | Visual evidence |
| **Meeting notes** | Detailed minutes in MD/DOCX | Full context beyond summary |

---

## 5. Nextcloud Directory Structure

```
/knowledge/                        ← dedicated knowledge store
├── docs/                          ← technical documents (PDF, DOCX, MD)
├── diagrams/                      ← architecture, flows, UML
├── spreadsheets/                  ← data, configs, inventories
├── presentations/                 ← slides, decks
├── screenshots/                   ← captures, UI references
├── meetings/                      ← meeting notes, transcriptions
└── code/                          ← code snippets, scripts
```

No `_index/` directory needed — the brain IS the index.

---

## 6. Brain Integration

### 6.1 Changes to Brain Tools

| Tool | Change |
|------|--------|
| `brain_remember` | Accept optional `attachments[]` field |
| `brain_search` | Return attachment URIs in results |

That's the only change needed. No new tools required.

### 6.2 Existing Infrastructure

LAIA already has:
- **`/nextcloud` skill** (`skills/nextcloud/SKILL.md`) — upload, download, mkdir, ls, search, share via WebDAV
- **Secrets store** (`~/.laia/secrets.sh`) — `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_PASSWORD`
- **Brain with embeddings** (`packages/brain/`) — SQLite FTS + sqlite-vec 384d embeddings
- **Knowledge files** (`laia-data/knowledge/`) — existing Markdown knowledge base

The `/nextcloud` skill handles all file operations. No new WebDAV code needed.

### 6.3 Search Behavior

When `brain_search` returns a result with attachments, the agent sees:

```
Result: "Phoenix API Specification v3"
  Description: "23 REST endpoints, OAuth2, rate limit 100 req/min..."
  Tags: [phoenix, api, spec]
  Attachments:
    📄 nc:///knowledge/docs/phoenix-api-spec-v3.pdf (application/pdf)
       "Phoenix API Spec v3 (complet)"
```

The agent decides whether to download based on whether the description answers the question.

---

## 7. Integration with Mailbox System

```
Nextcloud
├── /mailbox/          ← Agent communication (ephemeral messages)
├── /knowledge/        ← Brain knowledge store (persistent files)
└── /work/             ← User's regular files
```

Synergies:
- An agent can send a message referencing a knowledge file: *"See nc:///knowledge/docs/spec.pdf"*
- An agent can ask another to process a file: *"Read the PDF at nc:///knowledge/docs/spec.pdf and summarize section 3"*
- Reports generated by one agent are uploaded to `/knowledge/` and linked in a learning — other agents find them via brain_search

---

## 8. Implementation

### Phase 1: Attachments (~3h)
**Goal:** Brain learnings can reference Nextcloud files. Agents can upload and link.

| Task | Details | Time |
|------|---------|------|
| 1.1 Extend brain schema | Add optional `attachments[]` to learning type in `packages/brain/` | 1h |
| 1.2 Create `/knowledge/` structure | Directories on Nextcloud via `/nextcloud mkdir` | 15min |
| 1.3 `nc:///` URI resolution | Helper to resolve URIs to WebDAV URLs (or let `/nextcloud` skill handle it) | 30min |
| 1.4 Upload + link flow | Agent workflow: `/nextcloud upload` → `brain_remember` with attachment | 30min |
| 1.5 Search integration | `brain_search` returns attachment info | 45min |

**Deliverables:** Working attachment system. Agent can upload a file, create a learning, and another agent can find it and download it.

**Note:** Time reduced vs original estimate because LAIA already has the `/nextcloud` skill with full WebDAV support.

---

## 9. Future Enhancements

The following features are **not needed for v1** but are valuable future additions once the basic attachment system is working.

### 9.1 Auto-Indexation for Orphan Files (Future Phase)

**Problem:** Sometimes files are uploaded directly to `/knowledge/` via Nextcloud web UI or sync client — without an agent creating a learning. These "orphan files" exist but are invisible to brain_search.

**Solution:** A watcher that detects orphan files and auto-creates learnings:

```
1. Watcher detects new file in /knowledge/ (inotify on sync dir, or periodic PROPFIND)
2. Checks: does any brain learning reference this file? (search by URI)
3. If no → orphan file detected
4. Extract text from file:
   - PDF → pdftotext (poppler-utils)
   - DOCX → python-docx
   - XLSX → openpyxl (headers + sample rows)
   - PPTX → python-pptx (slide text + notes)
   - Images → tesseract OCR
   - Code/text → direct read
5. Send extracted text to LLM for summary + tag generation
6. Create brain learning with attachment reference
7. File is now discoverable via brain_search
```

**Throttling:** Max 2 concurrent jobs, 100K tokens/hour for LLM calls, skip files >50MB.

### 9.2 Chunking for Long Documents (Future Phase)

For documents over ~2000 words, a single learning summary may miss important details. Chunking splits the document into sections, each with its own brain entry:

- Chunk size: 500-1000 tokens, 15-20% overlap
- Each chunk stored as a sub-learning with `parent_id`
- Search finds the specific section, not just the document

### 9.3 Enhanced Vector Search (Future Phase)

LAIA already has sqlite-vec with 384d embeddings. Future enhancement:

- Embed all chunks from attached documents
- Hybrid search: FTS (brain) + vector (embeddings) + re-rank (already implemented in V5 Sprint 3)
- Addresses the limitation that text search can miss relevant content when phrased differently

### 9.4 Privacy Levels (Future Phase)

For handling sensitive files:

| Level | Behavior |
|-------|----------|
| `normal` | Standard processing |
| `sensitive` | Redact names/numbers before LLM summarization |
| `private` | No LLM — metadata only, manual summary |

With secret detection (API keys, passwords, PEM keys) before any LLM call.

---

## 10. Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Agent forgets to upload file | Medium | Low | System prompt reminds agent to persist important files |
| Broken link (file deleted from NC) | Low | Medium | Periodic check: do all attachment URIs resolve? |
| Large files slow to download | Low | Low | Description/summary answers 80%+ of queries without download |
| Nextcloud offline | Low | Medium | Summary in brain still works; full file unavailable temporarily |
| Nextcloud not configured on device | Medium | Low | Graceful degradation: attachments shown but marked as unavailable |

---

## 11. Success Criteria

| Criterion | Metric |
|-----------|--------|
| Attachment creation | Agent can upload + link in <30s |
| Cross-device retrieval | Any LAIA instance finds and downloads attached files |
| Summary sufficiency | 80%+ of queries answered from description alone |
| File types supported | PDF, images, DOCX, XLSX, PPTX, code, MD |

---

## Appendix: Example Interaction

```
User: "Llegeix aquest PDF d'arquitectura i guarda-ho al brain"

Agent:
  1. [reads /tmp/architecture-v2.pdf]
  2. "Arquitectura de 3 microserveis: auth-svc (Go), api-gateway (Node),
      order-worker (Python). PostgreSQL + Redis. Deploy a K8s."
  3. [uploads to Nextcloud]
     /nextcloud upload /tmp/architecture-v2.pdf knowledge/docs/architecture-v2.pdf
  4. [creates learning]
     brain_remember({
       title: "Arquitectura Phoenix v2",
       description: "3 microserveis: auth-svc (Go), api-gateway (Node.js),
                     order-worker (Python). BD: PostgreSQL 15 + Redis 7.
                     MQ: RabbitMQ. Deploy: K8s 1.28 on AWS EKS. ALB + WAF.",
       tags: ["phoenix", "architecture", "k8s", "microservices"],
       attachments: [{
         uri: "nc:///knowledge/docs/architecture-v2.pdf",
         mime: "application/pdf",
         label: "Diagrama arquitectura Phoenix v2"
       }]
     })

---

2 weeks later, from Termux on mobile:

User: "Quina BD fa servir el projecte Phoenix?"

Agent:
  1. brain_search("Phoenix base de dades")
  2. Found: "Arquitectura Phoenix v2"
     → Description: "PostgreSQL 15 + Redis 7"
  3. "Phoenix usa PostgreSQL 15 com a BD principal i Redis 7 per caching.
      Tinc el diagrama complet si vols més detalls: architecture-v2.pdf"
```
