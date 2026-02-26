# Zero — Agent Orchestrator Design Document

## Goal

Rewrite the `zero/` app as **Zero**, a multi-user **agent orchestrator** that:
- Connects to GitHub via a GitHub App (extensible to other providers later)
- Receives and displays notifications from GitHub, emails, messages, etc. in a unified inbox
- Enriches notifications with LLM-suggested actions (async, non-blocking)
- Manages interactive `pi` coding agent sessions in Cloudflare Containers
- Shows everything in a project-centric web UI

## Package Structure

Monorepo with `apps/` for deployable applications and `packages/` for shared code:

```
zero/
├── apps/
│   ├── api/             (@zero/api)            — CF Worker: API, webhooks, orchestration
│   └── web/             (@zero/web)            — Vite + React + Tailwind frontend
├── packages/
│   ├── core/            (@zero/core)           — Shared types between api & web
│   ├── agent-server/    (@zero/agent-server)   — Node.js agent server (runs in CF Container)
│   ├── drizzle-migrator/                       — Drizzle migration utility
│   ├── eslint-config/                          — Shared ESLint config
│   └── typescript-config/                      — Shared TypeScript config
└── docs/                                       — Design docs
```

`pnpm-workspace.yaml` includes `apps/*` and `packages/*`.

## Tech Stack (matching existing apps)

| Layer | Tech |
|---|---|
| Auth | Clerk (+ GitHub OAuth social connection) |
| Frontend | React 19, Tailwind v4, shadcn/ui components, Zustand, react-router, lucide icons |
| API | Hono + OpenAPIHono + Zod on Cloudflare Workers |
| State | Durable Objects (SQLite + Drizzle) |
| Agent compute | Cloudflare Containers with pi SDK |
| Real-time | WebSocket: browser↔SessionDO (Hibernation API) + SessionDO↔Container (ephemeral event WS); UserDO (Hibernation API) for user-level push events |
| Secrets | Doppler (projects: `zero-api`, `zero-web`) |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Frontend (Vite + React)                     │
│  ┌───────────┐  ┌───────────────┐  ┌──────────────────┐    │
│  │ Projects   │  │ Inbox          │  │ Agent Sessions   │    │
│  │ (repos)    │  │ (global feed  │  │ (terminal, logs, │    │
│  │            │  │  + per-project)│  │  status)         │    │
│  └───────────┘  └───────────────┘  └──────────────────┘    │
└─────────────────────────┬───────────────────────────────────┘
                          │ REST + WebSocket (agent sessions via SessionDO ↔ Container)
                          │ WebSocket (session status push via UserDO)
┌─────────────────────────▼───────────────────────────────────┐
│            CF Worker (API + Orchestration)                    │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐    │
│  │ GitHub App   │  │ UserDO       │  │ ProjectDO      │    │
│  │ Webhooks +   │  │ (registry,   │  │ (per-repo      │    │
│  │ OAuth        │  │  prefs,      │  │  session index, │    │
│  │              │  │  install)    │  │  settings)      │    │
│  └──────────────┘  └──────────────┘  └────────────────┘    │
│                                                              │
│  ┌──────────────┐  ┌──────────────────────────────────┐    │
│  │ InboxDO      │  │ SessionDO (per agent session)     │    │
│  │ (per-user,   │  │ - State machine + event log       │    │
│  │  all notifs   │  │ - WebSocket hub (standard accept)  │    │
│  │  across all   │  │ - WebSocket to container           │    │
│  │  providers)   │  │ - Persists + broadcasts to browser│    │
│  └──────────────┘  └──────────────┬────────────────────┘    │
└──────────────────────────────────┬─────────────────────────┘
                                    │ container.start() / fetch()
┌───────────────────────────────────▼────────────────────────┐
│          CF Container (AgentContainer)                       │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  Node.js + git + pi SDK                                │ │
│  │  - Clones repo (with GitHub App token)                │ │
│  │  - Runs pi session via SDK (createAgentSession)       │ │
│  │  - Exposes HTTP API for status/output streaming       │ │
│  │  - Auto-sleeps after idle timeout                     │ │
│  └───────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

## DO ID Strategy

All DOs are created with `newUniqueId()` — never `idFromName()`. This ensures DOs are placed near the user for low latency. The tradeoff is that we need a lookup chain to find them.

**Exception:** Webhook paths (background processing, latency not critical) may use `idFromName()`.

### KV Bootstrap

A single KV binding stores the root mapping:

```
KV: user:{clerkUserId} → UserDO ID
```

This is one fast, globally-cached KV read per request.

### UserDO as Registry

UserDO stores references to all other DOs for the user:

```
UserDO:
  inboxDOId: string        — created with newUniqueId() on first use
  realtimeDOId: string     — created with newUniqueId() on first WebSocket connect
  projects: [              — created with newUniqueId() per repo
    { owner: string, repo: string, projectDOId: string }
  ]
```

### Lookup Chains

**User-facing request (optimized):**
```
KV(userId) → UserDO.getDOReferences() → { inboxDOId, realtimeDOId, projects }
```
One KV read + one UserDO call, then direct access to any DO.

**Webhook (latency not critical):**
```
KV(installationId → userId) → KV(userId → UserDO ID) → UserDO → target DO
```

### Auth Middleware Caching

The auth middleware resolves all DO references once per request and caches them in the Hono context:

```typescript
// Auth middleware (runs once per request)
const userDOId = await env.KV.get(`user:${userId}`);
const userDO = env.USERDO.get(userDOId);
const refs = await userDO.getDOReferences();

c.set("userDO", userDO);
c.set("inboxDOId", refs.inboxDOId);
c.set("realtimeDOId", refs.realtimeDOId);
c.set("projects", refs.projects);
```

Route handlers then access DOs directly — no extra UserDO call:

```typescript
const inboxDO = env.INBOXDO.get(c.get("inboxDOId"));
```

## Durable Objects

| DO | Keyed by | Purpose |
|---|---|---|
| **UserDO** | `newUniqueId()` (KV lookup) | DO registry, GitHub installation (single), connected providers, preferences, session index, user-level WebSocket push (Hibernation API) |
| **InboxDO** | `newUniqueId()` (ref in UserDO) | *(Not yet implemented)* All notifications for a user across all projects and providers |
| **ProjectDO** | `newUniqueId()` (ref in UserDO) | Project settings. *(Session index table exists but is unused — sessions are now indexed in UserDO)* |
| **SessionDO** | `newUniqueId()` (ref in UserDO) | Full session data: chat history (append-only event log), state machine, WebSocket hub (Hibernation API) for real-time browser communication, HTTP commands + ephemeral event WS to container |
| **RealtimeDO** | — | *(Not implemented — UserDO handles real-time push instead)* |
| **AgentContainer** | `newUniqueId()` | CF Container running the pi agent server. Must use `new_sqlite_classes` in wrangler migration (Container class uses SQLite internally). Access via `getContainer(env.BINDING, name).fetch(request)`. |

### InboxDO — Unified Notification Store

All notifications for a user live in a single InboxDO, regardless of source provider. This makes both the global feed and per-project views fast local queries:

| Query | SQL |
|---|---|
| Global feed | `SELECT * FROM notifications ORDER BY createdAt DESC LIMIT 50` |
| Per-project | `SELECT * FROM notifications WHERE projectId = ? ORDER BY createdAt DESC` |
| By provider | `SELECT * FROM notifications WHERE provider = ? ...` |
| Unread count | `SELECT COUNT(*) FROM notifications WHERE read = false` |
| By severity | `SELECT * FROM notifications WHERE severity = 'error' ...` |

No fan-out needed for any view — everything is a local query with appropriate indexes.

### Session Index Pattern

Sessions are split across two DOs to balance query efficiency and data isolation (same pattern as TrippyCards UserDO ↔ TripDO):

- **ProjectDO** keeps an **immutable session index** (`sessionDOId`, `title`, `provider`, `model`, `createdAt`). Written once on session creation, never updated. This makes listing sessions for a project a fast local query with no fan-out.
- **SessionDO** holds all mutable state: status, full chat history (append-only event log), and is the sole owner of session lifecycle. Each session gets its own DO instance and SQLite database.

SessionDO is the single source of truth for session status. No two-write pattern — only SessionDO is updated when status changes. When the frontend needs a session list with current statuses, the route handler queries ProjectDO for the index, then fan-outs to each SessionDO for `getStatus()` in parallel. For typical session counts (<50 per project) this completes in <50ms.

## Backend Layers

Following the existing framework pattern: **Worker → App → Routes → Services → DOs**

### Routes (API surface)

```
# Auth
POST   /api/auth/github/callback       — GitHub App installation callback

# Projects
GET    /api/projects                    — List user's repos (from GitHub API)
PUT    /api/projects/{owner}/{repo}/model — Set default model for a project

# Sessions (top-level, not nested under projects)
GET    /api/sessions                    — List sessions (optional ?owner=X&repo=Y filter)
POST   /api/sessions                    — Create + start session
DELETE /api/sessions/{id}               — Delete session
GET    /api/sessions/:id/ws             — WebSocket upgrade → SessionDO (real-time)

# Providers
GET    /api/providers                   — List available providers + connection status
POST   /api/providers/{id}/connect      — Start OAuth flow
POST   /api/providers/{id}/callback     — Complete OAuth flow
POST   /api/providers/{id}/api-key      — Set API key
DELETE /api/providers/{id}              — Disconnect provider

# Secrets
GET    /api/secrets                     — List secret names (values omitted)
POST   /api/secrets                     — Create/update secret
DELETE /api/secrets/{name}              — Delete secret

# GitHub Webhooks (no auth — verified by HMAC signature)
POST   /api/webhooks/github             — Receives all GitHub App events

# WebSocket (user-level push)
GET    /api/ws                          — WebSocket upgrade → UserDO (session status events)

# Not yet implemented
# GET  /api/inbox                       — Global notification feed
# GET  /api/projects/:owner/:repo       — Project detail + notifications
```

### Services

| Service | Responsibility |
|---|---|
| **GitHubService** | GitHub API calls, installation token management, repo listing |
| **SessionService** | Create/manage sessions, orchestrate container lifecycle, list/delete |
| **ContainerHandle** | Typed wrapper for a single container instance (HTTP API + WebSocket) |
| *(Future)* **InboxService** | Process webhooks → notifications, manage read/dismiss state |
| *(Future)* **ActionService** | LLM-powered action generation from notification context (async) |

### Webhook → Notification → LLM Action Pipeline

Notifications are written immediately; LLM enrichment happens asynchronously to avoid blocking the write path.

```
GitHub webhook arrives
  → Verify signature (HMAC)
  → Parse event type (issues, pull_request, check_run, push, etc.)
  → Map to user + project via installation ID
  → Write notification to InboxDO immediately (without actions)
  → Broadcast "new notification" to user's RealtimeDO → frontend shows it
  → Enqueue LLM enrichment (Queue or async worker call):
      Input: event type + payload summary + repo context
      Output: Array of { label, description, prompt }
        e.g. "Fix failing test" → prompt for pi agent
  → InboxDO.updateActions(notificationId, actions)
  → Broadcast "notification enriched" to RealtimeDO → frontend updates with action buttons
```

This two-step approach ensures:
- Notifications appear instantly (no LLM latency)
- LLM enrichment doesn't block other notification writes (DO single-thread concern)
- Frontend shows a loading state for actions, then updates when ready

### Notification Deduplication

With multiple providers, the same event may arrive through different channels (e.g., GitHub webhook + email about the same PR). Deduplication happens at the service layer before writing to InboxDO, keyed on `{provider}:{externalId}`.

### Agent Session Lifecycle

```
SessionStatus (from @zero/core):
  connecting — Frontend-only: WebSocket connecting to SessionDO
  starting   — Container booting, cloning repo
  resuming   — Container waking from sleep, restoring state
  running    — pi is executing, user can send messages
  idle       — pi finished task, container alive, waiting for user input
  stopped    — Container gone (will need cold start on next message)
  error      — Error during execution
```

> **Note:** `connecting` is used only on the frontend (not stored in SessionDO).
> The frontend also uses a local `creating` state before the session API call completes.

SessionDO manages this state machine and stores the full chat history. UserDO's `sessions` table is kept in sync with the current status on every transition (via `syncStatusToUserDO()`). AgentContainer runs the actual Docker image.

## Provider Credentials & Model Selection

Users can authenticate with multiple AI providers (via OAuth subscriptions or API keys) and choose which provider/model to use per project or per session.

### Supported Providers

Currently only **Anthropic** is supported (OAuth + API key). Additional providers (OpenAI, Google, etc.) can be added later when needed.

### Credential Storage

Containers are ephemeral — they sleep and may restart. Credentials must persist in the **Worker layer**, not inside the container.

```
UserDO stores all connected provider credentials:
  credentials: [
    { provider: "anthropic", type: "oauth", refresh: "...", access: "...", expires: ... },
  ]

ProjectDO stores default provider/model preference:
  defaultProvider: "anthropic"
  defaultModel: "claude-sonnet-4-20250514"

SessionDO stores the provider/model used for this session:
  provider: "anthropic"
  model: "claude-sonnet-4-20250514"
  (can override project default when creating a session)
```

When creating a session:
1. Look up project's preferred provider/model (or user's default)
2. Fetch the matching credentials from UserDO
3. Pass credentials + model choice to the container at start time

The container uses `AuthStorage.inMemory(credentials)` — no file I/O, no persistence inside the container.

### OAuth Login from the Web

Pi's OAuth providers use a two-step flow: generate an auth URL, then exchange a code for tokens. Both steps are plain HTTP (`fetch()` + Web Crypto for PKCE) and run natively in the Workers runtime — no container needed.

> **⚠️ Do not use pi's `login()` callback pattern** (`onAuth` + `onPrompt`). It creates a Promise in request A that resolves in request B, which Workers kills with a "cross-request promise resolution" error. Instead, implement the two steps as independent requests:

```
User clicks "Connect Anthropic" in Zero settings UI
  → Frontend calls POST /api/providers/anthropic/connect
  → Worker generates PKCE challenge (verifier + challenge) using Web Crypto
  → Worker stores verifier in UserDO (keyed by a one-time state token)
  → Worker builds auth URL with PKCE challenge and returns { authUrl }
  → Frontend opens auth URL in new tab
  → User authorizes in the provider's site, gets a code (format: "code#state")
  → User pastes code in Zero UI
  → Frontend calls POST /api/providers/anthropic/callback { code }
  → Worker retrieves stored PKCE verifier from UserDO
  → Worker exchanges code + verifier for tokens via fetch() to provider's token URL
  → Worker stores credentials in UserDO
  → Returns success to frontend
```

The PKCE constants (CLIENT_ID, TOKEN_URL, AUTHORIZE_URL, REDIRECT_URI, SCOPES) can be extracted from `@mariozechner/pi-ai` source. The exchange is a single `fetch()` POST — no pi library dependency needed at runtime for this step.

### Routes for Credential Management

```
# Provider credentials
GET    /api/providers                     — List available providers + which are connected
POST   /api/providers/{id}/connect        — Start OAuth flow (returns auth URL)
POST   /api/providers/{id}/callback       — Complete OAuth flow (receives auth code)
POST   /api/providers/{id}/api-key        — Set API key for a provider
DELETE /api/providers/{id}                — Disconnect a provider

# Model preferences (no models list endpoint — only project default)
PUT    /api/projects/{owner}/{repo}/model — Set default model for a project
```

### ✅ Validated: OAuth in Worker

Validated in Phase 0 spike. The OAuth token exchange is just `fetch()` + Web Crypto (PKCE), both available in Workers. The two-step approach (generate URL → exchange code) works reliably. Pi's `login()` callback pattern must NOT be used in Workers (cross-request promise resolution error).

## Pi Integration — SDK Approach

Pi is published as `@mariozechner/pi-coding-agent` on npm. It provides both a CLI and a **full SDK** for programmatic use. The container uses the SDK directly — no subprocess management, type-safe events, direct control over the session.

### Why SDK over CLI subprocess

- Same Node.js process — no stdin/stdout plumbing or process lifecycle management
- Type-safe event streaming via `session.subscribe()`
- Direct access to `session.prompt()`, `session.steer()`, `session.followUp()` for interactive use
- Can customize cwd, tools, system prompt per session programmatically
- Credentials passed as in-memory auth storage — no file I/O

### Agent Server

The container runs an **agent-server** — a Node.js HTTP server that wraps the pi SDK:

```typescript
// Note: ModelRegistry is from pi-coding-agent (NOT pi-ai)
// getModel is from pi-ai
import {
  createAgentSession, createCodingTools,
  SessionManager, AuthStorage, ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

// Credentials received from the Worker at start time
const credentials = JSON.parse(process.env.PI_CREDENTIALS!);
const authStorage = AuthStorage.inMemory(credentials);
const modelRegistry = new ModelRegistry(authStorage);

// Model selection from Worker
const model = getModel(process.env.PI_PROVIDER!, process.env.PI_MODEL!);

// After cloning, create session with cwd pointing to the repo
const { session } = await createAgentSession({
  cwd: "/workspace/repo",
  model,
  tools: createCodingTools("/workspace/repo"),
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// Stream events to connected clients
session.subscribe((event) => { /* relay to SSE/HTTP endpoint */ });
await session.prompt(taskPrompt);
```

### Agent Server HTTP API (inside container)

> **Note:** This section describes the original design. The current implementation replaced `POST /start` with `POST /resume` and `GET /events` (SSE) with `GET /ws` (WebSocket). See Slice 7 for the current architecture.

```
POST /resume    { provider, model, apiKey, repoUrl, token, secrets?, messages, workspaceRestored? }
                                            → Resume session (first-start or wake-from-sleep)
                                              Clone repo (or skip if workspaceRestored), configure model,
                                              restore conversation history, transition to idle.
POST /message   { text }                    → Send follow-up (runs agentLoop)
POST /steer     { text }                    → Interrupt current work (not yet implemented)
POST /stop                                  → Abort current operation (session.abort)
                                              session.abort() emits agent_end properly — abort is clean.
GET  /ws                                    → WebSocket for event streaming
                                              Events buffered in-memory, replayed from ?after=N on connect.
GET  /status                                → Session state (idle/starting/running/error)
GET  /workspace/snapshot                    → Snapshot workspace as tar.zst (streamed response)
POST /workspace/restore                     → Restore workspace from tar.zst (binary body)
POST /workspace/update-remote               → Update git remote URL with fresh token
```

**SSE event format:**
```
event: agent
data: {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}

event: status
data: {"status":"idle"}
```

Use named events so the browser can register targeted listeners: `es.addEventListener("agent", ...)`. The `AssistantMessageEvent` types are `text_delta`, `thinking_delta`, `toolcall_delta` — each with a `delta` string field (not `text`/`thinking`).

### Container Image

```dockerfile
FROM node:22-bookworm
RUN apt-get update && apt-get install -y git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["node", "server.js"]
```

Where `package.json` depends on `@mariozechner/pi-coding-agent`. Credentials and model selection are passed via the `POST /start` request body, not as build-time env vars.

> **Image size note (from spike):** With `node:22-bookworm` + git + pi SDK, the image is **1.37GB**. Production should explore `node:22-bookworm-slim` or multi-stage builds to reduce size. The bulk is the Debian base + git + npm dependencies.

### ✅ Validated: Container ↔ Worker Communication

Validated in Phase 0 spike. The recommended pattern is **SSE proxy** — the Worker passes the container's SSE stream directly to the browser with no parsing or relay logic:

```
Browser ←──EventSource──── Worker ←──SSE proxy──── Container
Browser ───POST──────────→ Worker ───POST────────→ Container
```

**How it works:**

1. Worker calls `container.fetch("/events")` which returns a `Response` with a streaming body
2. Worker returns `new Response(resp.body, { headers: { "Content-Type": "text/event-stream", ... } })` directly to the browser
3. Browser connects via native `EventSource` — zero parsing in the Worker
4. REST calls (`/start`, `/message`, `/stop`) are simple fetch-forwards through the Worker

**Why this works (DO single-threading is not an issue):**

The SSE response is returned immediately with a streaming body — the DO is not blocked reading from the stream. The `Response` constructor accepts a `ReadableStream` and Cloudflare handles the byte forwarding at the runtime level. The DO's JavaScript thread is free to handle other incoming requests (messages, stop).

**❌ WebSocket relay through Worker was rejected** for the spike: parsing SSE in the Worker and re-emitting as WebSocket messages adds complexity, requires cross-request state, and introduces SSE parsing bugs. The spike proved SSE proxy is simpler for a minimal prototype.

> **Phase 2 evolution:** The production design uses a **double WebSocket** architecture. SessionDO opens a WebSocket to the container (via `getContainer().fetch(switchPort(request, port))` with Upgrade header), receives events in real-time, persists them to its own local SQLite, and forwards to the browser via a second WebSocket (standard `server.accept()`, not hibernation API). SSE from containers is NOT used — response bodies are buffered inside DOs, making SSE streaming impossible. This solves persistence (local writes, no cross-DO RPC), multi-tab support (broadcast to all connected WebSockets from one container connection), and Worker lifetime concerns. See Phase 2 Slice 4 for implementation details.

## Notification Provider Abstraction

Notifications support multiple providers (GitHub, email, Slack, etc.) via an abstract shape. Common fields are promoted to indexed columns for efficient querying.

```typescript
// @zero/core
type NotificationProvider = 'github' | 'email' | 'slack';

type Notification = {
  id: string;
  provider: NotificationProvider;
  projectId: string | null;    // owner/repo or equivalent (null if not project-scoped)
  type: string;                // provider-specific: 'pull_request', 'issue', 'email', etc.
  title: string;
  summary: string;
  url: string;                 // link to source
  severity: 'info' | 'warning' | 'error';  // indexed, common across providers
  sourceRef: string | null;    // indexed: PR number, issue ID, email message-id, etc.
  payload: Record<string, unknown>;  // raw provider data (JSON blob)
  actions: SuggestedAction[] | null; // null = LLM enrichment pending
  read: boolean;
  createdAt: string;
};

type SuggestedAction = {
  id: string;
  label: string;               // "Fix failing test"
  description: string;         // "The CI check failed due to..."
  prompt: string;              // Full prompt for the pi agent
  type: 'agent' | 'link' | 'dismiss';  // What happens when clicked
};
```

`actions: null` distinguishes "enrichment pending" from "no actions available" (`actions: []`), allowing the frontend to show a loading state.

## Frontend Pages

```
/                                  — Dashboard: recent sessions
/projects                          — Project list (all repos from GitHub)
/projects/:owner/:repo             — Project detail: sessions for this repo
/sessions/new                      — Create new session (auto-creates, navigates to session page)
/sessions/:id                      — Session view: chat interface with pi (WebSocket)
/settings                          — Settings overview
/settings/providers                — Connect/disconnect AI providers, manage API keys, OAuth logins
/secrets                           — Manage user-level secrets (env vars injected into sessions)
/github/setup                      — GitHub App installation callback page
```

### Key UI Components

| Component | Description |
|---|---|
| **Sidebar** | Navigation links, session list with live status dots (via zustand store + UserDO WebSocket), user section |
| **StatusBadge** | Unified status badge for any session status (creating, connecting, starting, resuming, running, idle, stopped, error) |
| **TurnView** | Renders assistant turns: collapsible thinking blocks, markdown text, tool calls with args + results |
| **SessionPage** | Full chat interface with WebSocket, event processing, message input, abort button |
| *(Future)* **InboxFeed** | Filterable list of notifications with LLM action buttons |
| **ProjectView** | Notifications + sessions scoped to one repo |

## Secrets

Secrets follow the same Doppler + local env file pattern as the other apps (see `docs/secrets.md`). Two new Doppler projects:

### Doppler Projects

| Doppler Project | Config | Target File | Purpose |
|---|---|---|---|
| `zero-api` | `dev` | `zero/api/.dev.vars` | Worker runtime vars for local dev |
| `zero-api` | `prd` | Cloudflare Workers (via `wrangler secret bulk`) | Worker runtime vars for production |
| `zero-web` | `dev` | `zero/web/.env.local` | Vite build-time vars for local dev |
| `zero-web` | `prd` | `zero/web/.env.production` | Vite build-time vars for production builds |

### Worker Runtime Variables (`zero-api`)

| Variable | Purpose |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key (Zero Clerk app) |
| `CLERK_SECRET_KEY` | Clerk secret key for JWT verification |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM) for installation token generation |
| `GITHUB_WEBHOOK_SECRET` | Secret for verifying GitHub webhook signatures (HMAC) |
| `ANTHROPIC_API_KEY` | Anthropic API key for LLM action generation + pi agent sessions |
| `ENVIRONMENT` | `development` or `production` |

### Build-Time Variables (`zero-web`)

| Variable | Purpose |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key for React app initialization |

### Script Updates

**`bin/fetch-secrets`** — add:
```bash
doppler secrets download --config dev --project zero-api --no-file --format env | grep -v '^DOPPLER_' > zero/api/.dev.vars
doppler secrets download --config dev --project zero-web --no-file --format env | grep -v '^DOPPLER_' > zero/web/.env.local
doppler secrets download --config prd --project zero-web --no-file --format env | grep -v '^DOPPLER_' > zero/web/.env.production
```

**`bin/sync-secrets-to-cloudflare`** — add:
```bash
echo "=== Syncing Zero API worker secrets ==="
doppler secrets --json --config prd --project zero-api | \
  jq -c 'with_entries(.value = .value.computed) | to_entries | map(select(.key | startswith("DOPPLER_") | not)) | from_entries' | \
  pnpm --dir zero/api exec wrangler secret bulk
```

**`bin/ci`** — add:
```bash
pnpm --filter @zero/api run cf-typegen
```

All env files are already covered by the global `.gitignore` (`.dev.vars`, `.env.*`).

## Dev Environment

### Ports (unchanged from current canvas allocation)

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler)

### GitHub Webhook Delivery (local dev)

Use **Cloudflare Quick Tunnels** (free, no account needed) to expose the local worker for GitHub webhook delivery:

```bash
cloudflared tunnel --url http://localhost:8790
```

This gives a random `*.trycloudflare.com` URL. Set it as the webhook URL in the GitHub App settings (`https://<random>.trycloudflare.com/api/webhooks/github`). Re-run when the URL changes.

## Implementation Plan (phased)

### Phase 0 — Spike: End-to-End Validation

A minimal prototype to validate the riskiest parts of the architecture before building the full system. No auth, no GitHub, no notifications — just containers + pi + real-time streaming.

**Goal:** Start a CF Container running pi via the SDK, stream agent output in real-time to a browser, send messages, and abort — all with OAuth subscription credentials.

#### Architecture (minimal)

```
Browser (single page React)
  ← EventSource /api/realtime (agent output, SSE proxy)
  → REST (connect, start, message, stop)
  → CF Worker (Hono, no auth)
      ↕ Module-level state (credentials, container name)
      ↔ AgentContainer (CF Container running agent-server with pi SDK)
          ↕ SSE /events (buffered, named events)
          ↕ REST /start, /message, /stop
```

#### Components

**1. Container (agent-server)**
- `node:22-bookworm` + git
- Simple HTTP server wrapping pi SDK
- `POST /start { credentials, prompt }` → `AuthStorage.inMemory(credentials)`, `createAgentSession()`, execute prompt
- `GET /events` → SSE stream of `session.subscribe()` events
- `POST /message { text }` → `session.followUp(text)`
- `POST /stop` → `session.abort()`
- No repo cloning — runs in a temp workspace

**2. Worker (Hono, no auth)**
- Module-level state holds ephemeral credentials and PKCE verifier (no DO needed for spike)
- `POST /api/connect` → generate PKCE challenge, build Anthropic auth URL, store verifier, return `{ authUrl }`
- `POST /api/connect/callback { code }` → exchange code + stored verifier for tokens via `fetch()`, store credentials
- `POST /api/connect/restore { credentials }` → restore credentials from browser localStorage (dev convenience)
- `POST /api/session/start { prompt }` → forward to container with credentials + prompt
- `POST /api/session/message { text }` → forward to container
- `POST /api/session/stop` → forward abort to container
- `GET /api/realtime` → SSE proxy: `container.fetch("/events")` → `new Response(resp.body)` passthrough, with retry for container startup

**3. Frontend (single page, minimal React)**
- "Connect Anthropic" button → opens auth URL in new tab, input field to paste code back
- Credentials persisted in `localStorage`, auto-restored on page load via `/api/connect/restore`
- Status badge: disconnected / connected / running / idle (driven by `agent_end` events)
- Prompt input + send button (first message starts session, subsequent messages are follow-ups)
- Scrolling output area: accumulates `text_delta` and `thinking_delta` into readable blocks
- Tool calls shown with args, tool results shown with formatted output
- Abort button (visible while running) — calls `/api/session/stop`
- Connected via native `EventSource` to `/api/realtime` (connected when session starts)

#### What this validates

| Risk | How the spike tests it | Result |
|---|---|---|
| CF Containers can run pi SDK | Container starts, `createAgentSession()` works | ✅ Works |
| OAuth subscription from web | "Connect Anthropic" button → OAuth flow → tokens stored | ✅ Works (two-step, not callback) |
| `AuthStorage.inMemory()` with passed credentials | Container receives credentials from Worker, pi uses them | ✅ Works |
| Container → Worker streaming | Container SSE → Worker proxies to browser | ✅ SSE proxy works (WebSocket relay rejected) |
| Real-time output in browser | Agent events appear live as pi executes | ✅ Works with event buffering |
| Abort from browser | Abort button → Worker → container `session.abort()` → pi stops | ✅ Works, agent_end emitted cleanly |
| Follow-up messages | Send message after agent finishes, agent responds | ✅ Works |
| DO single-threading concern | Can Worker handle SSE proxy + incoming REST messages? | ✅ Not an issue — SSE response is non-blocking |

#### What this does NOT validate (deferred)

Clerk auth, GitHub connector, inbox/notifications, multi-session, repo cloning, persistence, per-project model selection

#### Success criteria

1. ✅ Open the page, click "Connect Anthropic", complete OAuth
2. ✅ Type a prompt (e.g., "list the files in the current directory")
3. ✅ See pi's output stream in real-time in the browser (thinking + text + tool calls)
4. ✅ Click Abort while pi is mid-response and it stops
5. ✅ Send a follow-up message after pi finishes

#### Spike deliverables

- Working Dockerfile + agent-server
- Wrangler config with Container + DO bindings
- Minimal frontend page
- Findings documented below

### Phase 0 Spike — Findings

Everything below was discovered building and testing the spike. These findings are incorporated into the relevant design sections above (marked with ✅ Validated) and should guide Phase 1+ implementation.

#### OAuth in Workers Runtime

**What works:**
- The Anthropic OAuth token exchange is plain HTTP: `fetch()` POST to `console.anthropic.com/v1/oauth/token` with PKCE verifier. This runs natively in Workers.
- PKCE generation uses Web Crypto (`crypto.getRandomValues`, `crypto.subtle.digest`) — both available in Workers.
- The full flow (generate URL → user authorizes → exchange code → get tokens) completes in ~400ms for the exchange step.

**What doesn't work:**
- Pi's `OAuthProviderInterface.login()` uses a callback pattern: `onAuth` provides a URL, `onPrompt` returns a Promise that resolves when the user pastes a code. This creates a Promise in request A that must be resolved by request B. **Workers kills this** with: _"A promise was resolved or rejected from a different request context than the one it was created in."_

**Production pattern:** Implement OAuth as two independent stateless requests. Store the PKCE verifier in UserDO (keyed by a random state token) between requests. Extract the OAuth constants (CLIENT_ID, TOKEN_URL, etc.) from `@mariozechner/pi-ai` source — they're simple strings, no runtime dependency needed.

#### Cloudflare Containers

**Key facts discovered:**
- `@cloudflare/containers` npm package exports a `Container` class that extends `DurableObject`
- Access containers via `getContainer(env.BINDING, name).fetch(request)` — **not** `env.BINDING.get(id).fetch()`
- Migration in `wrangler.jsonc` **must use `new_sqlite_classes`**, not `new_classes` — the Container class uses SQLite internally for scheduling and state management. Using `new_classes` causes: _"SQL is not enabled for this Durable Object class"_
- `wrangler dev` auto-builds the Docker image from the referenced Dockerfile, tags with content hash, rebuilds on file changes
- Container starts **lazily on first `fetch()`** — takes ~5 seconds to boot. The `@cloudflare/containers` library polls the container port during startup and logs "connection refused" / "operation aborted" errors until ready. These are normal and stop once `Port XXXX is ready` appears.
- Container auto-sleeps after the configured `sleepAfter` timeout (e.g., `"10m"`)
- Image size with `node:22-bookworm` + git + pi SDK: **1.37GB**

**Wrangler config pattern:**
```jsonc
{
  "containers": [{
    "class_name": "AgentContainer",
    "image": "./path-to/Dockerfile",
    "max_instances": 1,
    "instance_type": "basic"
  }],
  "durable_objects": {
    "bindings": [{ "name": "AGENT_CONTAINER", "class_name": "AgentContainer" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AgentContainer"] }]
}
```

#### Pi SDK (Programmatic Use)

**Import mapping (easy to get wrong):**
```typescript
// From @mariozechner/pi-coding-agent (NOT pi-ai):
import { createAgentSession, createCodingTools, SessionManager, AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

// From @mariozechner/pi-ai:
import { getModel } from "@mariozechner/pi-ai";
```

**`AssistantMessageEvent` types** (the streaming deltas):
- `text_delta` — `{ type: "text_delta", delta: string, ... }`
- `thinking_delta` — `{ type: "thinking_delta", delta: string, ... }`
- `toolcall_delta` — `{ type: "toolcall_delta", delta: string, ... }`
- Also: `text_start`, `text_end`, `thinking_start`, `thinking_end`, `toolcall_start`, `toolcall_end`, `start`, `done`, `error`

**Important:** the field is `delta` (not `text` or `thinking`). Frontend must accumulate deltas into complete messages for readable display.

**Session lifecycle events:** `agent_start` → `turn_start` → `message_start` → `message_update`* → `message_end` → (`tool_execution_start` → `tool_execution_update`* → `tool_execution_end`)* → `turn_end` → `agent_end`

**Abort behavior:** `session.abort()` is async (calls `agent.abort()` + `agent.waitForIdle()`). It properly emits `agent_end` so the SSE stream delivers the completion signal to the browser. Clean and reliable.

#### Streaming Architecture

**❌ WebSocket relay (rejected):**

The initial design called for Container SSE → Worker parses SSE → Worker sends via WebSocket → Browser. This failed because:
1. SSE parsing in the Worker adds complexity and bugs
2. WebSocket lifecycle management (upgrade, close, reconnect) is fragile
3. The DO single-threading concern was a red herring — the real issue was the relay complexity

**✅ SSE proxy (adopted):**

The Worker proxies the container's SSE stream directly to the browser:

```typescript
// Worker route handler
const resp = await container.fetch(new Request("http://container/events", {
  headers: { Accept: "text/event-stream" },
}));
return new Response(resp.body, {
  headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
});
```

Browser connects with native `EventSource`:
```typescript
const es = new EventSource("/api/realtime");
es.addEventListener("agent", (e) => { /* handle agent event */ });
es.addEventListener("status", (e) => { /* handle status change */ });
```

**Why SSE proxy works for DO single-threading:** The `Response` is returned immediately with a `ReadableStream` body. The Worker's JavaScript thread is **not blocked** reading the stream — Cloudflare's runtime handles the byte forwarding. The Worker can continue handling other requests (POST `/message`, POST `/stop`).

**Event buffering is essential:** The agent starts producing events inside the container as soon as `/start` is called. The browser's `EventSource` connection arrives seconds later (container boot takes ~5s on first request). Without buffering, early events (often including the entire thinking block + initial text) are lost. The container must buffer events in-memory and flush them when the first SSE client connects.

**SSE connection retry:** The Worker's SSE proxy route should retry `container.fetch("/events")` with backoff, since the container may still be starting when the browser connects.

#### Credential Persistence

Module-level state in Workers is lost on restart/redeploy. For the spike, credentials were stored in browser `localStorage` and restored via a `POST /api/connect/restore` endpoint on page load. For production, credentials must live in UserDO as designed — the spike's localStorage pattern is only useful for local dev convenience.

---

### Phase 1 — Skeleton + Auth + GitHub + Providers ✅

**Status: Complete.**

What was built:

- **Scaffold:** Wiped old canvas app (ReactFlow, build routes). Created `zero/core/` (`@zero/core`) shared types. Renamed packages `@canvas/*` → `@zero/*`. Updated `turbo.json`, `bin/fetch-secrets`, `bin/sync-secrets-to-cloudflare`, `bin/ci`.
- **Secrets:** Doppler projects `zero-api` and `zero-web` (dev + prd configs). `bin/fetch-secrets` generates `.dev.vars` and `.env.local`/`.env.production`.
- **API (Hono + Clerk):** `clerkMiddleware()` + `getAuth()` pattern from TrippyCards. Auth middleware resolves `KV(user:{clerkUserId})` → UserDO, auto-creates with `newUniqueId()` on first request, caches DO refs in Hono context. Health endpoint at `/api/health`. CORS configured for frontend origin.
- **Frontend (React + Clerk):** `ClerkProvider` + `SignIn` gate. Tailwind v4 + shadcn/ui (new-york style, neutral baseColor, lucide icons). Sidebar layout with react-router: `/` (Dashboard), `/projects`, `/settings`, `/settings/providers`.
- **UserDO:** SQLite + Drizzle. Stores provider credentials (OAuth tokens + API keys), GitHub installation (single per user), project references (owner/repo → ProjectDO ID), PKCE verifiers for OAuth flows. Migration generated.
- **ProjectDO:** SQLite + Drizzle. Session index table (lightweight, for fast listing) + project settings. Migration generated.
- **Provider credentials:** Routes `GET/POST/DELETE /api/providers/*`. Anthropic PKCE OAuth (two-step: generate URL → exchange code, Web Crypto for PKCE). API key storage for Anthropic, OpenAI, Google Gemini. Settings/Providers UI with OAuth code paste flow and API key input.
- **GitHub App:** Webhook receiver `POST /api/webhooks/github` with HMAC SHA-256 signature verification. Installation event handling with KV storage for webhook routing. `GitHubService` for JWT-based installation token generation and paginated repo listing. Installation callback route placeholder.
- **Projects:** `GET /api/projects` lists repos from the user's GitHub installation, auto-creates ProjectDO entries. `PUT /api/projects/:owner/:repo/model` sets default provider/model. Projects UI with repo list, visibility icons, GitHub App install link, and manual installation ID linking.
- **Dev server:** Runs via `pnpm turbo dev` (job `dAn`). API on port 8790 (`--port 8790 --inspector-port 9232`), web on port 5176 with Vite proxy to API.
- **`wrangler.jsonc`:** KV binding, UserDO + ProjectDO bindings, `new_sqlite_classes` migration, assets serving with SPA fallback.

Key files:
- `zero/core/src/index.ts` — shared types (Notification, Session, Project, Provider, UserDOReferences)
- `zero/api/src/app.ts` — Hono app with Clerk middleware + auth guard
- `zero/api/src/UserDO/` — DO + schema + migration
- `zero/api/src/ProjectDO/` — DO + schema + migration
- `zero/api/src/routes/providers.ts` — provider credential CRUD + OAuth
- `zero/api/src/routes/projects.ts` — project listing + model preference
- `zero/api/src/routes/webhooks.ts` — GitHub webhook receiver
- `zero/api/src/services/github.ts` — JWT, installation tokens, repo listing, signature verification
- `zero/web/src/App.tsx` — ClerkProvider + auth gate
- `zero/web/src/main.tsx` — react-router with sidebar layout
- `zero/web/src/pages/ProvidersPage.tsx` — OAuth + API key management UI
- `zero/web/src/pages/ProjectsPage.tsx` — repo list from GitHub API + manual installation ID linking

### Phase 2 — Agent Sessions

#### Phase 2 Slice 1 — SSE Proxy + Basic Sessions ✅

**Status: Complete.**

A pragmatic first slice using the SSE proxy pattern from the spike (not WebSocket + SessionDO persistence). Gets sessions working end-to-end with minimal complexity.

**What was built:**

- **Agent server** (`zero/agent-server/`): Node.js HTTP server wrapping `agentLoop` from `@mariozechner/pi-ai` + `codingTools` from `@mariozechner/pi-coding-agent`. HTTP API: `POST /start` (prompt optional), `POST /message`, `POST /steer`, `POST /stop`, `GET /events` (SSE), `GET /status`. EventBuffer for in-memory event storage + SSE streaming with replay and multiple concurrent clients.
- **Two-phase session creation**: Sessions are created without a prompt. The container clones the repo and waits in `"ready"` status. The prompt is sent later via `POST /message`. This allows the frontend to navigate immediately to the session page and let the user type while the container spins up.
- **SessionDO** (minimal): Metadata only (status, containerName, projectOwner, projectRepo, provider, model, createdAt). No events table, no WebSocket. Just enough for routing and authorization.
- **Session routes**: `POST /sessions` (create, prompt optional), `POST /sessions/:id/message` (proxy to container), `GET /sessions/:id/stream` (SSE proxy from container with retry loop for container startup).
- **SessionService**: Resolves credentials (API key or OAuth fallback), gets GitHub installation token, creates SessionDO, starts container. Checks container `/start` response status.
- **ProjectDetailPage**: Shows project with "New Session" button linking to `/projects/:owner/:repo/sessions/new`.
- **SessionPage**: Full chat interface with SSE streaming:
  - Auto-creates session on mount when navigating to `/sessions/new` (no prompt needed)
  - URL updated via `window.history.replaceState` to avoid React Router remount
  - User can type while session spins up; prompt queued in `pendingPromptRef`
  - Auto-sends queued prompt when `"ready"` SSE event arrives
  - Event processing pipeline: thinking blocks (collapsible), text, tool calls, tool results
  - Status badge: creating → connecting → starting → ready → running → idle
  - SSE deduplication via `lastSeqRef` to handle EventSource reconnects
  - StrictMode-safe with deep cloning of turns array and `createdRef` guard

**Key architectural decisions (deferred from full Phase 2 design):**
- **SSE proxy through Worker** instead of WebSocket + SessionDO. Simpler, proven in spike. No event persistence — events only exist in the container's in-memory EventBuffer. Trade-off: no session resume after container restart, no multi-tab support.
- **No session list/detail/delete routes** yet. ProjectDetailPage just links to new sessions.
- **ProjectDO schema not cleaned up** — `session_index` still has mutable `status` and `updatedAt` columns (design calls for immutable index). These are written on creation but not read/updated by the current flow.
- ~~**No follow-up messages, abort, or steer from UI**~~ — Follow-ups and abort resolved in Slice 2. Steer still deferred.

**Agent-server status lifecycle (extended from design):**
```
idle → starting → ready (no prompt) → running → idle (→ running follow-up → idle ...)
                → running (with prompt) → idle
                → error
running → error
        → idle (abort — allows follow-ups)
```

The `"ready"` status is new — indicates the container has cloned the repo, set up credentials, and is waiting for the initial prompt via `POST /message`.

**Frontend status lifecycle (superset of agent statuses):**
```
creating → connecting → starting → ready → (user submits) → running → idle
                                         → error
```
`creating` and `connecting` are frontend-only states for session creation and SSE connection.

**Files:**
- `zero/agent-server/src/` — `index.ts`, `server.ts`, `session.ts`, `events.ts`, `types.ts`
- `zero/api/src/SessionDO/` — DO + schema + migration (metadata only)
- `zero/api/src/routes/sessions.ts` — create, message proxy, SSE proxy
- `zero/api/src/services/session.ts` — session orchestration
- `zero/web/src/pages/SessionPage.tsx` — chat UI with SSE
- `zero/web/src/pages/ProjectDetailPage.tsx` — project view with "New Session"

---

#### Phase 2 Slice 2 — Follow-ups + Abort ✅

**Status: Complete.**

Enabled follow-up messages and abort from the UI using the existing SSE + REST architecture. No WebSocket migration — the container already had `POST /message` and `POST /stop` endpoints, just needed proper wiring.

**Why not WebSocket:** Abort and follow-ups are REST operations. WebSocket is a persistence and resilience concern (multi-tab, session resume, event replay) — not an interaction concern. Keeping SSE + REST kept this slice small.

**What was built:**

**1. Agent-server — conversation history (`SessionWrapper._messages`)**

`SessionWrapper` now accumulates messages across turns via a `_messages: Message[]` field. Each `runAgentLoop()` passes `messages: [...this._messages]` to `AgentContext` so the LLM has full conversation history. On `agent_end`, `event.messages` (the new messages from that turn) are appended to `_messages`. The field is cleared on `start()` for new sessions.

**2. Agent-server — follow-up support**

`sendMessage()` now accepts both `"ready"` (initial prompt) and `"idle"` (follow-up after a turn completes). Same code path — `runAgentLoop()` handles both since it now has accumulated history.

**3. Agent-server — abort → idle transition**

`stop()` now transitions to `"idle"` instead of `"stopped"`, so the user can send follow-ups after aborting. Conversation history is preserved across aborts.

**4. Worker route — stop proxy**

Added `POST /api/projects/:owner/:repo/sessions/:id/stop` route. Same pattern as `/message` proxy: look up SessionDO for container name, verify project ownership, forward `POST /stop` to container.

**5. Frontend — persistent input**

Input is now visible whenever `status` is `"ready"`, `"idle"`, `"creating"`, `"connecting"`, or `"starting"` (allows typing while session spins up). Removed the `promptSent` state — no longer needed. Placeholder text changes contextually: "Describe what you want the agent to do..." for initial prompt, "Send a follow-up..." when idle.

**6. Frontend — abort button**

A "Stop" button (red, destructive variant, with square icon) appears when status is `"running"`. Calls `POST /sessions/:id/stop` through the Worker. Status transitions to `"idle"` via the existing SSE status event, then the input reappears for follow-ups.

**7. Frontend — follow-up message flow**

When the user sends a message while status is `"idle"`: user turn is added to chat immediately, `POST /sessions/:id/message` is called, status transitions `idle → running` via SSE, agent response streams in via existing SSE connection with full conversation context.

**Files changed:**
- `zero/agent-server/src/session.ts` — `_messages` accumulation, idle follow-ups, abort→idle
- `zero/api/src/routes/sessions.ts` — added stop proxy route
- `zero/web/src/pages/SessionPage.tsx` — persistent input, abort button, follow-up flow

---

#### Phase 2 Slice 3 — Session List, Navigation + Delete

**Status: Complete.**

Users cannot see or return to existing sessions — the ProjectDetailPage only has a "New Session" button. This slice adds session listing, navigation to existing sessions, proper delete with full cleanup, and wires up the ProjectDO session index that was built but never connected.

**Why this slice next:**
- **Highest user value** — without it, every page refresh loses access to running sessions
- **Small scope** — no new DOs, no protocol changes, no infrastructure work
- **Uses existing code** — ProjectDO already has `addSessionToIndex()` and `listSessions()`, SessionDO has `getStatus()`, SessionPage already handles connecting to existing sessions via SSE

**What gets built:**

**1. Wire up ProjectDO session index during creation**

`createSession()` in `SessionService` currently creates the SessionDO but never adds it to ProjectDO's session index. Fix: pass `projectDOId` into `createSession()`, resolve the ProjectDO stub, call `addSessionToIndex()` after SessionDO init. Title defaults to `"Session <short-id>"` (first 8 chars of DO ID).

**2. List sessions route — `GET /api/projects/:owner/:repo/sessions`**

Returns sessions for a project. Two-step: `projectDO.listSessions()` for the index, then parallel `sessionDO.getStatus()` fan-out for live status. Response shape:

```json
{
  "sessions": [
    {
      "id": "abc123...",
      "title": "Session abc123...",
      "status": "idle",
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "createdAt": "2026-02-20T12:00:00Z"
    }
  ]
}
```

The `status` in the response comes from the SessionDO fan-out (live), not the ProjectDO index (stale). The ProjectDO index `status` column remains but is not trusted for display — it's a known wart deferred to the schema cleanup.

**3. Session delete route with full cleanup — `DELETE /api/projects/:owner/:repo/sessions/:id`**

Full cleanup is required to avoid orphaned DOs that continue to be billed for storage. Both `SessionDO` and `AgentContainer` (which extends `DurableObject` via the `Container` class) write to DO storage. Per Cloudflare docs: *"you must explicitly call `storage.deleteAll()` to empty storage... Calling `deleteAll()` ensures that a Durable Object will not be billed for storage."*

**Delete flow (4 steps):**

1. **Stop agent-server process** — Best-effort `container.fetch("http://container/stop")`. May fail if container already sleeping — that's fine.
2. **Destroy container + clear AgentContainer DO storage** — Call `agentContainerStub.cleanup()` (new RPC method on `AgentContainer`). This calls `this.destroy()` to SIGKILL the container VM, then `this.ctx.storage.deleteAll()` to wipe the backing DO storage. The `Container` base class writes internal state (scheduling, lifecycle tracking) to DO storage via a private `sql` field, so `deleteAll()` is the only way to fully clean up.
3. **Clear SessionDO storage** — Call `sessionDO.deleteSession()` (new RPC method). This calls `this.ctx.storage.deleteAll()` to wipe session metadata. The DO ceases to exist once storage is empty.
4. **Remove from ProjectDO index** — Call `projectDO.removeSessionFromIndex(sessionDOId)` (new method). Deletes the row from `session_index`.

All steps are best-effort with error logging — if the container is already gone, we still clean up the DOs and index. The route returns success if at least the index removal succeeds.

**New RPC methods:**
- `AgentContainer.cleanup()` — `await this.destroy(); await this.ctx.storage.deleteAll();`
- `SessionDO.deleteSession()` — `await this.ctx.storage.deleteAll();`
- `ProjectDO.removeSessionFromIndex(sessionDOId)` — `DELETE FROM session_index WHERE sessionDOId = ?`

**4. ProjectDetailPage — session list UI**

Replace the bare "New Session" button with a session list table. Columns: title (linked), status badge, provider, model, created time (relative). Delete button per row. "New Session" button remains in the header. Empty state: "No sessions yet" message.

Sessions link to `/projects/:owner/:repo/sessions/:id` — the existing SessionPage handles it.

**5. SessionPage — handle existing sessions on mount**

SessionPage currently auto-creates a new session on mount (when URL is `/sessions/new`). For existing session IDs, it should skip creation and go straight to connecting the SSE stream. The SSE proxy route already works for existing sessions — the container is still running and the EventBuffer has full history.

Check: SessionPage may already handle this if `id !== "new"` skips creation. Verify and fix if needed.

**Known issues:**
- Sending a message while the agent is already running (status `running`) appears to do nothing — the `/message` endpoint accepts it but the agent-server rejects it since a turn is already in progress. Carried forward to Slice 4 (WebSocket migration) where SessionDO can handle the error cleanly, then Slice 5 (input guards + steer) for proper UX.

**What's deferred:**
- **ProjectDO schema cleanup** (removing mutable status/updatedAt) — separate migration, no user-facing value on its own
- **Session rename/title editing** — titles are auto-generated for now
- **Pagination** — not needed until session counts are high
- **Session detail route** (`GET /sessions/:id` with events) — not needed until WebSocket migration; SSE stream provides all events

**Files changed:**
- `zero/api/src/AgentContainer.ts` — add `cleanup()` RPC method
- `zero/api/src/SessionDO/index.ts` — add `deleteSession()` RPC method
- `zero/api/src/ProjectDO/index.ts` — add `removeSessionFromIndex()` method
- `zero/api/src/services/session.ts` — accept `projectDOId`, call `addSessionToIndex()`
- `zero/api/src/routes/sessions.ts` — add list route, add delete route, pass `projectDOId` to `createSession()`
- `zero/web/src/pages/ProjectDetailPage.tsx` — fetch and display session list with delete
- `zero/web/src/pages/SessionPage.tsx` — verify existing session handling (may need minor fix)

---

#### Phase 2 Slice 4 — WebSocket + SessionDO Persistence ✅

**Status: Complete. ⚠️ Superseded by Slice 7** — the double-WebSocket architecture described here was replaced by the decoupled architecture (Hibernation API + HTTP commands + ephemeral event WS). See Slice 7 for current implementation.

Replaced the SSE-proxy-through-Worker pattern with the target architecture: **SessionDO as the real-time hub** using WebSocket + event persistence in local SQLite. This is the most important structural change in Phase 2.

**Architecture change:**

```
BEFORE (SSE proxy):
  Browser ←─EventSource──── Worker ←─SSE proxy──── Container
  Browser ──POST /message──→ Worker ──POST────────→ Container
  Browser ──POST /stop─────→ Worker ──POST────────→ Container

AFTER (double WebSocket + SessionDO):
  Browser ←─WebSocket──── SessionDO ←─WebSocket──── Container
  Browser ──ws.send()───→ SessionDO ──ws.send()───→ Container
                           │
                           └─ SQLite (session_events) ← persist all events
```

**What was built:**

**1. Agent server — WebSocket endpoint (`GET /ws`)**

Added `ws` and `@types/ws` npm dependencies. `WebSocketServer` with `noServer: true`, attached via HTTP server `upgrade` event. On connection: parses `?after=N` query param, calls `eventBuffer.registerWebSocket(ws, afterSeq)` to replay buffered events and register for live broadcast. Incoming messages dispatched to same handlers as REST: `{ type: "message" }` → `session.sendMessage()`, `{ type: "stop" }` → `session.stop()`, `{ type: "steer" }` → `session.steer()`. All existing REST + SSE endpoints preserved for debugging.

**2. EventBuffer — WebSocket client tracking**

Added `registerWebSocket(ws, afterSeq?)`, `unregisterWebSocket(ws)`, and broadcast-on-`addEvent()` to `EventBuffer`. WebSocket clients receive the same `{ seq, event, timestamp }` envelopes as the SSE/poll endpoints. Multiple concurrent WebSocket + SSE clients supported independently.

**3. SessionDO — full rewrite as WebSocket hub**

SessionDO now maintains two WebSocket connections: one to the browser (server side) and one to the container (client side).

- **Browser WebSocket:** Standard `server.accept()` (NOT hibernation API — see findings below). On connect: replays all stored events from SQLite, sends `caught_up` marker, then live events. Handles `message`, `stop`, `steer`, and `ping` commands.
- **Container WebSocket:** Opened via `getContainer(env.AGENT_CONTAINER, name).fetch(switchPort(req, 8080))` with `Upgrade: websocket` header. Idempotent `ensureContainerWebSocket()` with 15-attempt retry loop for container startup. On message: parse envelope, persist to SQLite via `appendEvents()`, update status if status event, broadcast to all browser WebSockets. On close/error: clear reference so next interaction triggers fresh connection.
- **Event persistence:** All events (agent + user) persisted to `session_events` table with SessionDO-assigned monotonic `seq` and container's original `containerSeq` (for reconnection after DO restart).
- **`sendToContainer(message)`:** Forwards JSON messages over the container WebSocket.
- **Deleted:** `ensureContainerSSEReader()` and `readContainerSSE()` polling methods.

**4. Worker route — WebSocket upgrade**

`GET /api/projects/:owner/:repo/sessions/:id/ws` — authenticates via Clerk session token in query param, verifies session ownership, forwards WebSocket upgrade to SessionDO.

**5. Frontend — WebSocket client**

SessionPage replaced EventSource with WebSocket. Message/stop/steer sent via `ws.send()` instead of separate REST calls. Event processing pipeline (`processAgentEvent()`) unchanged. `caught_up` message marks transition from replay to live. Session resume works — all stored events replayed on reconnect.

**6. Core types**

Added `{ type: "steer"; text: string }` to `SessionClientMessage` union type.

**7. Removed SSE proxy infrastructure**

Deleted SSE proxy route, REST message/stop proxy routes, and `createStatusInterceptor` TransformStream.

**Key findings / deviations from plan:**

- **NOT using hibernation API.** The DO must stay alive while the container WebSocket is active (fire-and-forget promise reading container WS messages would be killed by hibernation). Standard `server.accept()` keeps the DO alive as long as WebSocket connections exist. This is the correct pattern — documented in the code.
- **`getContainer().fetch(switchPort(req, port))` instead of `getTcpPort().fetch()`.** The `containerFetch()` RPC method can't pass WebSockets (workerd issue #2319). The HTTP `fetch()` path via `getContainer()` + `switchPort()` from `@cloudflare/containers` works correctly for WebSocket upgrades. Confirmed by the `@cloudflare/containers` source: `switchPort` sets a port header that the container proxy respects.
- **Agent server uses `ws` npm package** for server-side WebSocket. Node 22 has WebSocket client support but not server. The `ws` library's `WebSocketServer` with `noServer: true` integrates cleanly with the existing `http.createServer`.
- **Container WS connects on first attempt** when container is already running (verified in dev). The retry loop handles cold-start scenarios.
- **`steer` wired end-to-end** through both WebSocket legs and core types, though the agent-server's `session.steer()` currently throws "not yet supported".

**WebSocket protocol (as implemented):**

Client → Server (browser → SessionDO):
```json
{ "type": "message", "text": "fix the tests" }
{ "type": "stop" }
{ "type": "steer", "text": "focus on auth" }
{ "type": "ping" }
```

Server → Client (SessionDO → browser):
```json
{ "type": "event", "seq": 1, "source": "agent", "eventType": "message_update", "data": { ... } }
{ "type": "event", "seq": 15, "source": "user", "eventType": "message", "data": { "type": "user_message", "text": "fix the tests" } }
{ "type": "status", "status": "idle" }
{ "type": "caught_up", "lastSeq": 42 }
{ "type": "pong" }
{ "type": "error", "message": "Container unavailable" }
```

**Session lifecycle with double WebSocket:**

```
1. POST /sessions → SessionDO created (status=pending), container starting
2. Frontend navigates to session page
3. Frontend opens WebSocket → SessionDO accepts (browser WS)
4. SessionDO replays stored events (may be empty for new session) + sends caught_up + status
5. SessionDO opens WebSocket to container via getContainer().fetch(switchPort()) (retry loop for boot)
6. Container events flow: Container → container WS → SessionDO (persist + broadcast) → browser WS
7. User sends message via browser WS → SessionDO persists user event → forwards via container WS
8. Agent responds → events flow back through same path
9. Agent finishes → status=idle → user can send follow-up
10. User sends follow-up → ensureContainerWebSocket() (reconnects if needed) → forwards message
11. User navigates away → browser WS closes → DO stays alive if container WS open
12. User navigates back → new browser WS → SessionDO replays ALL stored events from SQLite → caught_up
```

Step 12 is the key unlock: **full session resume from persistent storage**, regardless of container state.

**Files changed:**
- `zero/agent-server/package.json` — added `ws`, `@types/ws`
- `zero/agent-server/src/server.ts` — added `/ws` WebSocket endpoint via `WebSocketServer` with `noServer: true`
- `zero/agent-server/src/events.ts` — added `registerWebSocket()`, `unregisterWebSocket()`, WS broadcast in `addEvent()`
- `zero/api/src/SessionDO/db/schema.ts` — added `sessionEventsTable` (done in prior slice)
- `zero/api/src/SessionDO/index.ts` — full rewrite: standard WebSocket handler, container WS via `getContainer()+switchPort()`, `appendEvents()`, `getEvents()`, `broadcastToWebSockets()`, `sendToContainer()`, `ensureContainerWebSocket()`
- `zero/api/src/routes/sessions.ts` — added WebSocket upgrade route, removed SSE/REST proxy routes
- `zero/web/src/pages/SessionPage.tsx` — replaced EventSource with WebSocket, message/stop via `ws.send()`
- `zero/core/src/index.ts` — added `steer` to `SessionClientMessage`

**What's deferred:**
- **Input guards** — disable message input while running, show steer input instead
- **WebSocket reconnection with exponential backoff** — basic reconnect on close for now
- **ProjectDO schema cleanup** (removing mutable status/updatedAt) — separate migration

---

---

#### Phase 2 Slice 5 — Provider Cleanup + Frontend Decomposition ✅

**Status: Complete.**

Two housekeeping improvements with no user-facing behaviour change.

**1. Remove non-Anthropic providers**

`ProvidersPage` and the backend routes previously listed OpenAI and Google Gemini as connectable providers. Only Anthropic is actually wired to the agent, so the dead entries were removed:

- `zero/web/src/pages/ProvidersPage.tsx` — removed OpenAI and Google cards
- `zero/api/src/routes/providers.ts` — removed OpenAI/Google credential routes and model lists

**2. Decompose `SessionPage.tsx` (750 → ~420 lines)**

`SessionPage.tsx` mixed four concerns in one 750-line file. Extracted into focused modules:

| New file | Contents |
|---|---|
| `zero/web/src/lib/session-types.ts` | `Turn`, `ContentBlock`, `SessionStatus`, and all block type definitions |
| `zero/web/src/lib/process-agent-event.ts` | `processAgentEvent()` — pure function, safe to unit-test |
| `zero/web/src/components/TurnView.tsx` | `TurnView`, `ThinkingBlockView`, `TextBlockView`, `ToolCallBlockView`, `ToolResultBlockView` |
| `zero/web/src/components/StatusBadge.tsx` | Unified `StatusBadge` accepting any status string, with fallback for unknown values |

`ProjectDetailPage.tsx` had its own local `StatusBadge` copy that was replaced with the shared component.

---

#### Phase 2 Slice 6 — Container WebSocket Keepalive + Error Surfacing ✅

**Status: Complete. ⚠️ Superseded by Slice 7** — the keepalive management described here was removed entirely in the decoupled architecture. Container sleeps via its own `sleepAfter` timeout; no SessionDO-side keepalive is needed.

**Problem:** Follow-up messages to idle sessions were silently dropped. Two root causes:

1. **No keepalive on SessionDO ↔ Container WebSocket** — after a turn completes the WS sits idle with no pings. The network layer closes it. On the next follow-up, `ensureContainerWebSocket()` reconnects but the container had gone to sleep (or the WS was simply dead).
2. **Errors swallowed silently** — `sendToContainer()` logged to `console.error` when `containerWs` was null. Errors from the container's WS handler (e.g. `sendMessage()` rejections) were also only `console.error`'d, never reaching the browser.
3. **Pong treated as event** — after adding pings, the container's `{ type: "pong" }` response was parsed as an event envelope and an insert into `session_events` was attempted, hitting a `NOT NULL constraint failed` on the `data` column.

**Session-aware keepalive lifecycle**

The desired behaviour:
- Browser connected → container must stay awake
- Browser disconnected + agent still running → container must stay awake
- Browser disconnected + agent idle → container may sleep

**Implementation in `SessionDO`:**

- Added `private currentStatus: SessionStatus` — in-memory mirror of persisted status, restored from SQLite in the constructor, kept in sync in `updateStatus()` and whenever a container status event arrives.
- Added `private containerKeepaliveInterval` field.
- `startContainerKeepalive()` — starts a 30 s interval calling `checkContainerKeepalive()`.
- `checkContainerKeepalive()` — the lifecycle decision:
  - `hasBrowsers || agentActive` (`running`/`starting`/`pending`) → ping the container WS; if `agentActive` and `containerWs` is null, reconnect.
  - Otherwise (no browsers, agent idle/completed/failed) → stop interval, close container WS cleanly so the container can sleep.
- `startContainerKeepalive()` called immediately after `this.containerWs = ws` is set.
- `checkContainerKeepalive()` called eagerly (not just on interval) when:
  - A browser WS disconnects (`close`/`error` handlers).
  - Agent status transitions to `idle`, `completed`, or `failed`.
- Container WS `close`/`error` handlers call `stopContainerKeepalive()`.

**Error surfacing:**

- `sendToContainer()` now `broadcastToWebSockets({ type: "error", message: ... })` when `containerWs` is null, instead of only `console.error`.
- Container's WS message handler (`server.ts`) catches `sendMessage()` rejections and adds them to `eventBuffer` as `{ type: "error", error: msg }` events.
- SessionDO's container WS message handler detects `eventType === "error"` events from the container and calls `broadcastToWebSockets({ type: "error", message: ... })` so they appear in the browser's error banner.

**Pong filter:**

Container's WS message handler in `server.ts` now responds to `{ type: "ping" }` with `{ type: "pong" }`. SessionDO's container WS `message` listener checks `raw.type === "pong"` and returns early before attempting to parse or persist the message as an event envelope.

**Files changed:**
- `zero/api/src/SessionDO/index.ts` — `currentStatus` field + init, `startContainerKeepalive()`, `stopContainerKeepalive()`, `checkContainerKeepalive()`, updated `updateStatus()`, updated container status/error event handlers, updated browser WS close/error handlers, updated `sendToContainer()`, pong filter in container WS message listener
- `zero/agent-server/src/server.ts` — `case "ping"` handler → pong; `sendMessage()` error → `eventBuffer.addEvent({ type: "error", error })`

---

#### Phase 2 Slice 7 — Decoupled Architecture + Container Resume ✅

**Status: Complete.**

Replaced the double-WebSocket architecture (Slices 4 & 6) with a decoupled pattern and implemented container session resume. This is the current production architecture.

**Architecture change:**

```
BEFORE (Slices 4-6 — double WebSocket, always-on):
  Browser ←─WS (standard accept)──── SessionDO ←─WS (permanent)──── Container
  Commands: browser WS → SessionDO → container WS
  Events:   container WS → SessionDO (persist + broadcast) → browser WS
  Keepalive: 30s ping/pong on container WS, lifecycle management in SessionDO

AFTER (Slice 7 — decoupled, hibernation-friendly):
  Browser ←─WS (hibernation API)──── SessionDO ──HTTP POST──→ Container
                                           ←─ephemeral WS (events only)──
  Commands: browser WS → SessionDO → HTTP POST /message, /stop, /steer
  Events:   ephemeral WS → SessionDO (persist + broadcast) → browser WS
  Keepalive: none. Container sleeps via sleepAfter timeout.
             Event WS cleaned up by onContainerStopped() callback.
```

**Why this change:**

The double-WS architecture required SessionDO to stay alive while the container WS was active (`server.accept()` prevents hibernation). This meant the DO was always-on for running sessions, paying for idle CPU time. The decoupled architecture separates commands (HTTP POST) from events (ephemeral WS), enabling SessionDO to use the Hibernation API and sleep between browser messages.

**What was built:**

**1. Hibernation API for browser connections**

SessionDO uses `ctx.acceptWebSocket()` instead of `server.accept()`. The DO can sleep between browser WS messages, waking automatically when a message arrives. State (seq counters, in-memory status mirror) restored from SQLite in the constructor via `blockConcurrencyWhile()`.

Hibernation handlers: `webSocketMessage()` (dispatches commands), `webSocketClose()` and `webSocketError()` (no-ops — Hibernation API auto-manages socket list). `ctx.getWebSockets()` replaces the manual `this.sockets` array.

**2. HTTP commands to container**

`sendCommandToContainer(type, payload)` replaces `sendToContainer()`. For message/stop/steer, it sends HTTP POST to the container via `getContainer().fetch(switchPort(req, 8080))`. This decouples the command path from the event path entirely.

The method also handles:
- Container state detection (`container.getState()`) to check if resume is needed
- Resume orchestration before sending the first message to a woken container
- Event WS connection (`openEventStream()`) if not already open
- Readiness polling — waits for `currentStatus` to reach `ready` or `idle` before sending `/message`

**3. Ephemeral event WebSocket**

`openEventStream(container)` opens a WS to the container's `/ws?after=N` endpoint. Events stream in, get persisted to SQLite, and broadcast to all browser WS clients. The WS is:
- Opened on-demand when a command is sent (lazy)
- Also opened proactively by `connectToContainer()` during session creation
- Closed on terminal states (`completed`/`failed`/`error`) via `closeEventStream()`
- Cleaned up by `onContainerStopped()` when the container sleeps/dies

**Key design decision:** `idle` does NOT close the event WS. The user may send follow-up messages, and the event WS must stay open to relay events from the next turn. Only `completed`, `failed`, and `error` trigger `closeEventStream()`.

**4. Removed keepalive management**

Deleted: `containerKeepaliveInterval`, `startContainerKeepalive()`, `stopContainerKeepalive()`, `checkContainerKeepalive()`. The container manages its own sleep via `sleepAfter` in `wrangler.jsonc`. SessionDO doesn't need to keep the container awake or detect staleness.

**5. Container resume**

When `sendCommandToContainer()` detects the container is stopped (via `getState()`), it calls `resumeContainerSession()`:

1. Broadcasts `{ type: "status", status: "resuming" }` to browser clients
2. Rebuilds conversation history from `agent_end` events in SQLite (`getConversationHistory()`)
3. Resolves fresh API key from UserDO (`listProviderCredentials()`)
4. Gets fresh GitHub installation token (`getInstallationToken()`)
5. Gets user secrets (`listUserSecretsWithValues()`)
6. POSTs to container `/resume` with retry loop (404/503 treated as transient during startup)

The agent-server's `POST /resume` handler: clones the repo fresh, restores `_messages` from the provided history, configures the model/provider, and transitions to `idle`. The session is then ready for follow-up messages.

**6. `connectToContainer()` RPC method**

Called by `SessionService` after `/start` succeeds. Opens the event WS proactively so container startup events (e.g. `ready` status) reach the browser. Without this, a deadlock occurs: browser waits for `ready` before sending the queued prompt, but SessionDO only opens the event WS on receiving a command (message/stop/steer).

**7. `onContainerStopped()` callback**

Called by `AgentContainer.onStop()` when the container is about to die. Calls `closeEventStream()` to clean up the ephemeral event WS. Replaces the old approach of detecting container death via WS close/error handlers and keepalive failures.

**8. Readiness polling**

After opening the event WS, `sendCommandToContainer()` polls `isContainerReady()` (checks `currentStatus === "ready" || "idle"`) before sending `/message`. The event WS delivers status events that update `currentStatus` asynchronously. Uses `setTimeout` yielding to allow event handlers to run. 120 iterations × 500ms = 60s timeout.

**Session lifecycle (current):**

```
1. POST /sessions → SessionDO created (status=starting), container starting
2. SessionService calls connectToContainer() → event WS opened for startup events
3. Container boots → status events (starting → ready) flow through event WS
4. Browser navigates to session page → WS upgrade via Hibernation API
5. SessionDO replays stored events + status + caught_up marker
6. Browser sends message → sendCommandToContainer():
   a. Opens event WS if not already open
   b. Waits for container ready (polls currentStatus)
   c. HTTP POST /message
7. Events flow: Container → event WS → SessionDO (persist + broadcast) → browser WS
8. Agent finishes → status=idle, event WS stays open
9. Container sleeps (sleepAfter timeout) → onContainerStopped() → event WS cleaned up
10. SessionDO hibernates (no active connections)
11. User returns, sends follow-up → SessionDO wakes → sendCommandToContainer():
    a. getState() returns "stopped" → needsResume=true
    b. resumeContainerSession() → POST /resume (clone + restore messages)
    c. openEventStream() → event WS reconnected
    d. Wait for ready → HTTP POST /message
12. Agent responds with full conversation context
```

**Files changed:**
- `zero/api/src/SessionDO/index.ts` — Full rewrite: Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`, `webSocketError`), `sendCommandToContainer()` (HTTP POST + resume detection + readiness polling), `openEventStream()` / `closeEventStream()` (ephemeral event WS), `resumeContainerSession()`, `connectToContainer()`, `onContainerStopped()`, `getConversationHistory()`, `isContainerReady()`. Removed: standard WS handler, `sendToContainer()`, all keepalive methods, manual socket array.
- `zero/api/src/AgentContainer.ts` — `onStop()` callback: resolves SessionDO stub, calls `sessionDO.onContainerStopped()`. `setSessionDOId()` RPC to receive the ID during session creation.
- `zero/api/src/services/session.ts` — Calls `container.setSessionDOId()` before `/start`, calls `sessionDO.connectToContainer()` fire-and-forget after `/start` succeeds. Passes `userDOId` to `initSession()`.
- `zero/agent-server/src/server.ts` — `POST /resume` endpoint with validation
- `zero/agent-server/src/session.ts` — `resume()` method: clones repo, restores `_messages`, configures model, transitions to `idle`
- `zero/agent-server/src/events.ts` — `clear()` method on EventBuffer (used by resume to reset seq)
- `zero/core/src/index.ts` — Added `"ready"` and `"resuming"` to `SessionStatus`
- `zero/web/src/pages/SessionPage.tsx` — Removed status gate from `caught_up` handler and `handleSend` (fixes deadlock where browser waited for "ready" before sending queued prompt)

**What was removed (from Slices 4 & 6):**
- Standard `server.accept()` WebSocket handler (replaced by Hibernation API)
- Permanent container WebSocket (`ensureContainerWebSocket()` with always-on connection)
- `sendToContainer()` (replaced by HTTP POST in `sendCommandToContainer()`)
- All keepalive management (`containerKeepaliveInterval`, `startContainerKeepalive()`, `stopContainerKeepalive()`, `checkContainerKeepalive()`)
- Manual `this.sockets` array for browser connections (replaced by `ctx.getWebSockets()`)

---

#### Phase 2 Full Design (reference architecture)

The sections below describe the full Phase 2 architecture as originally designed. **Note:** The SessionDO and Agent Server sections describe the Slice 4 double-WebSocket pattern. For the current implementation (Slice 7 — Hibernation API + HTTP commands + ephemeral event WS), see Slice 7 above. The remaining unimplemented work includes: steer, ProjectDO schema cleanup, and production polish.

#### Agent Server (`packages/agent-server/`)

Workspace module `@zero/agent-server` — gets linting, typecheck, shared tsconfig from the monorepo. Build in monorepo via turbo, Dockerfile copies the built `dist/` and installs production npm deps independently.

```
packages/agent-server/
├── package.json        — @mariozechner/pi-coding-agent, @mariozechner/pi-ai
├── tsconfig.json
├── Dockerfile          — copies built dist/, npm install --production
└── src/
    ├── index.ts        — Entry: start HTTP server on $PORT (default 8080)
    ├── server.ts       — HTTP router + request handlers (plain Node.js http) + WebSocket upgrade
    ├── session.ts      — Pi SDK wrapper (create, prompt, followUp, steer, abort)
    ├── events.ts       — EventBuffer: in-memory store + SSE serialization + WebSocket broadcast
    └── types.ts        — Request/response shapes
```

**`session.ts`** — wraps pi SDK lifecycle:
- `startSession(config)` → clone repo, `createAgentSession()`, `session.prompt()`
- `sendMessage(text)` → `session.followUp(text)`
- `steerSession(text)` → `session.steer(text)`
- `stopSession()` → `session.abort()` (clean, emits `agent_end`)
- `subscribe(callback)` → event listener
- `getStatus()` → current lifecycle state

**`events.ts`** — `EventBuffer` class:
- Stores all events in an array with monotonic `seq` numbers
- Full session retention (not a sliding window — need complete history for reconnect)
- `createSSEStream(afterSeq?)` → `ReadableStream` in SSE format (kept for debugging/curl)
- `registerWebSocket(ws, afterSeq?)` → replays buffered events from `afterSeq`, then live-pushes new events
- `unregisterWebSocket(ws)` → removes from broadcast list
- Supports multiple concurrent clients (SSE and WebSocket, each with independent tracking)

**Key behaviors:**
- Auto-stop on `/start`: if session already running, abort first, then start new
- Named SSE events: `event: agent\ndata: {...}\n\n` and `event: status\ndata: {...}\n\n`
- WebSocket messages: `{ seq, event }` JSON envelopes (same payload as SSE data fields)
- WebSocket inbound commands: `{ type: "message", text }`, `{ type: "stop" }`, `{ type: "steer", text }` — dispatched to same handlers as REST endpoints

**Container HTTP API (⚠️ superseded — see Agent Server HTTP API section above for current endpoints):**
```
POST /start     { repoUrl, token, prompt, credentials, provider, model }
POST /message   { text }
POST /steer     { text }
POST /stop
GET  /events    — SSE stream (kept for debugging/curl; not used by SessionDO)
GET  /ws        — WebSocket upgrade. Streams events as JSON messages. Accepts commands.
                  Query: ?after=N to replay from seq N.
                  Inbound messages: { type: "message", text }, { type: "stop" }, { type: "steer", text }
                  Outbound messages: { seq, event } envelopes (same shape as SSE data payloads)
GET  /status    — Current session state JSON
```

The `/ws` endpoint is the primary interface for SessionDO. It replaces the SSE + REST proxy pattern. The container's WebSocket handler:
- On connect: replays buffered events from `?after=N` (or all if omitted)
- On inbound message: dispatches to the same handlers as POST /message, /stop, /steer
- On agent events: sends `{ seq, event }` envelopes to all connected WebSocket clients

**Dockerfile:**
```dockerfile
FROM node:22-bookworm
RUN apt-get update && apt-get install -y git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY dist/ ./dist/
CMD ["node", "dist/index.js"]
```

> **Image size note:** 1.37GB baseline from spike. Production optimization deferred.

#### SessionDO (Double WebSocket Hub) — ⚠️ Superseded by Slice 7

> **Note:** This section describes the Slice 4 double-WebSocket design. The current implementation uses the Hibernation API + HTTP commands + ephemeral event WS (see Slice 7). Kept for historical reference.

SessionDO is the **real-time hub**: it accepts browser WebSocket connections, maintains a WebSocket to the container, persists events to its own local SQLite, and broadcasts to connected browsers. This replaces the SSE-proxy-through-Worker approach from the spike.

**Why WebSocket SessionDO instead of SSE proxy:**
- Persistence is local — SessionDO receives events via container WebSocket and writes to its own SQLite (no RPC, no cross-DO calls for persistence)
- Multi-tab works naturally — broadcast to all connected browser WebSockets from one container WebSocket connection
- No Worker lifetime concerns — DO stays awake while container WebSocket is active, no streaming-through-Worker time limits
- Bidirectional — commands (message, stop, steer) and events flow over the same container WebSocket, no separate REST proxying needed

**Why NOT hibernation API (Slice 4 reasoning — reversed in Slice 7):** The DO must stay alive while the container WebSocket is active. Fire-and-forget promises (reading container WS messages) are killed by hibernation. Standard `server.accept()` keeps the DO alive as long as WebSocket connections exist. **Update:** Slice 7 decoupled commands (HTTP POST) from events (ephemeral WS), making Hibernation API safe — the DO only needs to be awake when processing a browser message or receiving container events.

**Schema — two tables:**

```sql
session_meta (single row per DO):
  status         TEXT NOT NULL    -- SessionStatus enum
  projectOwner   TEXT NOT NULL
  projectRepo    TEXT NOT NULL
  provider       TEXT NOT NULL
  model          TEXT NOT NULL
  userDOId       TEXT             -- UserDO ID for status sync + credential resolution on resume
  createdAt      TEXT NOT NULL
  -- Note: containerName was removed; derived from DO ID as 'session-{ctx.id}'
  -- Note: title is stored in UserDO sessions table, not here

session_events (append-only log — source of truth for chat history):
  id             INTEGER PRIMARY KEY AUTOINCREMENT
  seq            INTEGER NOT NULL UNIQUE   -- monotonic, for dedup + resume
  containerSeq   INTEGER                   -- container's original seq (for reconnection)
  source         TEXT NOT NULL             -- 'user' | 'agent'
  eventType      TEXT NOT NULL             -- agent: 'message_update', etc. / user: 'message'
  data           TEXT NOT NULL             -- raw JSON payload
  createdAt      TEXT NOT NULL
```

The event log is the **single source of truth** for chat history. No separate messages table — the frontend reconstructs the chat view from events using the same processing pipeline for both stored history and live streaming.

**RPC methods:**
- `initSession(meta)` — create metadata row
- `getSession()` → metadata
- `getStatus()` → status string (lightweight, for fan-out queries)
- `getEvents(afterSeq?)` → events, optionally after a sequence number for resume
- `appendEvents(events[])` → batch insert (ignore duplicates by seq)
- `updateStatus(status)` → validated state machine transitions + `updatedAt`
- `deleteSession()` → cascade delete both tables

**State machine:**
```
pending → starting → running → idle → running (follow-up)
                                     → completed
                   → failed
running → completed (abort)
        → failed
```

**WebSocket handler (standard accept, NOT hibernation API):**

`fetch()` — accept WebSocket upgrade via `server.accept()` (standard, not `this.ctx.acceptWebSocket()`). On connect: send all stored events from SQLite as individual messages, then send current status, then `caught_up` marker. If session is active (pending/starting/running/idle), open WebSocket to container via `ensureContainerWebSocket()`.

`handleWebSocketMessage(ws, message)` — handle commands from browser (wired via `server.addEventListener`):
- `{ type: "message", text }` → persist user event to SQLite, broadcast to all browser WSs, ensure container WS connected, forward via `sendToContainer()`
- `{ type: "stop" }` → forward via container WebSocket
- `{ type: "steer", text }` → forward via container WebSocket
- `{ type: "ping" }` → respond with `{ type: "pong" }`

Browser WS close/error — remove from `this.sockets` array.

**Container WebSocket connection (runs while session is active):**
SessionDO opens a WebSocket to the container via `getContainer(env.AGENT_CONTAINER, containerName).fetch(switchPort(req, 8080))` with `Upgrade: websocket` header. The `switchPort` helper from `@cloudflare/containers` sets the target port via a header — required because `containerFetch()` (RPC path) can't pass WebSockets (workerd issue #2319), but the HTTP `fetch()` path can. For each received message: parse the `{ seq, event, timestamp }` envelope, persist to SQLite via `appendEvents()`, update status if status event, broadcast to all connected browser WebSockets. Commands from the browser (message, stop, steer) are forwarded to the container over the same WebSocket. When the container WebSocket closes, the reference is cleared so the next interaction triggers a fresh connection.

**Why WebSocket and not SSE to the container:**
SSE streaming from a container into a DO does not work — `getContainer().fetch()` response bodies are fully buffered inside Durable Objects. `reader.read()` blocks forever on a long-lived SSE stream. This is a known platform limitation. WebSocket connections via `getContainer().fetch(switchPort(req, port))` with Upgrade header work correctly and deliver messages in real-time.

**Lifecycle:**
```
1. Session created (via REST) → SessionDO initialized, status=pending, no WebSocket yet
2. Browser navigates to session page → WebSocket upgrade → SessionDO accepts
3. SessionDO sends stored events (catch-up) + status + caught_up marker
4. If session active: SessionDO opens WebSocket to container via getContainer().fetch(switchPort())
5. Events flow: Container → container WS → SessionDO (persist + broadcast) → browser WS
6. User sends message via browser WS → SessionDO persists → forwards via container WS
7. Agent finishes (agent_end) → status=idle, user can send follow-up
8. User sends follow-up → ensureContainerWebSocket() reconnects if needed → forwards message
9. User closes page → browser WS closes → DO stays alive if container WS open
```

**WebSocket protocol:**

Client → Server (browser → SessionDO):
```json
{ "type": "message", "text": "fix the tests" }
{ "type": "stop" }
{ "type": "steer", "text": "focus on the auth module" }
```

Server → Client (SessionDO → browser):
```json
{ "type": "event", "seq": 1, "source": "agent", "eventType": "message_update", "data": {"type":"text_delta","delta":"Hello"} }
{ "type": "event", "seq": 15, "source": "user", "eventType": "message", "data": {"text":"fix the tests"} }
{ "type": "status", "status": "idle" }
{ "type": "caught_up", "lastSeq": 42 }
```

On WebSocket connect: SessionDO sends all stored events as individual `event` messages, then a `caught_up` marker. If session is active, live events follow immediately. The browser doesn't distinguish stored from live — it processes them identically.

#### ProjectDO Session Index (Schema Change)

Remove `status` and `updatedAt` from the `session_index` table. The index is **immutable** — written once on session creation, never updated. New migration required.

```sql
session_index:
  sessionDOId  TEXT NOT NULL
  title        TEXT NOT NULL
  provider     TEXT NOT NULL
  model        TEXT NOT NULL
  createdAt    TEXT NOT NULL
```

When listing sessions, the route handler:
1. `projectDO.listSessions()` → immutable index entries
2. Fan-out: parallel `sessionDO.getStatus()` for each session
3. Return combined list with current status

#### Container Setup

- Add `@cloudflare/containers` to `zero/api/package.json`
- `zero/api/src/AgentContainer.ts` — re-export the `Container` class
- Container name per session: `session-${sessionDOId}` (one container per session, auto-sleeps after idle)
- Update `wrangler.jsonc`:

```jsonc
"containers": [{
  "class_name": "AgentContainer",
  "image": "../agent-server/Dockerfile",
  "max_instances": 1,
  "instance_type": "basic"
}],
"durable_objects": {
  "bindings": [
    // ... existing UserDO, ProjectDO
    { "name": "SESSION_DO", "class_name": "SessionDO" },
    { "name": "AGENT_CONTAINER", "class_name": "AgentContainer" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["UserDO", "ProjectDO"] },
  { "tag": "v2", "new_sqlite_classes": ["SessionDO", "AgentContainer"] }
]
```

#### Session Routes

REST for CRUD, WebSocket for real-time interaction:

```
POST   /api/projects/:owner/:repo/sessions           — Create + start
GET    /api/projects/:owner/:repo/sessions           — List (ProjectDO index + status fan-out)
GET    /api/projects/:owner/:repo/sessions/:id       — Detail (metadata + stored events)
GET    /api/projects/:owner/:repo/sessions/:id/ws    — WebSocket upgrade → SessionDO
DELETE /api/projects/:owner/:repo/sessions/:id       — Delete
```

Message, stop, and steer go through WebSocket — no REST endpoints needed. The REST detail endpoint serves the initial page load (metadata + events for rendering before WebSocket connects).

**Auth for WebSocket:** Clerk session token passed as query parameter (`?token=...`), validated by Worker before upgrading to SessionDO. Browsers cannot set custom headers on WebSocket connections.

**Authorization:** resolve `owner/repo` → ProjectDO from `doRefs`, verify session exists in ProjectDO's session index.

#### SessionService

Orchestrates across DOs + container:

- **createSession** — resolve provider/model (request body → project default → first connected provider), fetch credentials from UserDO, fetch GitHub installation token, create SessionDO (`newUniqueId()`), init metadata (status: pending), add to ProjectDO index (immutable), start container via `getContainer(env.AGENT_CONTAINER, containerName).fetch("/start", ...)`, update status → starting. Return session ID.
- **listSessions** — `projectDO.listSessions()` + parallel `sessionDO.getStatus()` fan-out
- **getSession** — `sessionDO.getSession()` + `sessionDO.getEvents()`
- **deleteSession** — remove from SessionDO + ProjectDO index

#### Session Creation Flow

```
User on /projects/:owner/:repo clicks "New Session"
  → Dialog: prompt textarea + provider/model dropdowns (default from project settings)
  → POST /api/projects/:owner/:repo/sessions { prompt, provider?, model? }

Route handler:
  1. Resolve owner/repo → ProjectDO from doRefs (404 if not found)
  2. Resolve provider/model: request body → project default → first connected provider
  3. Fetch credentials from UserDO for chosen provider
  4. Fetch GitHub installation token for the repo
  5. Create SessionDO with newUniqueId()
  6. Init SessionDO: status='pending', containerName='session-${doId}'
  7. Add to ProjectDO session index (immutable: title, provider, model, createdAt)
  8. getContainer(env.AGENT_CONTAINER, containerName)
       .fetch("/start", { repoUrl, token, prompt, credentials, provider, model })
  9. SessionDO.updateStatus → 'starting'
  10. Return { sessionId }

  → Frontend navigates to /projects/:owner/:repo/sessions/:id
  → Opens WebSocket, receives stored events + live stream
```

#### Frontend

**New pages:**
- `ProjectDetailPage` at `/projects/:owner/:repo` — session list with status badges, "New Session" button
- `SessionPage` at `/projects/:owner/:repo/sessions/:id` — full chat interface

**New components:**

| Component | Description |
|---|---|
| **SessionChat** | Scrollable message list + prompt input + abort button |
| **SessionMessage** | Renders one assistant turn: collapsible thinking block, markdown text, tool calls with args + results |
| **SessionStatusBadge** | Colored badge for each lifecycle state (pending/starting/running/idle/completed/failed) |
| **NewSessionDialog** | Prompt textarea + provider/model dropdowns + start button |
| **SessionList** | Table of sessions with status badge, title, provider, timestamps |

**Key hook — `useSession(owner, repo, sessionId)`:**
1. On mount: `GET /api/projects/:owner/:repo/sessions/:id` → metadata + stored events
2. Process stored events into `MessageBlock[]` via `processEvents()`
3. Open WebSocket to `/api/projects/:owner/:repo/sessions/:id/ws?token=...`
4. On `caught_up` message: transition from "loading history" to "live"
5. Live events processed by the same `processEvents()` pipeline — one code path
6. Returns `{ messages, status, sendMessage(text), stop(), steer(text) }`

**Single event processing pipeline** — shared for stored events (REST fetch on mount) and live events (WebSocket). Processes events into `MessageBlock` objects for rendering:
```
message_start       → new AssistantMessage block
message_update      → append delta to current block:
                        text_delta → text, thinking_delta → thinking, toolcall_delta → toolCalls
message_end         → finalize block
tool_execution_*    → tool result block
agent_end           → set status = idle
user message event  → UserMessage block
```

**Router additions:**
```tsx
{ path: "projects/:owner/:repo", element: <ProjectDetailPage /> }
{ path: "projects/:owner/:repo/sessions/:id", element: <SessionPage /> }
```

#### Implementation Order

Each step is testable before moving to the next:

1. Agent server + Dockerfile — build + `docker run` + test with curl
2. SessionDO — schema + migration + DO class (RPC methods, no WebSocket yet)
3. AgentContainer + wrangler config — wire up container binding
4. ProjectDO schema migration — remove `status`/`updatedAt` from session index
5. Session routes + service — create, list, detail, delete (test with curl)
6. SessionDO WebSocket handler — container WebSocket via getContainer+switchPort, persist, broadcast
7. ProjectDetailPage + session list — show sessions for a project
8. SessionPage + `useSession` hook — chat UI with WebSocket + event processing
9. New session creation flow — dialog + POST + navigate
10. Lifecycle polish — abort, follow-up, reconnection, hibernation

### Phase 3 — Inbox + Notifications

16. InboxDO: store notifications
17. RealtimeDO: push notifications to frontend (WebSocket — hibernation API)
18. Inbox feed UI (global + per-project)
19. Async LLM action generation (Anthropic API via Queue)
20. Action buttons on notification cards + session creation from notification actions

### Phase 4 — Polish

21. Keyboard shortcuts
22. Notification filters and preferences
23. Session history and logs
24. Dark mode (already built into shadcn theme)
25. Deploy pipeline (Doppler projects already created, `bin/ci` already updated)

---

---

## Dogfooding Goal

**Goal:** Deploy Zero to production, then use Zero to develop Zero.

The virtuous cycle:
```
zero.juanibiapina.dev → open Zero repo → start session → describe task
→ agent makes changes → pushes branch → creates PR
→ merge PR on GitHub → Actions deploys to production
→ new feature is live → repeat
```

This constrains scope ruthlessly: the only features that must exist before dogfooding are the ones required for this exact loop. Everything else gets built *using Zero*, which immediately surfaces what actually matters.

**Minimum viable loop requires exactly two things beyond what's already built:**
1. Deployment to `zero.juanibiapina.dev` (configuration, no new code)
2. Git push credentials + `create_pull_request` tool in the container (~80 lines of code)

---

## MVP Slice A — Deployment to `zero.juanibiapina.dev`

**Status: Complete ✅ — live in production**

No new application code. Pure infrastructure configuration.

### What was done

**KV namespace** — created via CLI (not dashboard):
```bash
cd zero/api && pnpm exec wrangler kv namespace create zero-kv
# → id: c585ffa89cbb45448d2480491434b2ee
```

**`zero/api/wrangler.jsonc`** — two changes:
- Real KV namespace ID replacing placeholder
- Custom domain route:
```jsonc
"routes": [
  { "pattern": "zero.juanibiapina.dev/*", "zone_name": "juanibiapina.dev" }
]
```

**Deploy** — run manually from the repo root:
```bash
pnpm --filter @zero/web run build   # bakes VITE_CLERK_PUBLISHABLE_KEY into bundle
cd zero/api && pnpm exec wrangler deploy
```

Deployment is via `wrangler deploy` run locally (or Cloudflare's GitHub integration once configured). No CI deploy job — not needed.

**Secrets** — two separate steps:
1. `bin/sync-secrets-to-cloudflare` pushes Doppler `zero-api` prd secrets to the live Worker
2. Production Clerk keys (`pk_live_...` / `sk_live_...`) are different from dev (`pk_test_...`). Set in Doppler `zero-api` prd + `zero-web` prd, then re-fetch + rebuild + redeploy so the frontend bundle includes the prod publishable key.

**GitHub App settings** (manual, in GitHub App dashboard):
- **Webhook URL:** `https://zero.juanibiapina.dev/api/webhooks/github`
- **Setup URL (post-install callback):** `https://zero.juanibiapina.dev/github/setup` — GitHub redirects here with `?installation_id=...` after a user installs the app; `GitHubSetupPage` picks it up and calls `POST /api/auth/github/callback`. If GitHub doesn't redirect (app already installed), the user can manually paste the installation ID on the Projects page.
- **Permissions:** Repository contents: Read, Repository metadata: Read, Pull requests: Write (for Slice B)
- **Subscribe to events:** Installation

### Findings

**Workers Paid plan required for Containers.** `wrangler deploy` succeeds for the Worker itself on the free plan, but the container image push to `registry.cloudflare.com` fails with: _"Deploying containers requires the Workers Paid plan."_ The paid plan ($5/month) must be active before the first deploy that includes a container.

**DNS was already on Cloudflare** — `juanibiapina.dev` nameservers had been pointed at Cloudflare previously, so no Namecheap changes were needed. The `zone_name: juanibiapina.dev` in `wrangler.jsonc` just worked.

**GitHub App slug matters.** The install URL (`https://github.com/apps/{slug}/installations/new`) is hardcoded in `zero/api/src/routes/projects.ts`. When the app was renamed from `zerocool-app` to `zerocoding-app`, that string needed updating.

**Frontend must be rebuilt for prod Clerk key.** `VITE_CLERK_PUBLISHABLE_KEY` is a build-time variable baked into `zero/web/dist`. Changing it in Doppler is not enough — `pnpm --filter @zero/web run build` must be re-run (with the prod `.env.production` in place) before `wrangler deploy` to push the updated bundle.

---

## MVP Slice B — Git Push Credentials + PR Creation

**Status: Planned**

Enables the full dogfooding loop: agent makes changes, pushes a branch, creates a PR.

### Problem

The container clones the repo with the GitHub installation token embedded in the URL (HTTPS with token). After clone, git drops the credential — subsequent `git push` calls fail with authentication errors.

### Solution

After cloning, persist the token as a git credential and configure git identity. Add a `create_pull_request` tool so the agent can open PRs via the GitHub API.

### Changes to `zero/agent-server/src/server.ts`

In the `/start` handler, after `session.start()` returns (i.e., after clone):

```typescript
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";

// Configure git identity (required for commits)
execSync(`git -C ${workDir} config user.name "Zero Agent"`);
execSync(`git -C ${workDir} config user.email "zero@noreply.github.com"`);

// Persist token for push authentication
execSync(`git config --global credential.helper store`);
writeFileSync(
  `${homedir()}/.git-credentials`,
  `https://x-access-token:${token}@github.com\n`
);
```

### New Tool: `create_pull_request`

New file `zero/agent-server/src/tools.ts` — custom tools registered alongside `codingTools`:

```typescript
export function createGitHubTools(owner: string, repo: string, token: string) {
  return [
    {
      name: "create_pull_request",
      description: "Create a GitHub pull request from the current branch to the base branch. Call this after pushing your changes.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "PR title" },
          body:  { type: "string", description: "PR description in markdown" },
          base:  { type: "string", description: "Base branch to merge into (default: main)" },
        },
        required: ["title", "body"],
      },
      execute: async ({ title, body, base = "main" }: { title: string; body: string; base?: string }) => {
        const branch = execSync("git branch --show-current", { cwd: `/workspace/repo` })
          .toString().trim();
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Zero-App",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title, body, head: branch, base }),
        });
        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`Failed to create PR: ${resp.status} ${err}`);
        }
        const pr = (await resp.json()) as { html_url: string; number: number };
        return `Pull request #${pr.number} created: ${pr.html_url}`;
      },
    },
  ];
}
```

In `server.ts`, pass `owner`, `repo`, `token` into the session and combine tools:
```typescript
const tools = [...codingTools, ...createGitHubTools(owner, repo, token)];
```

Pass `owner`, `repo`, `token` through `session.start()` into the tool construction.

### Agent Workflow (entirely agent-driven)

The agent can now do the full PR flow without any UI buttons:
```
→ git checkout -b feature/my-change
→ edit files
→ git add -A && git commit -m "Add feature"
→ git push origin feature/my-change
→ create_pull_request({ title: "Add feature", body: "...", base: "main" })
→ Returns: "Pull request #42 created: https://github.com/..."
```

### Files Changed
- `zero/agent-server/src/tools.ts` — new file: `createGitHubTools()`
- `zero/agent-server/src/server.ts` — git identity + credential config; combine tools
- `zero/agent-server/src/session.ts` — accept `owner`, `repo`, `token` for tool construction

---

## Feature Backlog

Features to be built after the dogfooding MVP is live. Ordered by priority, but can be resequenced based on what the dogfooding experience surfaces.

---

### Feature: Secret Manager (User-Level) ✅

**Status: Complete.**

Users can add named secrets (environment variables) that are injected into every agent session.

**Storage:** New `user_secrets` table in UserDO (name, value, createdAt, updatedAt). Values stored plaintext in DO's SQLite (Cloudflare encrypts DO storage at rest — same protection as OAuth tokens and API keys). Values are never returned via the API: GET endpoints return names + metadata only.

**Injection:** `SessionService.createSession()` calls `userDO.listUserSecretsWithValues()`, builds a `Record<string, string>` map, and passes it in the `POST /start` body alongside `provider`, `model`, `apiKey`. The agent-server's `/start` handler sets each entry as `process.env[name] = value` before calling `session.start()`. `process.env` mutations persist for the container's lifetime (one session per container), so the agent sees them in all shell commands and tools.

**Routes:**
```
GET    /api/secrets          — List { name, createdAt }[] — values never returned
POST   /api/secrets          — Create/update { name, value }
DELETE /api/secrets/:name    — Delete
```

**UI:** `/secrets` top-level page (sidebar link, alongside Projects). Shows names + creation dates, write-only value input, delete per row. No name validation enforced.

**Security:** Values visible to all code running in the container (expected — same as a local `.env` file). Masking in event logs deferred (unreliable and complex).

**Files changed:**
- `zero/api/src/UserDO/db/schema.ts` — `user_secrets` table
- `zero/api/src/UserDO/index.ts` — `listUserSecrets()`, `listUserSecretsWithValues()`, `upsertUserSecret()`, `deleteUserSecret()`
- `zero/api/src/routes/secrets.ts` — new CRUD routes
- `zero/api/src/app.ts` — mount `createSecretsRoutes()`
- `zero/api/src/services/session.ts` — fetch + pass secrets to container
- `zero/agent-server/src/types.ts` — `secrets?: Record<string, string>` in `StartRequest`
- `zero/agent-server/src/server.ts` — `process.env[name] = value` injection
- `zero/core/src/index.ts` — `SecretEntry` type
- `zero/web/src/pages/SecretsPage.tsx` — new page
- `zero/web/src/main.tsx` — `/secrets` route
- `zero/web/src/components/Sidebar.tsx` — "Secrets" nav link

---

### Feature: Hide Archived Repos

**Scope:** Tiny. One filter in `zero/api/src/services/github.ts`.

GitHub API returns `archived: boolean` on each repo object. Currently the field isn't typed or used. Fix: add `archived: boolean` to the return type of `listInstallationRepos()`, filter `archived === false` before returning. Archived repos disappear from the project list immediately.

---

### Feature: Repository List Caching

**Scope:** Small. New table in UserDO + stale-while-revalidate strategy.

Currently `GET /api/projects` hits the GitHub API on every request. With paginated repos, this is 1–3 network calls per page load.

**Strategy: stale-while-revalidate**

New table in `UserDO`:
```sql
repo_cache:
  data      TEXT NOT NULL   — full JSON blob (array of ProjectSummary)
  cachedAt  TEXT NOT NULL   — ISO timestamp
```

`GET /api/projects` logic:
1. Read cache from UserDO — if age < 5 min, return immediately (fast path, ~1 DO call)
2. If stale (≥ 5 min): return stale data immediately, fire background refresh via `ctx.waitUntil()`
3. If empty: fetch GitHub API synchronously, write cache, return
4. Background refresh: fetch GitHub API, write new cache (browser gets fresh data on next load)

Manual override: `POST /api/projects/refresh` invalidates the cache (for a UI "Refresh" button).

**Also handles:** New repos installed via GitHub App are picked up on next cache refresh (or immediately after `POST /api/projects/refresh`).

---

### Feature: Container Workspace Caching (No Re-Clone)

**Scope:** Medium. New caching layer in agent-server.

Currently every new session clones the repo from scratch — even for the same repo. For large repos this wastes 30–60 seconds on every session start.

**Strategy: clone once, reset between sessions**

The container persists its filesystem between sessions (as long as it stays alive / doesn't restart). Cache the clone at a stable path, e.g. `/workspace/repos/{owner}/{repo}`. On session start:

```typescript
const cacheDir = `/workspace/repos/${owner}/${repo}`;

if (existsSync(cacheDir)) {
  // Repo already cloned — reset to clean state
  execSync(`git -C ${cacheDir} fetch --depth=1 origin`, { timeout: 30_000 });
  execSync(`git -C ${cacheDir} reset --hard origin/${defaultBranch}`, { cwd: cacheDir });
  execSync(`git -C ${cacheDir} clean -fd`, { cwd: cacheDir });
  console.log("Using cached repo, reset to latest.");
} else {
  // Fresh clone
  mkdirSync(cacheDir, { recursive: true });
  execSync(`git clone --depth 1 ${authedUrl} ${cacheDir}`, { timeout: 120_000 });
  console.log("Fresh clone complete.");
}

process.chdir(cacheDir);
```

**Caveat:** The GitHub token embedded in the URL expires (installation tokens last 1 hour). Need to update the remote URL with a fresh token on each session start regardless of cache:
```typescript
execSync(`git -C ${cacheDir} remote set-url origin ${authedUrl}`);
```

**Result:** Session start goes from ~30–60s (clone) to ~3–5s (fetch + reset) for warm containers.

---

### Feature: npm install Caching in Container

**Scope:** Small. Companion to workspace caching.

Currently if the repo has a `package.json`, the agent might run `npm install` as part of its work — or the coding tools may invoke it. Each install from scratch is slow.

**Strategy:** Mount or pre-populate an npm cache directory.

In the container, set `npm_config_cache` to a stable path that persists across sessions:
```typescript
process.env.npm_config_cache = "/workspace/npm-cache";
```

Set in `server.ts` before any npm operations. The npm cache at `/workspace/npm-cache` accumulates across sessions (as long as the container doesn't restart), dramatically speeding up repeated `npm install` calls for the same repo.

For `pnpm` workspaces, same approach: `PNPM_HOME=/workspace/pnpm-store` persists the content-addressable store.

**Also useful:** Pre-run `npm install` / `pnpm install` as part of the workspace cache reset step, so the agent inherits a ready-to-use `node_modules`.

---

### Feature: Container Sharing Strategy (Per-Session vs Per-Project vs Per-User)

**Scope:** Architecture decision — changes container naming strategy. Medium effort if pursued.

The current design uses **one container per session** (`containerName = 'session-{sessionDOId}'`). Two alternative strategies were considered:

#### Option A: One container per user

All of a user's sessions across all projects share a single container.

**Pros:** Maximum container reuse, one warm instance per user.

**Cons:**
- A user works across multiple repos — the container would need to context-switch between repos on every session start (re-clone or maintain multiple clones), which is complex.
- Sessions from different projects interleave with no natural isolation boundary.
- Container lifetime becomes hard to reason about (when does it sleep?).

**Verdict: Rejected.** Too much complexity for unclear benefit.

#### Option B: One container per project ✅ (recommended)

All sessions within the same project (`owner/repo`) share a container. `containerName = 'project-{projectDOId}'`.

**Pros:**
- Second session in the same project starts fast: container is already warm (or wakes from sleep quickly), repo is already cloned. Startup drops from ~60s (cold clone) to ~3–5s (`git fetch + reset`).
- Naturally implements the "Container Workspace Caching" and "npm install Caching" features above — they become free by-products of this strategy.
- One agent working in a repo at a time is a natural, sensible constraint.

**Cons:**
- Only one pi session can be active per project at a time. Starting a new session auto-stops the previous one (agent-server already handles this via auto-stop on `POST /start`).
- Multiple SessionDOs point at the same container. The old SessionDO's container WebSocket must be closed when a new session starts (the new session's `POST /start` resets the agent-server's EventBuffer, so the old WebSocket would start seeing new-session events if not disconnected).

**What changes (if implemented):**

1. **Container naming** — trivial change in `SessionService.createSession()`:
   ```diff
   - containerName: `session-${sessionDOId}`
   + containerName: `project-${projectDOId}`
   ```
   Stored in `session_meta` and used by SessionDO for `getContainer()` lookups — no other structural change.

2. **EventBuffer reset on `POST /start`** — agent-server already auto-stops a running session before starting a new one. Add a buffer clear so the new SessionDO connects with `?after=0` and only sees its own events.

3. **Old SessionDO WebSocket cleanup** — when `POST /start` is called for a new session, the container should signal connected WebSocket clients to disconnect. Simplest: agent-server sends a `{ type: "session_replaced" }` message to all connected WebSocket clients on `/start`, and SessionDO closes its container WebSocket upon receiving it.

4. **UI hint** — surface "A session is already running in this project" when the user starts a new session. The new session still starts (the old one is auto-stopped), but the user should know.

**Relationship to workspace caching features:** If per-project containers are adopted, the separate "Container Workspace Caching" and "npm install Caching" backlog features are subsumed — the workspace is implicitly cached because it's the same container. The only extra work is the `git fetch + reset` logic on `POST /start` instead of a fresh clone.

#### Current design: One container per session (status quo)

Simple, fully isolated, no shared state between sessions. Cold start on every session. The workspace caching features are additive improvements (same container, better reuse within that container). Concurrent sessions across projects work naturally.

**Relationship between options:** Per-session is the safe default. Per-project is an optimization that trades isolation for speed. The container naming is the only structural difference — everything else (SessionDO WebSocket hub, event persistence, keepalive logic) works identically under both strategies.

---

### Feature: Session Hibernation and Resume (R2 Snapshots + State Restore)

**Scope:** Medium-Large. New R2 binding + agent-server `/resume` endpoint + SessionDO resume orchestration + conversation history extraction. Subsumes the "Container Workspace Caching" and "npm install Caching" features above — if the entire workspace state is persisted per session, those become free.

**Problem:** Two things break when a container sleeps and wakes:

1. **Filesystem is gone.** CF Container filesystems are ephemeral. The cloned repo, installed dependencies, build artifacts, and any uncommitted agent work are wiped. Session restart pays the full cost: clone (~30–60s) + dependency install (~30–120s).
2. **Agent state is gone.** The agent-server's `SessionWrapper._messages` (conversation history used for follow-up context) lives only in memory. After wake, the container has no session — any follow-up message sent by the user will fail because `_model`, `_workDir`, and `_messages` are all null.

**Goal:** Make sessions fully resumable across container sleep/wake cycles. When a user returns to an idle session whose container has slept, the session should restore transparently — workspace from R2, conversation history from SessionDO — and be ready for follow-ups in seconds.

#### Two components of session state

| Component | Where it lives today | Lost on sleep? | Restore from |
|---|---|---|---|
| **Workspace** (git repo, node_modules, builds, uncommitted changes) | Container filesystem | ✅ Yes | R2 snapshot (per session) |
| **Conversation history** (`_messages` array — all user/assistant/toolResult messages) | Agent-server memory (`SessionWrapper._messages`) | ✅ Yes | SessionDO SQLite events (extract `agent_end.messages`) |
| **Provider/model config** (`_model`, API key) | Agent-server memory | ✅ Yes | SessionDO `session_meta` (passed in `/resume` request) |
| **Credentials** (`~/.git-credentials`, `process.env` secrets) | Container filesystem + env | ✅ Yes | Re-injected on `/resume` (same as `/start`) |
| **Agent events** (for frontend replay) | SessionDO SQLite | ❌ No — already durable | Not needed in container |

#### R2 key scheme — per session

Each session gets its own workspace snapshot. This preserves session-specific state: the branch the agent created, uncommitted changes, partial work.

```
workspace-snapshots/{sessionDOId}/snapshot.tar.zst
workspace-snapshots/{sessionDOId}/metadata.json
```

**Why per-session, not per-project:** Different sessions for the same repo may be on different branches, have different uncommitted changes, or different dependency states. Sharing a snapshot across sessions would clobber session-specific work. Per-session snapshots preserve exactly the state the agent left the workspace in.

The `metadata.json` stores:
```json
{
  "createdAt": "2026-02-21T08:00:00Z",
  "sessionDOId": "abc123...",
  "owner": "juanibiapina",
  "repo": "trippycards",
  "commitSha": "def456...",
  "branch": "fix/auth-validation",
  "sizeBytes": 157286400
}
```

#### Snapshot format

`tar` with `zstd` compression. Zstandard offers 3–5x compression at high speed (faster than gzip for both compress and decompress). The container image includes the `zstd` binary (small, ~2MB):

```bash
# Snapshot (compress)
tar -cf - -C /workspace repo | zstd -T0 -3 -o /tmp/snapshot.tar.zst

# Restore (decompress)
zstd -d /tmp/snapshot.tar.zst --stdout | tar -xf - -C /workspace
```

`-T0` uses all available cores. `-3` is the default compression level (fast, reasonable ratio).

**Typical sizes after compression:**
| Repo type | Uncompressed | Compressed |
|---|---|---|
| Small JS project | ~200MB | ~50MB |
| Medium monorepo | ~800MB | ~200MB |
| Large monorepo + node_modules | ~2GB | ~500MB |

Upload/download at ~100MB/s within Cloudflare's network → 200MB snapshot restores in ~2s.

#### Conversation history extraction from SessionDO

SessionDO stores all agent events in `session_events`. The conversation history (`_messages`) is rebuilt by collecting `messages` from every `agent_end` event:

```typescript
// In SessionDO — new method
getConversationHistory(): Message[] {
  const agentEndEvents = this.db
    .select()
    .from(sessionEventsTable)
    .where(eq(sessionEventsTable.eventType, "agent_end"))
    .orderBy(sessionEventsTable.seq)
    .all();

  const messages: Message[] = [];
  for (const row of agentEndEvents) {
    const event = JSON.parse(row.data) as { messages?: Message[] };
    if (event.messages) {
      messages.push(...event.messages);
    }
  }
  return messages;
}
```

This produces the exact same `Message[]` that `SessionWrapper._messages` would contain if the container had never slept — each `agent_end` event carries the new messages from that turn, and `_messages` is their concatenation.

#### New agent-server endpoint: `POST /resume`

A new endpoint that restores both workspace and agent state without starting a new agent loop. After resume, the session is in `"idle"` status — ready for follow-up messages.

```typescript
interface ResumeRequest {
  // Same config as /start
  provider: string;
  model: string;
  apiKey: string;
  secrets?: Record<string, string>;
  repoUrl: string;
  token: string;
  // Workspace restore
  snapshotUrl: string;     // Pre-signed R2 GET URL
  // Agent state restore
  messages: Message[];      // Conversation history from SessionDO
}
```

**Agent-server `/resume` handler:**
```
1. Inject secrets as process.env
2. Download + extract workspace snapshot from snapshotUrl
3. Update git remote URL with fresh token
4. Set API key, get model (same as /start)
5. Set _messages = request.messages   ← restores conversation context
6. Set _model, _workDir              ← restores agent config
7. chdir to workspace
8. Emit status: "idle"               ← ready for follow-ups
```

**Key difference from `/start`:** Resume does NOT clone or run a prompt. It restores state and waits. No `git fetch + reset` — the workspace is restored exactly as the agent left it (preserving branches, uncommitted changes, staged files).

**`SessionWrapper` changes:**

```typescript
async resume(
  provider: string,
  modelId: string,
  apiKey: string,
  messages: Message[],
  snapshotUrl: string,
  repoUrl: string,
  token: string
): Promise<void> {
  // Clear any stale state
  if (this._abortController) {
    await this.stop();
  }
  this._eventBuffer.clear();
  this._error = undefined;
  this._status = "starting";
  this._eventBuffer.addEvent({ type: "status", status: this._status });

  try {
    // 1. Restore workspace from R2 snapshot
    await this.restoreWorkspace(snapshotUrl);

    // 2. Update git remote with fresh token
    const authedUrl = repoUrl.replace("https://", `https://x-access-token:${token}@`);
    execSync(`git -C ${WORKSPACE_DIR} remote set-url origin ${authedUrl}`);

    // 3. Configure model + provider (same as start)
    setApiKey(provider, apiKey);
    const model = getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);

    // 4. Restore agent state
    process.chdir(WORKSPACE_DIR);
    this._model = model;
    this._workDir = WORKSPACE_DIR;
    this._messages = messages;  // ← conversation history from SessionDO

    // 5. Ready for follow-ups
    this._status = "idle";
    this._eventBuffer.addEvent({ type: "status", status: this._status });
  } catch (err) {
    this._status = "error";
    this._error = err instanceof Error ? err.message : String(err);
    this._eventBuffer.addEvent({ type: "status", status: this._status, error: this._error });
    throw err;
  }
}
```

#### Flow: Snapshot (workspace → R2)

Triggered at two points:
1. **On session idle** — when agent finishes a turn (status → `idle`)
2. **On SIGTERM** — container receives SIGTERM before sleep; agent-server traps it and snapshots

```
SessionDO (on status=idle after a turn completes)
  → Generate R2 pre-signed upload URL (PUT, 1h expiry)
  → Call container POST /workspace/snapshot { uploadUrl }
     ↓
Agent-server:
  1. tar + zstd compress /workspace/repo → /tmp/snapshot.tar.zst
  2. Stream upload to R2 via pre-signed PUT URL
  3. Return { sizeBytes }
     ↓
SessionDO writes metadata.json to R2
```

**SIGTERM handler** (in `agent-server/src/index.ts`):
```typescript
process.on("SIGTERM", async () => {
  console.log("SIGTERM received — snapshotting workspace...");
  try {
    await snapshotWorkspace();
  } catch (err) {
    console.error("Snapshot on SIGTERM failed:", err);
  }
  process.exit(0);
});
```

The SIGTERM handler is best-effort — the container has ~30s before SIGKILL. The proactive snapshot on idle is the reliable path; SIGTERM is a safety net.

#### Flow: Resume (R2 + SessionDO → container)

Triggered when SessionDO needs to send a message to a container that has no active session (i.e., the container just woke from sleep).

**Detection:** When `ensureContainerWebSocket()` successfully connects, the container's agent-server has no session state. SessionDO can detect this because:
- The container WS was previously null (container was sleeping)
- The session's status in SessionDO is `idle` (was working before sleep)

After connecting the WS, SessionDO checks if the container needs resuming and calls `/resume` before forwarding the user's message:

```
User sends follow-up message (browser WS → SessionDO)
  → ensureContainerWebSocket() — reconnects to woken container
  → SessionDO detects: container just woke (containerWs was null + status is idle)
  → Resume sequence:
      1. Extract conversation history: getConversationHistory()
      2. Fetch credentials from session_meta (provider, model)
      3. Resolve fresh API key from UserDO
      4. Resolve fresh GitHub token
      5. Generate R2 pre-signed download URL for snapshot
      6. Call container POST /resume {
           provider, model, apiKey, secrets,
           repoUrl, token,
           snapshotUrl,
           messages: conversationHistory
         }
      7. Wait for status: "idle" event from container
      8. Forward the user's message via container WS
```

**Changes to `ensureContainerWebSocket()`:**

```typescript
private async ensureContainerWebSocket(): Promise<void> {
  if (this.containerWs) return;

  const wasReconnect = this.currentStatus === "idle"; // container was idle before WS dropped

  // ... existing retry loop to connect WS ...

  if (wasReconnect) {
    // Container just woke from sleep — resume session
    await this.resumeContainerSession();
  }
}

private async resumeContainerSession(): Promise<void> {
  const session = await this.getSession();
  if (!session) return;

  // 1. Get conversation history from stored events
  const messages = this.getConversationHistory();

  // 2. Get fresh credentials (API key may have been refreshed)
  // Requires access to UserDO — passed via env or stored in session_meta
  const apiKey = await this.getFreshApiKey(session.provider);
  const githubToken = await this.getFreshGitHubToken(session.projectOwner, session.projectRepo);

  // 3. Get workspace snapshot URL from R2
  const snapshotUrl = await this.getSnapshotDownloadUrl();
  if (!snapshotUrl) {
    // No snapshot — can't resume, need full restart
    // Fall back to /start with clone
    await this.restartContainerSession(session);
    return;
  }

  // 4. Get user secrets
  const secrets = await this.getUserSecrets();

  // 5. Call /resume on the container
  const container = getContainer(this.env.AGENT_CONTAINER, session.containerName);
  const resp = await container.fetch("http://container/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: session.provider,
      model: session.model,
      apiKey,
      secrets,
      repoUrl: `https://github.com/${session.projectOwner}/${session.projectRepo}.git`,
      token: githubToken,
      snapshotUrl,
      messages,
    }),
  });

  if (!resp.ok) {
    console.error("Container resume failed, falling back to full restart");
    await this.restartContainerSession(session);
  }
}
```

**Fallback:** If resume fails (no snapshot, corrupt snapshot, API error), fall back to a full `/start` (clone from scratch). The user's follow-up still works — just slower. Conversation history is still restored so the agent has context.

#### SessionDO access to UserDO and GitHub tokens

Resume requires fresh credentials that SessionDO doesn't currently have direct access to. Two approaches:

**Option A (recommended): Store `userDOId` in `session_meta`.**

`initSession()` receives the user's DO ID. SessionDO stores it and uses it during resume to call `userDO.getProviderCredential()`, `userDO.listUserSecretsWithValues()`, and `userDO.getGitHubInstallation()` for GitHub token generation.

New `session_meta` column:
```sql
userDOId        TEXT NOT NULL    -- for credential + installation lookups
```

**Option B: Pass everything through SessionService.**

The resume is orchestrated by a new `SessionService.resumeSession()` called from SessionDO. SessionDO emits an event to the Worker requesting resume, and the Worker resolves credentials and calls back. More complex, more indirection.

Option A is simpler — SessionDO already has access to the `Env` bindings and can resolve the UserDO stub directly.

#### Agent-server API additions

```
POST /resume    { provider, model, apiKey, secrets, repoUrl, token, snapshotUrl, messages }
  → Restore workspace from R2, restore conversation state, transition to idle
  → Returns { ok: true }

POST /workspace/snapshot  { uploadUrl: string }
  → Tar + compress /workspace/repo, stream-upload to uploadUrl
  → Returns { sizeBytes: number }
```

#### Infrastructure changes

**`wrangler.jsonc`:**
```jsonc
"r2_buckets": [
  {
    "binding": "R2",
    "bucket_name": "zero-workspace-snapshots"
  }
]
```

**`Env` type:** Add `R2: R2Bucket` to the environment bindings.

**Dockerfile:** Add `zstd` to the container image:
```dockerfile
RUN apt-get update && apt-get install -y git zstd && rm -rf /var/lib/apt/lists/*
```

#### Snapshot lifecycle and garbage collection

One snapshot per session. Overwritten on each idle transition. Deleted when the session is deleted (add R2 cleanup to the existing delete flow).

**Garbage collection for orphaned snapshots:** If a session is deleted but R2 cleanup fails, snapshots accumulate. Add an R2 lifecycle rule to auto-delete objects older than 30 days, or a periodic cleanup job.

**Explicit invalidation:** Add a "Reset workspace" button on the session page that deletes the R2 snapshot and forces a fresh clone on the next interaction.

#### Relationship to other features

- **Container Workspace Caching (No Re-Clone):** Subsumed. R2 snapshots provide the same benefit but survive container sleep.
- **npm install Caching in Container:** Subsumed. `node_modules` is included in the snapshot.
- **Per-Project Container Strategy:** Complementary but independent. Per-project containers share a container across sessions (reuse within a container lifetime). R2 snapshots persist state across sleep/wake cycles. If per-project containers are adopted, the snapshot is still per-session — the container serves one session at a time and restores from that session's snapshot.
- **Secrets:** Not affected. Re-injected on every `/resume` call.

#### Performance expectations

| Scenario | Current | With hibernation + resume |
|---|---|---|
| First session for a repo | Clone 30–60s + install 30–120s | Same (no snapshot yet) |
| Subsequent turn, container warm | 0s (already running) | 0s (same) |
| Follow-up after container slept | ❌ Broken (no session state) | Restore ~5s + resume ~1s |
| Return to old session, container slept | ❌ Broken | Restore ~5s + resume ~1s |

The critical change: "follow-up after container slept" goes from **broken** to **~6s transparent resume**.

#### User experience

The resume is invisible to the user. They see:
1. Session is idle (from their last visit)
2. They type a follow-up message and hit send
3. Brief "Setting up..." indicator (~6s while container wakes + restores)
4. Agent responds with full conversation context

The frontend doesn't need to distinguish "container warm" from "container waking" — SessionDO handles the resume internally before forwarding the message.

#### Files changed

- `zero/api/wrangler.jsonc` — R2 bucket binding
- `zero/api/src/types.ts` — `R2: R2Bucket` in `Env`
- `zero/api/src/SessionDO/db/schema.ts` — add `userDOId` to `session_meta`
- `zero/api/src/SessionDO/index.ts` — `getConversationHistory()`, `resumeContainerSession()`, `triggerSnapshot()`, updated `ensureContainerWebSocket()`
- `zero/api/src/services/session.ts` — pass `userDOId` to `initSession()`
- `zero/agent-server/src/types.ts` — `ResumeRequest` type
- `zero/agent-server/src/server.ts` — `POST /resume` and `POST /workspace/snapshot` endpoints
- `zero/agent-server/src/session.ts` — `resume()` method, `restoreWorkspace()` helper
- `zero/agent-server/src/index.ts` — SIGTERM snapshot handler
- `zero/agent-server/Dockerfile` — add `zstd`

---

### Feature: Session Storage Refactor ✅

**Status: Complete.** Sessions are indexed in UserDO with live status sync from SessionDO.

**Scope:** Medium. New migration + cross-DO wiring. Unlocks sidebar session list and real-time push.

**Problem:** Sessions were indexed in ProjectDO (per-repo). Listing running sessions globally required fan-out to all ProjectDOs — O(n projects) DO calls.

**Solution:** Add a flat `sessions` table to UserDO. Make it the single source for session listing. Status is denormalized (`currentStatus`) and kept up-to-date by SessionDO on every transition.

```sql
-- New table in UserDO
sessions:
  sessionDOId   TEXT NOT NULL UNIQUE
  owner         TEXT NOT NULL
  repo          TEXT NOT NULL
  title         TEXT NOT NULL
  provider      TEXT NOT NULL
  model         TEXT NOT NULL
  currentStatus TEXT NOT NULL    — updated by SessionDO on every transition
  createdAt     TEXT NOT NULL
  updatedAt     TEXT NOT NULL    — timestamp of last status change
```

**Query patterns (all local, zero fan-out):**
| Query | SQL |
|---|---|
| All running sessions | `SELECT * FROM sessions WHERE currentStatus IN ('running','starting') ORDER BY updatedAt DESC` |
| Per-project sessions | `SELECT * FROM sessions WHERE owner=? AND repo=? ORDER BY createdAt DESC` |
| Recent sessions (dashboard) | `SELECT * FROM sessions ORDER BY updatedAt DESC LIMIT 10` |
| Sidebar running badge | `SELECT COUNT(*) FROM sessions WHERE currentStatus='running'` |

**Status sync:** SessionDO calls `userDO.updateSessionStatus(sessionDOId, status)` on every `updateStatus()` transition. The `userDOId` is passed to SessionDO at `initSession()` time (stored in `session_meta`).

**Session creation update:** `createSession()` writes to UserDO sessions table. ProjectDO's session index can be deprecated (kept temporarily for backward compatibility, removed in a follow-up migration).

**Files:**
- `zero/api/src/UserDO/db/schema.ts` — add `sessions` table + migration
- `zero/api/src/UserDO/index.ts` — add `addSession()`, `updateSessionStatus()`, `listSessions()`, `listRunningSessions()`, `removeSession()`
- `zero/api/src/SessionDO/db/schema.ts` — add `userDOId` to `session_meta`
- `zero/api/src/SessionDO/index.ts` — call `userDO.updateSessionStatus()` in `updateStatus()`
- `zero/api/src/services/session.ts` — write to UserDO sessions on creation
- `zero/api/src/routes/sessions.ts` — list sessions from UserDO (not ProjectDO)

---

### Feature: Session Auto-Titles via Workers AI

**Scope:** Small. Companion to session storage refactor.

Currently sessions are titled `"Session {first-8-chars-of-DO-id}"` — not useful in a list.

**Strategy:** When the first user message is sent, fire a title generation request in the background using Workers AI. Fast, cheap (free on Workers free tier), no Anthropic credits used.

```typescript
// In the Worker, when the first message route is hit:
if (isFirstMessage) {
  ctx.waitUntil(generateAndSaveTitle(env, userDO, sessionDOId, messageText));
}

async function generateAndSaveTitle(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  sessionDOId: string,
  prompt: string
): Promise<void> {
  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: "Generate a short title (3–6 words) for a coding task. Return only the title, no quotes, no punctuation at the end." },
      { role: "user", content: prompt.slice(0, 500) },
    ],
    max_tokens: 20,
  });
  const title = (result as { response?: string }).response?.trim() ?? prompt.slice(0, 40);
  await userDO.updateSessionTitle(sessionDOId, title);
}
```

**Workers AI binding:** Add `AI: Ai` to `Env` type and `"ai": { "binding": "AI" }` to `wrangler.jsonc`.

The title is generated asynchronously — the session page shows the generated title once it appears (via RealtimeDO event or on next page load).

---

### Feature: Real-Time Session Status Events ✅

**Status: Complete.** Implemented via UserDO WebSocket (not a separate RealtimeDO). UserDO uses the Hibernation API and broadcasts `session_status` events to all connected browsers. Frontend uses a zustand store (`session-store.ts`) + `useUserWebSocket()` hook mounted in `Layout.tsx`.

**Scope:** Medium. WebSocket support in UserDO + global hook in frontend.

**Problem:** Session status changes (running → idle) were invisible unless watching that specific session's WebSocket. Session lists on the project page and sidebar showed stale status.

**Architecture:**
```
Browser (any page)
  ↕ persistent WebSocket  GET /api/realtime
RealtimeDO (hibernation API — survives DO restarts, no keepalive needed)
  ↑ broadcast() RPC
SessionDO (any active session) — calls on every updateStatus()
```

**RealtimeDO** uses the hibernation WebSocket API — DOs wake only when messages arrive, sleep between them. Efficient for an always-on but mostly-idle channel.

```typescript
class RealtimeDO extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string): Promise<void> {
    const data = JSON.parse(msg);
    if (data.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  }

  async webSocketClose(): Promise<void> {} // hibernation cleans up automatically

  // Called via RPC from SessionDO
  async broadcast(event: RealtimeEvent): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(JSON.stringify(event));
    }
  }
}
```

**Event types** (status changes only — full agent events are per-session via SessionDO WebSocket):
```typescript
type RealtimeEvent =
  | { type: "session_status"; sessionId: string; status: SessionStatus; owner: string; repo: string }
  | { type: "session_created"; session: SessionSummary }
  | { type: "session_deleted"; sessionId: string }
  | { type: "session_title_updated"; sessionId: string; title: string }
```

**SessionDO → RealtimeDO wiring:** `realtimeDOId` passed to `initSession()`, stored in `session_meta`. In `updateStatus()`: resolve `realtimeDO` stub and call `realtimeDO.broadcast(event)`.

**Frontend `useRealtime()` hook:**
- Connects to `GET /api/realtime` on app mount (one WebSocket for the entire app lifetime)
- Reconnects with exponential backoff on disconnect
- Exposes a React context; components subscribe to specific event types:
```typescript
useRealtimeEvent("session_status", (event) => {
  // update session list state in place — no refetch needed
});
```

**Impact on Sidebar:** Sidebar shows running sessions count (badge) and list, updated live without any polling or page navigation.

**Files:**
- `zero/api/src/RealtimeDO/index.ts` — new DO (hibernation WebSocket API)
- `zero/api/src/SessionDO/index.ts` — store `realtimeDOId`, call `broadcast()` in `updateStatus()`
- `zero/api/src/routes/realtime.ts` — WebSocket upgrade route
- `zero/api/src/services/session.ts` — pass `realtimeDOId` to `initSession()`
- `zero/api/wrangler.jsonc` — add `REALTIME_DO` binding + migration
- `zero/web/src/lib/realtime.ts` — `useRealtime()` hook + context + reconnect logic
- `zero/web/src/components/Sidebar.tsx` — subscribe to session events, show running badge

---

### Feature: Agent-Suggested Actions

**Scope:** Small-Medium. New tool in agent-server + new block type in frontend.

**Philosophy:** The agent can propose follow-up actions as structured buttons. Clicking a button sends the text as a user message — no special handling on the backend. Actions are just pre-filled prompts. The agent uses them to guide the user toward natural next steps without requiring them to think of what to type.

**Implementation:**

New tool `suggest_actions` registered in the agent's tool set alongside `codingTools`. When the agent calls it, the tool emits a special event into `EventBuffer` and returns `"ok"` — no side effects, just a signal to the frontend.

```typescript
{
  name: "suggest_actions",
  description: "Suggest follow-up actions for the user as clickable buttons. Call this at the end of a task to guide the user toward natural next steps.",
  parameters: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short button label, e.g. 'Run tests'" },
            text:  { type: "string", description: "Full message to send when clicked" },
          },
          required: ["label", "text"],
        },
      },
    },
    required: ["actions"],
  },
  execute: async ({ actions }: { actions: Array<{ label: string; text: string }> }) => {
    eventBuffer.addEvent({ type: "suggest_actions", actions });
    return "ok";
  },
}
```

**Core types:**
```typescript
interface SuggestedAction {
  label: string;
  text: string;  // sent verbatim as user message when clicked
}

// New ContentBlock variant in session-types.ts:
interface SuggestionsBlock {
  type: "suggestions";
  actions: SuggestedAction[];
}
```

**Frontend rendering:** `SuggestionsBlock` renders as a row of outline button chips below the agent's last message turn. Clicking a chip:
1. Sends `{ type: "message", text: action.text }` over the WebSocket
2. Clears the suggestions (they disappear when any message is sent — optimistically)

Suggestions are persisted in `session_events` and replayed on reconnect like any other event.

**Files:**
- `zero/agent-server/src/tools.ts` — `suggest_actions` tool
- `zero/agent-server/src/server.ts` — include `suggest_actions` in tool list
- `zero/core/src/index.ts` — `SuggestedAction` type
- `zero/web/src/lib/session-types.ts` — `SuggestionsBlock`
- `zero/web/src/lib/process-agent-event.ts` — handle `suggest_actions` event → `SuggestionsBlock`
- `zero/web/src/components/TurnView.tsx` — render `SuggestionsBlock`
- `zero/web/src/pages/SessionPage.tsx` — clear suggestions on any message send

---

### Feature: ProjectDO Schema Cleanup + Steer UX

**Scope:** Small. Last cleanup from Phase 2 backlog.

**ProjectDO schema:** Remove `status` and `updatedAt` from `session_index`. These columns are written once but never trusted for display (fan-out to SessionDO provides live status). Once the session storage refactor moves the index to UserDO, the `session_index` table in ProjectDO can be removed entirely.

**Steer UX:** When `status === "running"`, show a steer panel below the chat instead of the regular input:
- Label: `"Steer agent"` with subtitle `"Redirect without starting over"`
- Textarea + "Steer" button + "Stop" button
- Sends `{ type: "steer", text }` over WebSocket

**Steer implementation in agent-server:** `session.steer()` currently throws `"not yet supported"`. Implement via `_steerQueue: QueuedMessage[]` drained by `getQueuedMessages` in the `agentLoop` config. Check exact `QueuedMessage` type shape in `@mariozechner/pi-ai` source before implementing.

---

### Feature: Command Palette + Keyboard Navigation

**Scope:** Medium. Foundation for all keyboard-driven navigation.

**Philosophy:** Zero is an IDE for many projects, many agents. Navigation should feel like a power tool — fast, keyboard-first, without requiring the mouse for common actions. Two complementary interaction styles:

**1. Command Palette (`Cmd+P` / `Ctrl+P`)** — IDE-style launcher:

```
┌─────────────────────────────────────────────────────┐
│ 🔍  Search projects, sessions, actions...             │
├─────────────────────────────────────────────────────┤
│  PROJECTS                                             │
│  ◆  trippycards                                       │
│  ◆  pi-mono                                           │
│  ◆  zero                                             │
│                                                       │
│  RUNNING SESSIONS                                     │
│  ▶  Fix auth validation · trippycards  [running]      │
│  ▶  Add dark mode · zero              [idle]          │
│                                                       │
│  ACTIONS                                              │
│  +  New session                                       │
│  ⚙  Settings                                         │
└─────────────────────────────────────────────────────┘
```

Fuzzy search across all sections. Arrow keys navigate, Enter activates, Esc closes. Uses `fuse.js` for fuzzy matching.

**2. Game-style navigation (always-on keys)** — Inspired by games, not Vim. In games you don't need to type all the time, so any key press can be a navigation command. No modes, no modifiers — single key presses do things. The constraint is: shortcuts only fire when focus is NOT inside a text input.

The game model maps naturally to Zero's UI:
- `j` / `k` or arrow keys — move selection up/down in lists
- `Enter` — open selected item
- `Esc` — go back / close
- `n` — new session (contextual: only when on a project page)
- `x` — delete selected (with confirmation)
- `?` — show keybindings overlay

The list of shortcuts will grow organically as the app stabilizes. Start minimal, add as patterns become clear from actual usage.

**Implementation:**

`zero/web/src/lib/keymap.ts` — global keymap hook:
```typescript
// Ignores keypresses when focus is inside input/textarea/contenteditable
// Handles two-key sequences (e.g. 'g' + 'p') with 500ms timeout
// Exposes context for registering/unregistering handlers per-page
useKeymap({
  "cmd+p": () => openCommandPalette(),
  "ctrl+p": () => openCommandPalette(),
  "j": () => selectNext(),
  "k": () => selectPrev(),
  "Enter": () => openSelected(),
  "Escape": () => goBack(),
  "?": () => showHelp(),
});
```

`zero/web/src/components/CommandPalette.tsx` — floating modal triggered by `Cmd+P`.

The keymap is the long-term home for all navigation shortcuts. Build the infrastructure now; populate it incrementally as the app grows.

**Game UI exploration (future):** The game-style navigation idea — where most actions require no typing and the UI responds immediately to single key presses like `Q`, `F`, `E`, arrow keys — is worth exploring further once the core navigation patterns are established. Games work because the action space is constrained and visual. If Zero's UI can be designed so that at any moment the possible actions are obvious from what's on screen, single-key shortcuts become intuitive rather than something that must be memorized. Keep this philosophy in mind when designing new pages.

---

### Feature: File Browser + Diff Viewer

**Scope:** TBD. No design committed yet — keeping in mind for future.

**File browser — two possible modes:**
- **GitHub API tree** (always available): `GET /repos/:owner/:repo/git/trees/:sha?recursive=1` returns full tree. Can browse at any commit. No container required.
- **Live container filesystem** (only when session active): Shows actual working directory including uncommitted changes the agent has made. Needs a `GET /files?path=` endpoint in agent-server.

**Diff viewer:**
- `git diff HEAD` in the container shows what the agent changed — most useful during/after a session
- Could be a "Changes" tab in SessionPage alongside the chat
- Eventually: syntax-highlighted diff with `react-diff-viewer` or similar

Neither is designed in detail yet. File browser via GitHub API is simpler to build first (no container dependency, always available).

---

## Revised Implementation Order (Dogfooding-First)

| Slice | Feature | Scope | Status |
|---|---|---|---|
| **–** | Directory rename | Structural | ✅ Done |
| **A** | Deployment to `zero.juanibiapina.dev` | Config only | ✅ Done |
| **B** | Git push credentials + `create_pull_request` tool | Small | Planned |
| **C** | Secret manager (user-level secrets injected as env vars) | Small-Medium | ✅ Done |
| **8** | Session storage refactor (UserDO flat sessions + status sync) | Medium | ✅ Done |
| **10** | Sidebar session list | Small | ✅ Done |
| **11** | Real-time session status (via UserDO WebSocket) | Medium | ✅ Done |
| **7** | Hide archived repos + repo list caching | Small | Planned |
| **9** | Session auto-titles via Workers AI | Small | Planned |
| **12** | R2 workspace snapshots (Phase 3 of container resume) | Medium-Large | Planned |
| **13** | Agent-suggested actions | Small-Medium | Planned |
| **14** | ProjectDO schema cleanup + steer UX | Small | Planned |
| **15** | Command palette (`Cmd+P`) | Medium | Planned |
| **16+** | Keyboard shortcuts (incremental, game-style) | Ongoing | Planned |
| **Later** | File browser | TBD | Planned |
| **Later** | Diff viewer | TBD | Planned |
| **Later** | Phase 3: Inbox + notifications | Large | Planned |
