# LAIA Web — Project Document

> PWA / Web interface for LAIA — a conversational mobile chatbot with Android hardware access.

**Status:** Planning  
**Author:** Jordi Tribó  
**Last updated:** 2025-07-17

---

## Table of Contents

1. [Vision & Goals](#1-vision--goals)
2. [Architecture](#2-architecture)
3. [API Protocol](#3-api-protocol)
4. [UI Components](#4-ui-components)
5. [PWA Configuration](#5-pwa-configuration)
6. [Mobile Features](#6-mobile-features)
7. [Sprint Plan](#7-sprint-plan)
8. [Dependencies](#8-dependencies)
9. [Risks & Mitigations](#9-risks--mitigations)
10. [Commands & Deployment](#10-commands--deployment)

---

## 1. Vision & Goals

### What LAIA Web IS

- A **conversational mobile chatbot** optimized for phones/tablets
- A **PWA** installable from Chrome ("Add to Home Screen") — no app store needed
- A chat interface with access to **Android hardware**: camera, GPS, TTS, STT, notifications
- A lightweight **companion app** to LAIA CLI, sharing brain and providers
- Usable by **anyone**, not just developers

### What LAIA Web is NOT

- ❌ An IDE or code editor in the browser
- ❌ A tool for cloning repos, editing files, or running bash commands
- ❌ A replacement for LAIA CLI — it complements it
- ❌ A cloud-hosted SaaS — it runs locally on the device

### CLI vs Web comparison

| Aspect | LAIA CLI | LAIA Web |
|--------|----------|----------|
| **Purpose** | Code, edit, manage repos, DevOps | Chat, ask questions, voice, photos |
| **Tools** | read, write, edit, bash, grep, glob, git | Camera, GPS, SMS, TTS, STT |
| **Interface** | Terminal (readline + ANSI) | Browser PWA (HTML/CSS/JS) |
| **Target user** | Developers | Anyone with a phone |
| **Input** | Keyboard | Keyboard + voice + camera |
| **Output** | Text + ANSI codes | Markdown + images + audio |
| **Platform** | Linux, Windows, macOS, Termux | Any device with a browser |
| **Context size** | Large (full repos) | Small (conversations) |

---

## 2. Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────┐
│                   BROWSER (PWA)                  │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Chat UI  │ │ Composer │ │ Mobile APIs      │ │
│  │ (React)  │ │          │ │ Camera/GPS/TTS   │ │
│  └────┬─────┘ └────┬─────┘ └───────┬──────────┘ │
│       │             │               │            │
│       └─────────────┼───────────────┘            │
│                     │ fetch + SSE                │
└─────────────────────┼────────────────────────────┘
                      │
              ┌───────▼───────┐
              │  Fastify BFF  │  (packages/webui/server/)
              │  :3120        │
              ├───────────────┤
              │ POST /messages│──→ Provider API (Anthropic/OpenAI/Copilot)
              │ GET  /stream  │──→ SSE token streaming
              │ GET  /sessions│──→ Brain (conversation history)
              └───┬───────┬───┘
                  │       │
          ┌───────▼─┐ ┌───▼──────────┐
          │ @laia/  │ │ @laia/       │
          │ providers│ │ brain        │
          └─────────┘ └──────────────┘
```

### Folder Structure

```
packages/webui/
├── package.json
├── vite.config.js
├── server/
│   ├── index.js              # Fastify entry point
│   ├── routes/
│   │   ├── sessions.js       # CRUD sessions
│   │   ├── messages.js       # POST prompt, GET stream (SSE)
│   │   └── health.js         # Health check
│   ├── services/
│   │   ├── chat.js           # Conversation orchestration
│   │   └── mobile-tools.js   # Camera/GPS result processing
│   └── auth.js               # JWT session tokens
├── client/
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx          # React entry
│   │   ├── App.jsx           # Router + layout
│   │   ├── components/
│   │   │   ├── ChatLayout.jsx
│   │   │   ├── MessageBubble.jsx
│   │   │   ├── ToolCallViewer.jsx
│   │   │   ├── CodeBlock.jsx
│   │   │   ├── Composer.jsx
│   │   │   ├── SessionSidebar.jsx
│   │   │   └── Settings.jsx
│   │   ├── hooks/
│   │   │   ├── useSSE.js     # SSE connection hook
│   │   │   ├── useChat.js    # Chat state management
│   │   │   └── useMobile.js  # Camera, GPS, TTS, STT
│   │   ├── lib/
│   │   │   ├── api.js        # HTTP client
│   │   │   └── sse.js        # SSE parser
│   │   └── styles/
│   │       ├── global.css
│   │       └── chat.css
│   └── public/
│       ├── manifest.webmanifest
│       ├── sw.js
│       ├── icon-192.png
│       └── icon-512.png
└── tests/
    ├── server/
    └── client/
```

### Boundary Rules

1. `packages/webui/` **can import**: `@laia/brain`, `@laia/providers`
2. `packages/webui/` **cannot import**: anything from `src/` (CLI core)
3. `src/` (CLI core) **never imports**: anything from `packages/webui/`
4. The CLI doesn't know webui exists — zero coupling
5. Shared types (if needed) go in a `packages/contracts/` package

### Start modes

```bash
# Development (hot reload)
npm run dev -w packages/webui

# Production
npm run build -w packages/webui
npm start -w packages/webui

# From LAIA CLI (convenience alias)
laia --web                    # starts webui server on :3120
laia --web --port 8080        # custom port
```

---

## 3. API Protocol

### Authentication

Local-only mode (default): no auth required — server binds to `127.0.0.1`.

For remote access (optional):

```
POST /api/auth/token
Body: { "secret": "<configured secret>" }
Response: { "token": "eyJhbG..." }

All subsequent requests:
Authorization: Bearer <token>
```

### Endpoints

#### Create Session

```http
POST /api/sessions
Content-Type: application/json

{
  "model": "claude-opus-4-20250514",         # optional, uses default
  "systemPrompt": "You are a helpful assistant"  # optional
}

→ 201 Created
{
  "id": "ses_abc123",
  "model": "claude-opus-4-20250514",
  "createdAt": "2025-07-17T10:00:00Z",
  "messages": []
}
```

#### List Sessions

```http
GET /api/sessions?limit=20&offset=0

→ 200 OK
{
  "sessions": [
    { "id": "ses_abc123", "model": "...", "createdAt": "...", "messageCount": 5, "title": "..." }
  ],
  "total": 42
}
```

#### Get Session

```http
GET /api/sessions/ses_abc123

→ 200 OK
{
  "id": "ses_abc123",
  "model": "...",
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi! How can I help?" }
  ]
}
```

#### Delete Session

```http
DELETE /api/sessions/ses_abc123
→ 204 No Content
```

#### Send Message

```http
POST /api/sessions/ses_abc123/messages
Content-Type: application/json

{
  "content": "What's the weather like?",
  "attachments": [                           # optional
    { "type": "image", "data": "base64..." },
    { "type": "location", "lat": 41.38, "lon": 2.17 }
  ]
}

→ 202 Accepted
{ "messageId": "msg_xyz789" }
```

The response streams via SSE (see below).

#### Stream (SSE)

```http
GET /api/sessions/ses_abc123/stream
Accept: text/event-stream

→ 200 OK
Content-Type: text/event-stream

event: message_start
data: {"id":"msg_xyz789","role":"assistant","model":"claude-opus-4-20250514"}

event: token
data: {"id":"msg_xyz789","text":"The"}

event: token
data: {"id":"msg_xyz789","text":" weather"}

event: token
data: {"id":"msg_xyz789","text":" in Barcelona"}

event: tool_use
data: {"id":"tool_1","name":"get_location","input":{}}

event: tool_result
data: {"id":"tool_1","output":{"lat":41.38,"lon":2.17,"city":"Barcelona"}}

event: token
data: {"id":"msg_xyz789","text":" is sunny, 28°C."}

event: message_end
data: {"id":"msg_xyz789","usage":{"input_tokens":150,"output_tokens":42},"stopReason":"end_turn"}
```

#### Control (interrupt/approve)

```http
POST /api/sessions/ses_abc123/control
Content-Type: application/json

{ "action": "interrupt" }     # stop current generation
{ "action": "approve", "toolId": "tool_1" }  # approve tool use

→ 200 OK
{ "status": "ok" }
```

---

## 4. UI Components

### ChatLayout

Main container — full-height flex layout:

```
┌──────────────────────────────┐
│ ≡  LAIA Web    ⚙️  Model ▼  │  ← Header (48px)
├──────────────────────────────┤
│                              │
│  ┌────────────────────────┐  │
│  │ 🧑 What's the weather? │  │  ← User bubble
│  └────────────────────────┘  │
│                              │
│  ┌────────────────────────┐  │
│  │ 🤖 Checking location...│  │  ← Assistant bubble
│  │ ┌──────────────────┐   │  │
│  │ │ 📍 get_location  │   │  │  ← ToolCallViewer (collapsible)
│  │ │   lat: 41.38     │   │  │
│  │ │   status: ✅     │   │  │
│  │ └──────────────────┘   │  │
│  │ It's sunny, 28°C in    │  │
│  │ Barcelona!              │  │
│  └────────────────────────┘  │
│                              │
├──────────────────────────────┤
│ [📷] [🎤] Type a message... │  ← Composer (56px)
│                        [➤]  │
└──────────────────────────────┘
```

### MessageBubble

- **User**: right-aligned, colored background, supports image attachments
- **Assistant**: left-aligned, white/dark background, renders Markdown
- **Streaming**: tokens append in real-time, cursor blinks at end
- **Tool calls**: inline collapsible `<ToolCallViewer>`

### ToolCallViewer

Collapsible card showing:
- Tool name + icon
- Input (JSON, collapsed by default)
- Output (JSON or formatted)
- Status: ⏳ running / ✅ done / ❌ error
- Duration

### CodeBlock

- Syntax highlighting (highlight.js or Prism)
- Copy button
- Language label
- Line numbers for blocks > 5 lines

### Composer

- Text input (auto-grow textarea)
- 📷 Camera button → `getUserMedia` → capture → attach as base64
- 🎤 Voice button → `SpeechRecognition` → transcribe → fill input
- ➤ Send button (also Enter key)
- Disabled state while assistant is responding (shows "Stop ■" button instead)

### SessionSidebar

- Slide-in from left (hamburger menu)
- List of sessions with title + date
- "New chat" button
- Delete session (swipe or long-press)
- Settings link

### Settings

- Model selector (dropdown)
- Brain toggle (on/off)
- Theme (light/dark/auto)
- TTS voice selector
- Clear all data

---

## 5. PWA Configuration

### manifest.webmanifest

```json
{
  "name": "LAIA Web",
  "short_name": "LAIA",
  "description": "AI Assistant — Chat, Voice, Camera",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#3b82f6",
  "orientation": "portrait-primary",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "categories": ["productivity", "utilities"]
}
```

### Service Worker Strategy

```javascript
// sw.js — Workbox-based
// Strategy:
// - App shell (HTML/CSS/JS): Cache-first, update in background
// - API calls: Network-first, fallback to cache for GET /sessions
// - Images: Cache-first with expiration (7 days)

// Offline mode:
// - Show cached conversations
// - Queue new messages for sync when online (Background Sync API)
// - Show "offline" badge in header
```

### Installation on Android

1. User visits `http://localhost:3120` in Chrome
2. Chrome shows "Add to Home Screen" banner (after 2+ visits)
3. Or: Chrome menu → "Install app" / "Add to Home Screen"
4. App launches in standalone mode (no browser chrome)
5. Status bar matches `theme_color`

---

## 6. Mobile Features

### Camera

```javascript
// useMobile.js → useCamera()
async function capturePhoto() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' }   // back camera
  });
  // Render to canvas, capture frame, convert to base64
  // Attach to message as image
  // Send to provider with vision capability
}
```

**Use case:** "What's this?" → takes photo → sends to Claude Vision → describes object

### GPS / Geolocation

```javascript
// useMobile.js → useLocation()
async function getLocation() {
  const pos = await new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000
    })
  );
  return { lat: pos.coords.latitude, lon: pos.coords.longitude };
}
```

**Use case:** "Where am I?" → gets GPS → reverse geocode → "You're in Barcelona, Eixample"

### Text-to-Speech (TTS)

```javascript
// useMobile.js → useTTS()
function speak(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ca-ES';  // Catalan preferred
  utterance.rate = 1.0;
  speechSynthesis.speak(utterance);
}
```

**Use case:** Assistant reads responses aloud — toggle with 🔊 button on each message

### Speech-to-Text (STT)

```javascript
// useMobile.js → useSTT()
function startListening(onResult) {
  const recognition = new webkitSpeechRecognition();
  recognition.lang = 'ca-ES';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    onResult(transcript, e.results[0].isFinal);
  };
  recognition.start();
}
```

**Use case:** Press 🎤 → speak → transcribed text appears in composer → send

### Notifications

```javascript
// For long-running queries or background processing
async function notify(title, body) {
  if (Notification.permission !== 'granted') {
    await Notification.requestPermission();
  }
  new Notification(title, { body, icon: '/icon-192.png' });
}
```

### Integration with Chat

Mobile features are exposed as **tools** the model can request:

```json
{
  "tools": [
    {
      "name": "take_photo",
      "description": "Take a photo with the device camera",
      "input_schema": { "type": "object", "properties": { "facing": { "enum": ["front", "back"] } } }
    },
    {
      "name": "get_location",
      "description": "Get current GPS coordinates",
      "input_schema": { "type": "object", "properties": {} }
    },
    {
      "name": "speak",
      "description": "Read text aloud using TTS",
      "input_schema": { "type": "object", "properties": { "text": { "type": "string" } } }
    }
  ]
}
```

When the model calls `take_photo`, the frontend captures and sends back as tool_result. The model never accesses the camera directly — the **browser mediates** all hardware access with user permission.

---

## 7. Sprint Plan

### Sprint 0 — Foundation (Week 1)

**Goal:** Minimal working chat — send a message, get a streamed response.

| Task | LOC | Details |
|------|-----|---------|
| `packages/webui/package.json` + Vite config | 50 | Dependencies, build scripts |
| Fastify server with static file serving | 100 | `server/index.js` |
| POST `/api/sessions/:id/messages` route | 80 | Calls provider, returns 202 |
| GET `/api/sessions/:id/stream` SSE route | 120 | Streams tokens from provider |
| Session store (in-memory + JSON file) | 80 | CRUD sessions |
| React app shell + ChatLayout | 100 | Basic layout, message list |
| MessageBubble (text only) | 40 | User + assistant bubbles |
| Composer (text input + send) | 60 | Input, Enter to send |
| useSSE hook | 80 | Connect, parse events, reconnect |
| useChat hook | 60 | State management for messages |
| **Total Sprint 0** | **~770** | |

**Exit criteria:**
- [ ] `npm run dev -w packages/webui` starts server on :3120
- [ ] Open browser → type message → get streamed response
- [ ] Messages persist across page reload (JSON file)

### Sprint 1 — Polish & PWA (Week 2)

**Goal:** Markdown rendering, session management, installable PWA.

| Task | LOC | Details |
|------|-----|---------|
| Markdown rendering (react-markdown) | 60 | In MessageBubble |
| CodeBlock with syntax highlight | 50 | highlight.js |
| ToolCallViewer component | 80 | Collapsible, status indicator |
| SessionSidebar | 80 | List, create, delete sessions |
| Settings page | 60 | Model selector, theme |
| PWA manifest + icons | 30 | manifest.webmanifest |
| Service worker (Workbox) | 80 | Cache strategy |
| Dark/light theme | 50 | CSS variables + prefers-color-scheme |
| Responsive CSS | 60 | Mobile-first |
| Brain integration (history) | 80 | Save/load from @laia/brain |
| **Total Sprint 1** | **~630** | |

**Exit criteria:**
- [ ] Markdown + code blocks render properly
- [ ] Tool calls show as collapsible cards
- [ ] Can install as PWA on Android Chrome
- [ ] Works offline (shows cached conversations)
- [ ] Dark mode

### Sprint 2 — Mobile & Voice (Week 3)

**Goal:** Camera, GPS, TTS, STT — full mobile experience.

| Task | LOC | Details |
|------|-----|---------|
| useCamera hook | 80 | getUserMedia, capture, base64 |
| Camera UI (preview, capture button) | 60 | Modal overlay |
| useLocation hook | 40 | Geolocation API |
| useTTS hook | 40 | SpeechSynthesis |
| useSTT hook | 60 | SpeechRecognition + interim results |
| Voice button in Composer | 30 | Toggle recording |
| TTS button on messages | 20 | 🔊 per message |
| Mobile tool definitions | 40 | take_photo, get_location, speak |
| Tool result handling (client→server→model) | 80 | Round-trip for tool calls |
| Notifications | 30 | Long-running query alerts |
| Auth (optional remote access) | 80 | JWT + secret config |
| Error handling + loading states | 60 | Skeleton, retry, offline badge |
| **Total Sprint 2** | **~620** | |

**Exit criteria:**
- [ ] "Take a photo" → camera opens → photo sent to model → described
- [ ] "Where am I?" → GPS → location described
- [ ] Voice input works (press 🎤, speak, text appears)
- [ ] TTS reads responses aloud
- [ ] Push notification when response ready (if app backgrounded)

### Sprint 3 — Hardening (Week 4, optional)

| Task | LOC | Details |
|------|-----|---------|
| E2E tests (Playwright) | 200 | Core flows |
| Unit tests (Vitest) | 150 | Hooks, services |
| Performance optimization | 50 | Lazy loading, virtual scroll for long chats |
| Accessibility (a11y) | 50 | ARIA, keyboard nav, screen reader |
| Documentation | - | README, screenshots |
| **Total Sprint 3** | **~450** | |

### Total Estimates

| Sprint | LOC | Time | Cumulative |
|--------|-----|------|------------|
| Sprint 0 | ~770 | 1 week | 770 |
| Sprint 1 | ~630 | 1 week | 1,400 |
| Sprint 2 | ~620 | 1 week | 2,020 |
| Sprint 3 | ~450 | 1 week | 2,470 |
| **Total** | **~2,470** | **3-4 weeks** | |

---

## 8. Dependencies

### Server

| Package | Version | Purpose |
|---------|---------|---------|
| `fastify` | ^5.0 | HTTP server |
| `@fastify/static` | ^8.0 | Serve built frontend |
| `@fastify/cors` | ^10.0 | CORS for dev mode |
| `@fastify/websocket` | ^11.0 | Optional WS support (Sprint 3+) |
| `jsonwebtoken` | ^9.0 | JWT auth (optional) |
| `@laia/brain` | workspace:* | Brain integration |
| `@laia/providers` | workspace:* | AI providers |

### Client

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^19.0 | UI framework |
| `react-dom` | ^19.0 | DOM rendering |
| `react-markdown` | ^10.0 | Markdown in messages |
| `remark-gfm` | ^4.0 | GitHub-flavored markdown |
| `rehype-highlight` | ^7.0 | Code syntax highlight |
| `highlight.js` | ^11.0 | Syntax highlight engine |

### Build

| Package | Version | Purpose |
|---------|---------|---------|
| `vite` | ^6.0 | Bundler + dev server |
| `@vitejs/plugin-react` | ^4.0 | React JSX transform |
| `vite-plugin-pwa` | ^0.21 | PWA manifest + SW generation |
| `workbox-precaching` | ^7.0 | Service worker caching |

### Dev

| Package | Version | Purpose |
|---------|---------|---------|
| `vitest` | ^3.0 | Unit tests |
| `@playwright/test` | ^1.50 | E2E tests (Sprint 3) |

**Total new dependencies:** ~15 packages  
**No native/compiled deps** — everything is pure JS, works on any platform including Android/Termux.

---

## 9. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Copilot token exchange from mobile** | Auth fails | Medium | Already tested & working on Termux |
| **SpeechRecognition not available** | No voice input | Low | Feature detection + fallback to keyboard |
| **Camera permission denied** | No photo feature | Low | Graceful degradation + instruction |
| **Large responses block UI** | Frozen interface | Medium | Virtual scroll + streaming already chunked |
| **Offline mode complexity** | Background sync failures | Medium | Sprint 3, keep MVP simple (online-only) |
| **HTTPS required for PWA** | Can't install on remote | Low | localhost exempt; mkcert for LAN access |
| **webui inflates CLI install** | Slower npm install | Low | webui is optional workspace; `npm install --ignore-workspace=webui` |
| **Provider API changes** | Breaking calls | Low | @laia/providers abstracts this |

---

## 10. Commands & Deployment

### Development

```bash
# From monorepo root
npm run dev -w packages/webui

# Opens:
# - Vite dev server (frontend): http://localhost:5173 (proxied to API)
# - Fastify server (API): http://localhost:3120
```

### Production Build

```bash
npm run build -w packages/webui
# Outputs: packages/webui/dist/
#   client/  → static files (HTML/CSS/JS)
#   server/  → Node.js server

npm start -w packages/webui
# Starts Fastify serving built frontend + API on :3120
```

### From LAIA CLI

```bash
laia --web                    # Start web UI on default port
laia --web --port 8080        # Custom port
laia --web --host 0.0.0.0    # Accessible from LAN (needs --secret)
laia --web --secret mysecret  # Enable JWT auth
```

### On Android (Termux)

```bash
# After LAIA is installed via install-termux.sh
laia --web

# Open Chrome: http://localhost:3120
# Chrome menu → "Add to Home Screen"
# App appears on home screen as "LAIA"
```

### On Desktop (Linux/Windows)

```bash
laia --web
# Open browser: http://localhost:3120
# Optional: Chrome → "Install LAIA Web" (PWA install prompt)
```

### Docker (future)

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY packages/webui/dist/ ./
EXPOSE 3120
CMD ["node", "server/index.js"]
```

---

## Appendix: Design Decisions Log

| Decision | Choice | Alternatives Considered | Reason |
|----------|--------|------------------------|--------|
| Framework | Fastify | Express, Hono | Best performance + ESM + plugin ecosystem |
| Frontend | React + Vite | Svelte, Vanilla, Vue | React already in project; Vite DX excellent |
| Streaming | SSE | WebSocket, long-poll | SSE simpler, auto-reconnect, sufficient for streaming |
| PWA | vite-plugin-pwa | Manual SW | Handles manifest + Workbox generation |
| Separate package | Yes (packages/webui/) | Same src/, separate repo | Zero coupling to CLI; shared brain/providers |
| No Electron/Tauri | Correct for now | Electron, Tauri | PWA sufficient; native wrappers add complexity |
| Auth | Optional JWT | OAuth, basic auth | Local-only default; JWT only for remote access |
