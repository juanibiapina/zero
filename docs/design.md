# Zero — Design Document

## Goal

Zero is a multi-user **agent orchestrator** that:
- Connects to GitHub via a GitHub App
- Manages interactive `pi` coding agent sessions in Cloudflare Containers
- Shows everything in a project-centric web UI
- Supports container sleep/wake with full session resume (R2 workspace snapshots + conversation history)

## Package Structure

```
zero/
├── apps/
│   ├── api/             (@zero/api)              — CF Worker: API, webhooks, orchestration
│   └── web/             (@zero/web)              — Vite + React + Tailwind frontend
├── packages/
│   ├── core/            (@zero/core)             — Shared types between api & web
│   ├── agent-server/    (@zero/agent-server)     — Node.js agent server (runs in CF Container)
│   ├── providers/       (@zero/providers)        — AI provider registry, model catalog, OAuth helpers
│   ├── drizzle-migrator/(@zero/drizzle-migrator) — Drizzle migration utility for DO SQLite
│   ├── eslint-config/                            — Shared ESLint config
│   └── typescript-config/                        — Shared TypeScript config
└── docs/                                         — Design docs
```

## Tech Stack

| Layer | Tech |
|---|---|
| Auth | Clerk (+ GitHub OAuth social connection) |
| Frontend | React 19, Tailwind v4, shadcn/ui, Zustand, react-router, lucide, @tanstack/react-hotkeys |
| API | Hono + OpenAPIHono + Zod on Cloudflare Workers |
| State | Durable Objects (SQLite + Drizzle ORM) |
| Agent compute | Cloudflare Containers with pi SDK |
| Real-time | WebSocket: browser↔SessionDO (Hibernation API), browser↔UserDO (Hibernation API, session status push), SessionDO↔Container (ephemeral event WS) |
| Workspace persistence | R2 (workspace snapshots across container sleep/wake) |
| Secrets | Doppler (projects: `zero-api`, `zero-web`) — see [`docs/secrets.md`](secrets.md) |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   Frontend (Vite + React)                        │
│  ┌───────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ Projects   │  │ Agent Sessions   │  │ Settings / Secrets   │ │
│  │ (repos)    │  │ (chat, status)   │  │ (providers, keys)    │ │
│  └───────────┘  └──────────────────┘  └──────────────────────┘ │
└─────────────────────────┬───────────────────────────────────────┘
                          │ REST + WebSocket
┌─────────────────────────▼───────────────────────────────────────┐
│            CF Worker (API + Orchestration)                       │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ GitHub App   │  │ UserDO       │  │ SessionDO          │    │
│  │ Webhooks +   │  │ (registry,   │  │ (per session,      │    │
│  │ Installation │  │  credentials,│  │  event log,        │    │
│  │ Tokens       │  │  sessions,   │  │  WS hub,           │    │
│  │              │  │  settings,   │  │  container mgmt)   │    │
│  │              │  │  WS push)    │  │                    │    │
│  └──────────────┘  └──────────────┘  └─────────┬──────────┘    │
│                                                  │               │
│  ┌──────────────────┐  ┌─────────────────────────┤              │
│  │ KV               │  │ R2 (SNAPSHOTS)          │              │
│  │ user:{clerkId}   │  │ workspace-snapshots/    │              │
│  │  → UserDO ID     │  │  {sessionId}/           │              │
│  └──────────────────┘  │  snapshot.tar.zst       │              │
│                         └─────────────────────────┘              │
└──────────────────────────────────────┬──────────────────────────┘
                                       │ HTTP + ephemeral WS
┌──────────────────────────────────────▼──────────────────────────┐
│          CF Container (AgentContainer)                           │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Node.js + git + gh CLI + pi SDK + zstd                    │ │
│  │  - Clones repo (with GitHub App token)                     │ │
│  │  - Runs pi agent via SDK (agentLoop)                       │ │
│  │  - Exposes HTTP API + WebSocket for events                 │ │
│  │  - Workspace snapshot/restore via tar+zstd                 │ │
│  │  - Auto-sleeps after idle timeout                          │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## DO ID Strategy

All DOs use `newUniqueId()` for placement near the user. Lookup goes through KV:

```
KV: user:{clerkUserId} → UserDO ID (one fast, globally-cached read per request)
```

UserDO stores references to all other entities for the user (projects, sessions, credentials, settings). No fan-out needed for listing — everything is a local SQLite query.

## Durable Objects

| DO | Purpose | Storage |
|---|---|---|
| **UserDO** | User registry: provider credentials, GitHub installation, projects, session index (with live status), secrets, settings, user-level WebSocket push (Hibernation API) | 7 SQLite tables |
| **SessionDO** | Per-session: metadata, append-only event log, WebSocket hub for browser (Hibernation API), HTTP commands + ephemeral event WS to container, container resume orchestration | 2 SQLite tables |
| **AgentContainer** | CF Container running the agent-server. Manages container lifecycle, workspace snapshots to R2 on sleep (`onActivityExpired`). One container per session. | Container class internal storage |

### UserDO Tables

| Table | Contents |
|---|---|
| `provider_credentials` | OAuth tokens + API keys per provider |
| `github_installations` | GitHub App installation (single per user) |
| `projects` | Project references (owner, repo, default model) |
| `sessions` | Session index with denormalized `currentStatus` — updated by SessionDO on every transition |
| `pkce_verifiers` | Temporary PKCE state for OAuth flows |
| `user_secrets` | Named secrets injected as env vars into agent sessions |
| `user_settings` | User preferences (hotkey prefix, keybindings) |

### SessionDO Tables

| Table | Contents |
|---|---|
| `session_meta` | Single row: status, owner, repo, provider, model, userDOId, createdAt |
| `session_events` | Append-only log: seq, containerSeq, source (user/agent), eventType, data JSON |

## SessionDO ↔ Container Communication

SessionDO uses a **decoupled architecture** separating commands from events:

```
Browser ←─ WS (Hibernation API) ─── SessionDO ── HTTP POST ──→ Container
                                          ←─ ephemeral WS (events) ──
```

- **Commands** (message, stop, steer): Browser sends over WS → SessionDO forwards as HTTP POST to container
- **Events**: SessionDO opens an ephemeral WS to the container's `/ws` endpoint, receives events, persists to SQLite, broadcasts to all browser WS clients
- **Hibernation**: SessionDO sleeps between browser messages. Wakes on incoming WS message or container event.
- **Resume**: When a container has slept and wakes, SessionDO detects this via `container.getState()`, rebuilds conversation history from stored `agent_end` events, resolves fresh credentials from UserDO, and POSTs `/resume` to the container.
- **R2 Snapshots**: `AgentContainer.onActivityExpired()` snapshots the workspace to R2 before sleeping. On resume, SessionDO restores the snapshot to the container, avoiding a fresh clone.

See [`docs/solutions/architecture/sessiondo-container-communication-patterns.md`](solutions/architecture/sessiondo-container-communication-patterns.md) for design rationale.

## Agent Session Lifecycle

```
SessionStatus (from @zero/core):
  connecting — Frontend-only: WebSocket connecting to SessionDO
  starting   — Container booting, cloning repo
  resuming   — Container waking from sleep, restoring state
  running    — Agent executing, user can send messages
  idle       — Agent finished task, container alive, waiting for input
  stopped    — Container gone (will need resume on next message)
  error      — Error during execution
```

**Session lifecycle:**
1. `POST /api/sessions` → SessionDO created (status=starting), container starts
2. Container boots → clones repo → status transitions: starting → idle
3. Browser opens WS → SessionDO replays stored events + `caught_up` marker
4. User sends message → SessionDO POSTs `/message` to container → status: running
5. Agent events stream via ephemeral WS → persisted + broadcast → status: idle
6. Container sleeps (`onActivityExpired` → R2 snapshot → stop) → status: stopped
7. User sends follow-up → resume: detect stopped → POST `/resume` with history + R2 restore → idle → send message

## Provider Credentials & Model Selection

Users authenticate with AI providers via OAuth or API keys. Currently **Anthropic** is the primary supported provider (OAuth subscription + API key). The `@zero/providers` package wraps `@mariozechner/pi-ai` to provide the provider registry, model catalog, and OAuth helpers.

**Storage:** `provider_credentials` table in UserDO (per-provider, supports both OAuth tokens and API keys).

**Model selection:** Projects have a default provider/model (`projects` table). Sessions inherit the project default or can override at creation time.

**Container credential flow:** SessionService resolves credentials from UserDO and passes them to the container at start/resume time. The container uses `setApiKey()` from `@mariozechner/pi-ai` — no file I/O, credentials live only in memory.

## Agent Server (`packages/agent-server/`)

Node.js HTTP server wrapping `agentLoop` from `@mariozechner/pi-ai` + `codingTools` from `@mariozechner/pi-coding-agent`. Runs inside a CF Container.

**HTTP API:**

```
POST /resume      { provider, model, apiKey, repoUrl, token, secrets?, messages, workspaceRestored? }
                  → Clone repo (or skip if workspace restored), configure model,
                    restore conversation history, transition to idle.
POST /message     { text }            → Send message (runs agentLoop)
POST /steer       { text }            → Interrupt current work (not yet implemented)
POST /stop                            → Abort current operation
GET  /ws                              → WebSocket for event streaming (?after=N for replay)
GET  /status                          → Session state JSON
GET  /workspace/snapshot              → Snapshot workspace as tar.zst (streamed response)
POST /workspace/restore               → Restore workspace from tar.zst (binary body)
POST /workspace/update-remote         → Update git remote URL with fresh token
```

**Container image:** `node:22-bookworm` + git + gh CLI + zstd. Dockerfile at `packages/agent-server/Dockerfile`.

## Routes

See [`docs/routes.md`](routes.md) for conventions and code patterns.

**API routes:**

```
# Auth
POST   /api/auth/github/callback       — GitHub App installation callback

# Projects
GET    /api/projects                    — List user's repos (cached, from GitHub API)
POST   /api/projects/refresh            — Force-refresh project list from GitHub
PUT    /api/projects/{owner}/{repo}/model — Set default model for a project

# Sessions
GET    /api/sessions                    — List sessions (optional ?owner=X&repo=Y filter)
POST   /api/sessions                    — Create + start session
DELETE /api/sessions/{id}               — Delete session (full cleanup: container, DO, R2)
GET    /api/sessions/:id/ws             — WebSocket upgrade → SessionDO

# Providers
GET    /api/providers                   — List available providers + connection status
POST   /api/providers/{id}/connect      — Start OAuth flow (returns auth URL)
POST   /api/providers/{id}/callback     — Complete OAuth flow (receives auth code)
POST   /api/providers/{id}/api-key      — Set API key
DELETE /api/providers/{id}              — Disconnect provider

# Secrets
GET    /api/secrets                     — List secret names (values omitted)
POST   /api/secrets                     — Create/update secret
DELETE /api/secrets/{name}              — Delete secret

# Settings
GET    /api/settings                    — Get user settings (merged with defaults)
PATCH  /api/settings                    — Update settings

# GitHub Webhooks (HMAC auth, not Clerk)
POST   /api/webhooks/github             — Receives GitHub App events

# WebSocket (user-level push)
GET    /api/ws                          — WebSocket upgrade → UserDO (session status events)
```

## Services

The backend follows a layered architecture: Entry Point → App → Routes → Services → DOs. See [`docs/framework.md`](framework.md) for code patterns.

| Service | Responsibility |
|---|---|
| **SessionService** | Create/manage sessions, orchestrate container lifecycle, resolve credentials |
| **UserService** | Project, provider, and GitHub installation operations via UserDO |
| **SecretsService** | User secret CRUD via UserDO |
| **SettingsService** | User settings CRUD via UserDO |
| **ContainerService** | Typed wrapper for container HTTP API (resume, message, stop, WS, snapshot) |
| **GitHubService** | GitHub App JWT, installation tokens, repo listing, webhook signature verification |

## WebSocket Protocols

### Session WebSocket (SessionDO ↔ Browser)

Client → Server:
```json
{ "type": "message", "text": "fix the tests" }
{ "type": "stop" }
{ "type": "steer", "text": "focus on auth" }
{ "type": "ping" }
```

Server → Client:
```json
{ "type": "event", "seq": 1, "source": "agent", "eventType": "message_update", "data": { ... } }
{ "type": "event", "seq": 15, "source": "user", "eventType": "message", "data": { ... } }
{ "type": "status", "status": "idle" }
{ "type": "caught_up", "lastSeq": 42 }
{ "type": "pong" }
{ "type": "error", "message": "Container unavailable" }
```

### User WebSocket (UserDO ↔ Browser)

Server → Client:
```json
{ "type": "session_status", "sessionId": "abc", "status": "running" }
{ "type": "session_created", "session": { "id": "abc", "owner": "...", ... } }
{ "type": "session_deleted", "sessionId": "abc" }
{ "type": "pong" }
```

Used by the frontend's zustand session store for live sidebar updates and status badges across all pages.

## Frontend

**Pages:**

| Route | Page | Description |
|---|---|---|
| `/` | DashboardPage | Recent sessions |
| `/projects` | ProjectsPage | All repos from GitHub (cached, filterable, hide archived toggle) |
| `/p/:owner/:repo` | ProjectDetailPage | Sessions for this repo, new session button |
| `/p/:owner/:repo/sessions/:id` | SessionPage | Chat interface with WebSocket |
| `/settings` | SettingsPage | Hotkey prefix and keybinding customization |
| `/settings/providers` | ProvidersPage | Connect/disconnect AI providers |
| `/secrets` | SecretsPage | Manage user-level secrets |
| `/github/setup` | GitHubSetupPage | GitHub App installation callback |

**Key components:**

| Component | Description |
|---|---|
| Layout | Sidebar + content area, mounts UserDO WebSocket and command palette |
| Sidebar | Navigation, session list with live status dots (via session store + UserDO WS) |
| CommandPaletteDialog | `Ctrl+Space, P` — fuzzy search across projects, sessions, actions |
| ProjectPickerDialog | `Ctrl+Space, N` — pick a project to create a new session |
| StatusBadge | Colored badge for any session status |
| TurnView | Renders assistant turns: thinking blocks, text, tool calls, tool results, errors |

**Hotkeys:** Configurable prefix key (default: `Ctrl+Space`) with rebindable action keys. Actions defined in `@zero/core` (`APP_ACTIONS`), bindings persisted via settings API.

## Dev Environment

See [`AGENTS.md`](../AGENTS.md) for dev server setup, CI, and deployment instructions.

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler)
- Dev server auto-started via `.config/gobfile.toml` running `pnpm turbo dev`

## Database Migrations

See [`docs/migrations.md`](migrations.md) for the full workflow.

Two databases: UserDO and SessionDO. Migrations bundled into the worker and applied automatically at runtime via `blockConcurrencyWhile()`.
