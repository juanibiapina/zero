# Zero — Design Document

## Goal

Zero turns a Telegram forum topic into a chat session with an agent. The
web frontend uses Telegram's [Login Widget](https://core.telegram.org/widgets/login)
to link a Clerk account to a Telegram numeric id (HMAC-verified server-side
against the bot token). From then on, every message the user sends in a
**forum topic** is routed to a per-user agent container; the container
posts a reply back into the same topic. Direct messages, channel posts,
edits, callbacks etc. are dropped — only topic messages count today.

The agent inside the container is the pi coding agent
([@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent))
talking to Anthropic **through a Cloudflare AI Gateway** (BYOK: the
Anthropic key is stored in the gateway config, so Cloudflare injects it
upstream and Anthropic bills us directly at standard per-token rates with
no markup). Pi-ai uses its built-in `cloudflare-ai-gateway` provider,
which authenticates to the gateway with
`cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>` and sends no Anthropic
key itself. The token pi sees is a **sentinel
fake** (`Z3R0-FAKE-CLOUDFLARE_API_KEY`), not the real value. Every
container request to anywhere except `zero.worker` is intercepted by the
worker's catch-all `outbound` handler, which byte-replaces registered
fakes with their real env values before forwarding. The real
`CLOUDFLARE_API_KEY` lives only in the worker; if pi exfiltrates its own
env, the leaked string is a useless sentinel. See "Secret proxying"
below.

The model is `claude-opus-4-8` with thinking level `high`.
Replies flow back through a separate on-host outbound trick — as the
agent produces each assistant message, the container POSTs to
`http://zero.worker/message-end` and the worker delivers it to Telegram
immediately. When the agent loop finishes, the container POSTs to
`http://zero.worker/agent-end` so the worker can stop the typing
indicator. The only external egress from the container is to the
Cloudflare AI Gateway (`gateway.ai.cloudflare.com`), which proxies to
Anthropic — see "Secret proxying" below. State is persisted through the
worker (see below),
not by talking to R2 directly.

All mutable state is persisted as a single compressed archive of the
container's `/workspace` tree (pi's `cwd`). On boot the entrypoint
restores `<clerkUserId>/state.tar.gz` from the `zero-agent-state` bucket
via `GET http://zero.worker/state`; on every `agent_end` and on SIGTERM
the container PUTs a fresh archive back. Sessions, notes, and any files
pi writes under `/workspace` all persist through this one path. The
worker mediates R2 via its `AGENT_STATE_BUCKET` binding. See
[`r2-mount.md`](r2-mount.md) for setup.

## Package Structure

```
zero/
├── apps/
│   ├── api/             (@zero/api)              — CF Worker: HTTP API, Telegram webhook, container orchestration
│   └── web/             (@zero/web)              — Vite + React: single Telegram-id form
├── packages/
│   ├── core/            (@zero/core)             — Reserved for future shared types (currently empty)
│   ├── agent-server/    (@zero/agent-server)     — Standalone HTTP server for agentic sessions (publishable)
│   ├── eslint-config/                            — Shared ESLint config
│   └── typescript-config/                        — Shared TypeScript config
└── docs/                                         — Design + ops docs
```

`@zero/agent-server` is structured to run anywhere Node 22+ runs — it has
no Cloudflare or Telegram coupling. The Cloudflare Container packages its
`dist/` output via `packages/agent-server/Dockerfile`. See its
[README](../packages/agent-server/README.md) for the HTTP contract.

## Tech Stack

| Layer  | Tech                                              |
|--------|---------------------------------------------------|
| Auth   | Clerk                                             |
| Frontend | React 19, Tailwind v4, shadcn/ui primitives    |
| API    | Hono + OpenAPIHono + Zod on Cloudflare Workers    |
| State  | KV (Workers KV) + UserDO (Durable Object with SQLite via [do-orm](https://github.com/juanibiapina/do-orm)) |
| Container | Cloudflare Containers (`@cloudflare/containers`, with `outboundByHost`) |
| Agent  | [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (Node 22 inside the container) |
| LLM    | Cloudflare AI Gateway → Anthropic — `claude-opus-4-8` |
| Telegram | [grammY](https://grammy.dev) (`hono` adapter) |
| Secrets | Doppler (`zero-api`, `zero-web`) — see [`secrets.md`](secrets.md) |

## Architecture

```
┌─ Frontend (Vite + React) ────────────────────────────────────────┐
│   single Telegram-id input form (Clerk-gated)                    │
└────────────────────┬─────────────────────────────────────────────┘
                     │ REST  (GET/PUT /api/telegram-id, Clerk JWT)
┌─ CF Worker (zero-api) ▼ ─────────────────────────────────────────┐
│                                                                  │
│  POST /api/webhooks/telegram  ◀──────────── Telegram update      │
│    grammY (secret-token) → 200 OK → waitUntil:                   │
│      1. drop unless message.is_topic_message                     │
│      2. KV tg:{tgId} → clerkUserId   (drop unknown)              │
│      3. KV topic:{clerkUserId}:{chat}:{thread} → sessionId       │
│         miss → POST /sessions on container, store mapping        │
│                + session:{sessionId} → { clerkUserId, chat,      │
│                                          thread } record         │
│      4. POST /sessions/{sid}/messages { text }                   │
│                                                                  │
│  AgentContainer (Container<Env>, getByName(clerkUserId))         │
│  ├─ hosts @zero/agent-server + pi-coding-agent (Node 22)         │
│  ├─ restores/saves /workspace archive via /state on zero.worker  │
│  │    sessions/, notes/, and pi's working files all persist      │
│  ├─ fetch() refreshes envVars on every call:                     │
│  │    CLOUDFLARE_API_KEY=Z3R0-FAKE-... (env-resolved)            │
│  │    GOOGLE_WORKSPACE_CLI_TOKEN=Z3R0-FAKE-... (runtime; opt-in) │
│  │    CALLBACK_URL + sentinels + CLERK_USER_ID                   │
│  ├─ outboundByHost["zero.worker"] = handleMessageEnd/handleAgentEnd │
│  └─ outboundHandlers.substitute = secretProxy.outbound           │
│       (catch-all; per-container overrides via                    │
│        setOutboundHandler('substitute', { overrides }))          │
│                                                                  │
│  pi-ai inside the container:                                     │
│    POST {AI Gateway}/anthropic/v1/messages                       │
│      cf-aig-authorization: Bearer Z3R0-FAKE-CLOUDFLARE_API_KEY   │
│      │  intercepted on-host by the catch-all handler             │
│      ▼                                                           │
│    secretProxy.outbound:                                         │
│      url/headers/body — byte-replace fake → env.CLOUDFLARE_API_KEY│
│      fetch(gateway.ai.cloudflare.com, ...)  (real key here)      │
│    → normal Anthropic stream; tool calls, thinking, content      │
│                                                                  │
│  On each message_end, the container POSTs:                       │
│    POST http://zero.worker/message-end { sessionId, text }       │
│      │   intercepted on-host                                     │
│      ▼                                                           │
│  handleMessageEnd:                                               │
│    UserDO session lookup → { chatId, topicId }                   │
│    grammY bot.api.sendMessage(…, { message_thread_id })          │
│    → Telegram delivers each message as it completes.             │
│                                                                  │
│  On agent_end, the container POSTs:                              │
│    POST http://zero.worker/agent-end { sessionId, willRetry }    │
│      │   intercepted on-host                                     │
│      ▼                                                           │
│  handleAgentEnd:                                                 │
│    if !willRetry → markSessionIdle (stops typing indicator)      │
└──────────────────────────────────────────────────────────────────┘
```

## Persistence

Each Clerk user owns the prefix `<clerkUserId>/` on the shared
`zero-agent-state` bucket. A single compressed archive of the
container's `/workspace` tree is stored there:

- `<clerkUserId>/state.tar.gz` — the full `/workspace` snapshot

`/workspace` is pi's working directory (`cwd`) and the one persisted
tree:

```
/workspace/                      (cwd — pi's working dir)
├── sessions/<sessionId>/        pi session JSONL files
├── notes/                       the notes vault (long-term memory)
├── attachments/                 files the user sent over Telegram
└── …                            pi's working files, documents
```

Everything pi writes under `/workspace` — sessions, notes, and any
future data (telegram attachments, user documents, scratch files) —
persists through the same restore-on-boot / save-on-event path with no
per-type wiring.

### Lifecycle

- **Restore on boot** — `entrypoint.sh` runs
  `curl -sf http://zero.worker/state | tar xz -C /workspace`. A 404 (no
  prior snapshot) starts with an empty tree.
- **Save on `agent_end` and SIGTERM** — `save-state.ts` runs
  `tar cz -C /workspace .` and PUTs the archive to
  `http://zero.worker/state`. Every completed turn snapshots the whole
  tree; SIGTERM covers idle eviction and deploy rollouts.

The worker mediates R2 via two routes on the `zero.worker` outbound
handler, backed by the `AGENT_STATE_BUCKET` binding:

```
GET  /state  →  R2 get(<userId>/state.tar.gz) → 200 body | 404
PUT  /state  →  R2 put(<userId>/state.tar.gz, body) → 204
```

Both use the `X-Clerk-User-Id` header (same trust model as `/message-end`).

### Durability

Durability is **per-turn**, not per-write. Session and notes writes are
local until the next save. `save-state.ts` fires on every `agent_end`
(each turn boundary) and on SIGTERM (idle eviction, deploy rollout,
Durable Object code-update reset). Only a hard crash (SIGKILL) mid-turn
loses the in-progress turn — acceptable for a chat bot, since
`agent_end` fires reliably at every turn boundary.

On container restart, the bridge lazy-loads each session via
`SessionManager.continueRecent` against
`/workspace/sessions/<sessionId>`, transparently resuming the
conversation. The directory's existence is the only persisted index —
there is no sidecar metadata file. Pi's internal session ids are not
used by the worker; the worker only knows our opaque `sessionId` (KV
`topic:` → `sessionId`) and the container resolves it by directory.

See [`r2-mount.md`](r2-mount.md) for one-time bucket and binding setup.

## State Model

Per-user data is split between a `UserDO` Durable Object (source of
truth, SQLite via [do-orm](https://github.com/juanibiapina/do-orm))
and Workers KV (bootstrap lookups only).

### KV (bootstrap)

| Key                                          | Value                                              | Written by                            | Read by                                          |
|----------------------------------------------|----------------------------------------------------|---------------------------------------|--------------------------------------------------|
| `tg:{telegramId}`                            | `clerkUserId`                                      | `POST /api/telegram-link`             | webhook (route messages)                         |

The `tg:` reverse lookup is the only way to resolve a Telegram user ID
to a Clerk user ID; it is kept in sync by the link/unlink routes.

### UserDO (per-user, addressed by `idFromName(clerkUserId)`)

| Table            | Columns                            | Purpose                                     |
|------------------|------------------------------------|---------------------------------------------|
| `telegram_link`  | `id`, `telegramId`                 | The user's linked Telegram account (≤1 row) |
| `sessions`       | `id`, `chatId`, `topicId`, `sessionId` | Topic↔session mappings                  |

The `telegram_link` table is the source of truth for the Clerk↔Telegram
mapping. The `GET /api/telegram-id` route reads directly from the DO;
the KV `tg:` entry is a denormalized reverse index synced on write.

The `sessions` table replaces the old `topic:` and `session:` KV pairs.
Lookups by topic coordinates or by session ID are both queries on one
table — no mirrored entries needed. If the container has lost its
in-memory session map (e.g. just woke from sleep) but the on-disk
session directory survives, the bridge resumes the session from disk
transparently. A 404 only happens when the on-disk dir is also gone
(data loss); the webhook creates a fresh session.

## Durable Objects

| DO | Purpose | Storage |
|---|---|---|
| **UserDO** | Per-user data store. One instance per Clerk user (`idFromName(clerkUserId)`). Owns the Telegram link and session mappings. | SQLite via do-orm (`telegram_link`, `sessions` tables) |
| **AgentContainer** | Cloudflare Container hosting `@zero/agent-server` (pi-coding-agent). One container per Clerk user (`getByName(clerkUserId)`), idles after 5 minutes. `fetch` refreshes `envVars` on every call (callback URL, sentinels, `CLERK_USER_ID`, and a live Google token override). Persists the `/workspace` tree as a single `state.tar.gz` archive via `/state` on `zero.worker`. Defines `outboundByHost["zero.worker"]` for the Telegram reply and state-archive paths. Callbacks (reply, close-session) include `clerkUserId` so the worker can address the UserDO for session lookups. | None (state persists as `<clerkUserId>/state.tar.gz` in R2 via the worker) |

## Routes

```
GET    /api/telegram-id                  — Read caller's Telegram id (Clerk)
POST   /api/telegram-link                — Link via Login Widget payload (Clerk)
DELETE /api/telegram-id                  — Unlink caller's Telegram id (Clerk)
POST   /api/webhooks/telegram            — Telegram bot webhook (secret-token auth)

GET    /api/admin/users                  — List all users + cost (admin)
GET    /api/admin/users/{userId}         — One user's identity + link status (admin)
GET    /api/admin/costs                  — Aggregate cost summary (admin)
GET    /api/admin/costs/sessions         — Session cost list, ?userId= filter (admin)
GET    /api/admin/github/status          — A user's GitHub install/token check (admin)
POST   /api/admin/import-notes/{userId}  — Import a notes archive (admin)
```

Admin routes are gated by the `ADMIN_USER_ID` env var. The user list is
sourced from Clerk (`apps/api/src/admin-users.ts`), so every signed-up
user appears — even those with no sessions — joined in memory with a
single D1 cost aggregate; it does **no** per-user UserDO or GitHub calls.
The detail route is the only admin path that pays for a per-user Clerk
`getUser` plus one UserDO read (Telegram link, Google/onboarding status);
GitHub status, the session list, and notes import stay separate endpoints
the detail page composes on the client.

The link route accepts the Login Widget callback payload and verifies
its HMAC against `TELEGRAM_BOT_TOKEN` (`apps/api/src/telegram-auth.ts`).
See [`telegram-login.md`](telegram-login.md) for the algorithm, BotFather
setup, and the required `VITE_TELEGRAM_BOT_USERNAME` env var.

The webhook handler is built on grammY via its `hono` adapter
(`webhookCallback`). grammY validates the secret-token header against
`TELEGRAM_WEBHOOK_SECRET`, parses the `Update`, and dispatches to bot
middleware.

The bot middleware accepts **forum topic messages** and **DMs**. A message
is processed if it has text/caption or a downloadable attachment (photo,
document, audio, voice, video, video note, animation, sticker); messages
with neither are dropped. It schedules `processTopicMessage` via
`executionCtx.waitUntil` and returns 200 to Telegram immediately. The
background task:

1. KV `tg:{telegramId}` → `clerkUserId`; drop the message if unknown.
2. KV `topic:{clerkUserId}:{chatId}:{threadId}` → `sessionId`; on miss,
   ask the container for a fresh session and store both the topic mapping
   and the reverse `session:{sessionId}` record.
3. POST the message text (and any attachment bytes) to
   `/sessions/{sessionId}/messages` on the container.

### Attachments

Any non-text Telegram message (photo, document, audio, voice, video,
video note, animation, sticker) is downloaded and forwarded. The webhook
resolves the single attachment in priority order (`photo` first, since
back-compat fields are double-set: `animation` also sets `document`,
`live_photo` also sets `photo`), calls grammY `getFile` to get a
`file_path`, then fetches the bytes from
`${TELEGRAM_API_ROOT}/file/bot<token>/<file_path>` (Telegram caps bot
downloads at 20MB). Bytes are base64-encoded into the `sendMessage` RPC
body (`attachments: [{ filename, mimeType, dataBase64 }]`, schema in
`contract.ts`). The container writes each file to `/workspace/attachments/`
and appends a `[File saved to <path> (<mime>)]` note to the prompt so pi
can `read` images, run `pdftotext`/`pdftoppm` on PDFs (poppler-utils,
see the `attachments` skill), or inspect anything else via bash. Files persist
with the rest of `/workspace` on R2. Oversized or undownloadable files
produce a graceful user-facing reply instead of a silent drop. Albums
(`media_group_id`) arrive as separate updates and become separate turns.

The worker→container HTTP calls go through `apps/api/src/agent-client.ts`,
which derives a fully-typed [Hono RPC](https://hono.dev/docs/guides/rpc)
client from the contract defined in
`packages/agent-server/src/contract.ts`. URLs, methods, and request /
response shapes are inferred from the shared Zod schemas; the worker
never hand-encodes them.

Inside the container, pi-coding-agent drives the conversation. Pi-ai
uses its built-in `cloudflare-ai-gateway` provider, which builds the
gateway URL from `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` and
authenticates with `cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>`,
reading the token from `process.env.CLOUDFLARE_API_KEY` — a sentinel the
worker's catch-all outbound handler swaps for the real value on the way
out (see “Secret Proxying”). It sends no Anthropic key itself; the gateway
holds the stored Anthropic key (BYOK), injects it upstream, and Anthropic
bills us directly at standard rates. The model
is `claude-opus-4-8` with thinking level `high`. `@zero/agent-server`
reads an optional `LLM_BASE_URL_OVERRIDE` to repoint the model's base URL
at the mock Anthropic server in e2e; it is empty in prod.

As pi produces each assistant message (the `message_end` event), the
container POSTs the text to `http://zero.worker/message-end`. That call
stays on-host — `AgentContainer.outboundByHost["zero.worker"]` intercepts
it and uses grammY to send the message into the same Telegram topic.
Multi-turn interactions (text → tools → text → tools → final text)
surface each intermediate message immediately instead of accumulating
them into a single blob.

When the agent loop finishes (`agent_end`), the container POSTs to
`http://zero.worker/agent-end` with `{ willRetry }`. If `!willRetry`,
the worker marks the session idle.

While a turn is running, Telegram shows a “typing…” indicator. It is
driven by a `status` column (`idle`/`active`) on the `sessions` row in
`UserDO`: `markSessionActive` flips it on after a message is forwarded
and arms a DO alarm that re-sends the typing action every few seconds
(Telegram's action expires after ~5s). The `/agent-end` callback runs
`markSessionIdle`, and the alarm self-cancels once no session is
`active`. Because `agent_end` always fires, the indicator reliably
stops at the end of every turn (reply, empty turn, abort, or
`close_session`).

Tradeoffs:

- A worker crash inside `waitUntil` silently drops the update; Telegram
  won't retry.
- A container restart loses its in-memory session map but the on-disk
  session dir on R2 survives, so the bridge resumes via
  `SessionManager.continueRecent` on the next message. Only when the
  on-disk dir is also gone (R2 data loss / manual cleanup) does the
  webhook fall back to creating a fresh session and dropping the stale
  KV entries; the user is not notified.

The webhook URL and secret are registered with Telegram manually via the
Bot API's `setWebhook` method — see
[`telegram-webhook.md`](telegram-webhook.md).

## Container Outbound Handler

`AgentContainer.outboundByHost["zero.worker"]` is the on-host path the
container uses to deliver Telegram replies and lifecycle signals. Plain
HTTP (`http://zero.worker/message-end`, `/agent-end`) works because the
request is intercepted on the same physical host before it hits the
network — see Cloudflare's
[outbound traffic docs](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).

For interception to work, `apps/api/src/index.ts` must re-export
`ContainerProxy` from `@cloudflare/containers`.

Pi-ai's LLM traffic uses a different mechanism ("Secret proxying",
below): the catch-all `outbound` handler intercepts every container
egress except `zero.worker` and substitutes registered fakes for their
real env values before forwarding to the upstream host. The callback
handlers run inside the Workers runtime with full access to `env` (KV,
Telegram bot token). No public route, no shared secret.

## Secret Proxying

The container process must never see the real value of any secret it
can't be trusted with. The pattern is a **sentinel substitution**
implemented in `apps/api/src/secret-proxy.ts`:

1. For each registered env-var name, the worker injects the constant
   sentinel `Z3R0-FAKE-<ENV_NAME>` into the container's `envVars`. The
   in-container process (pi, anything pi spawns) reads the sentinel as
   if it were the real value.
2. `AgentContainer.outbound` is a catch-all handler. Every container
   egress except hosts in `outboundByHost` (currently just
   `zero.worker`) flows through it. The handler buffers the request,
   byte-replaces every registered sentinel with the real value from
   `env`, and forwards via plain `fetch`. Substitution covers the URL,
   header values, and body bytes — wherever a client library might put
   the secret.
3. The sentinel is *not* a credential. It can leak, repeat across
   containers, or be guessed; the only thing capable of turning it into
   the real secret is this handler running inside the worker. The real
   value never enters the container's address space.

For the substitution to fire on HTTPS traffic (Anthropic),
`AgentContainer.interceptHttps = true` is required, and the container's
entrypoint installs Cloudflare's MITM CA cert
(`/etc/cloudflare/certs/cloudflare-containers-ca.crt`, mounted at
runtime) into the system trust store and exports `NODE_EXTRA_CA_CERTS`
so node (undici) accepts it. Without
this, HTTPS bypasses the catch-all entirely.

Two categories of registered secret share the same substitution
handler:

- **env-resolved** — real value lives in worker `env`, resolved on
  every outbound. Used for app-wide secrets like `CLOUDFLARE_API_KEY`.
- **runtime-resolved** — real value is per-container, pushed via
  `Container.setOutboundHandler('substitute', { overrides })`. The
  framework persists the override map into DO storage and threads it
  through `ContainerProxy` props, where the handler reads it as
  `ctx.params.overrides[name]`. Used for `GOOGLE_WORKSPACE_CLI_TOKEN`,
  which is a per-user OAuth access token fetched live from Clerk in
  `refreshEnvVars`. Pi sees the same constant sentinel in env; the
  substitution swaps in the right token for that user on the way out.
  When the user hasn't connected Google, the sentinel is omitted from
  `envVars` entirely so the Google CLIs (gmcli/gccli/gdcli) exit with a
  clear auth error rather than forwarding a sentinel nothing can
  substitute.

A separate concern tags AI Gateway traffic with the requesting user. The
substitution handler is wrapped by `withGatewayMetadata` (`ai-gateway.ts`):
for requests whose host is `gateway.ai.cloudflare.com`, the wrapper sets
`cf-aig-metadata: {"user_id": "<clerkUserId>"}` before delegating to the
substitution (the `userId` is passed alongside `overrides` via
`setOutboundHandler` in `refreshEnvVars`). Because the worker sets this
*after* the container boundary, it is authoritative — `.set` overwrites any
value the container supplied, so the agent can't spoof another user. The tag
drives per-user analytics and split-by-value spend limits in the gateway
(referenced there as `metadata.user_id`). It is only added for the gateway
host, so the id never leaks to other egress (GitHub, Google). Substitution
(`secret-proxy.ts`) stays oblivious to Cloudflare and users; this wrapper
stays oblivious to secrets.

## Secrets

Stored in Doppler (`zero-api`):

- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `TELEGRAM_BOT_TOKEN` — used by grammY to authenticate as the bot
- `TELEGRAM_BOT_INFO` — JSON `getMe` result; lets grammY skip the per-request
  `getMe` call (see [`telegram-webhook.md`](telegram-webhook.md))
- `TELEGRAM_WEBHOOK_SECRET` — Telegram secret-token for the webhook URL
- `CLOUDFLARE_API_KEY` — Cloudflare AI Gateway token, sent as
  `cf-aig-authorization` and substituted on egress by the catch-all
  outbound handler; pi sees only a sentinel. The gateway injects the stored
  Anthropic key (BYOK) upstream, and Anthropic bills the usage directly. The non-secret
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID` live in
  `wrangler.jsonc` vars.

Google Workspace access is **not** stored in Doppler. Each user opts in
via the “Connect Google” button in the web UI (Clerk
`createExternalAccount` with the Workspace scopes). The worker calls
`users.getUserOauthAccessToken` per container request to fetch a fresh
access token, pushes it to the substitute handler via
`setOutboundHandler`, and injects the `GOOGLE_WORKSPACE_CLI_TOKEN`
sentinel into the container. See
[`google-workspace.md`](google-workspace.md).

## Dev Environment

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler) — `wrangler dev` runs the container locally
  and transparently routes `http://zero.worker/...` from the container into
  the local Workerd via TPROXY, mirroring production.

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

## Logging

Every log line is a single JSON object on stdout/stderr. Cloudflare's
Workers Logs indexer auto-extracts the fields, so the dashboard can
filter on e.g. `service`, `msg`, `clerk_user_id`, `tool_name` directly
instead of grepping a message string. Container stdout is captured into
the same Workers Logs index as the worker, so the two streams query
together.

Conventions:

- Always go through the `log` / `logError` helpers in `apps/api/src/log.ts`
  and `packages/agent-server/src/log.ts`. The shell entrypoint has its
  own `log_json` matching the same shape.
- Every log carries `service` (`"worker"` or `"agent-server"`) and `msg`
  (a short snake_case event name).
- Failure paths use `logError` (Cloudflare maps `console.error` to
  `level=error`). Don't add a redundant `level` field.
- `Error` instances must be wrapped with `fmtErr(err)` before logging —
  the indexer otherwise serialises raw `Error` objects to `{}` (see
  [workers-sdk#10513](https://github.com/cloudflare/workers-sdk/issues/10513)).
- Field names are snake_case, with a stable canonical set:
  `session_id`, `clerk_user_id`, `telegram_id`, `chat_id`, `thread_id`,
  `tool_name`, `host`, `container_id`, `len`, `cwd`, `dir`, `error`,
  `status`.
- Never log message content, model replies, tool results, or request
  bodies. Counts and identifiers only.

## Future Work

- Tighten container egress: set `enableInternet = false` plus
  `allowedHosts = ["gateway.ai.cloudflare.com", "zero.worker"]`.
- Surface session history (read sessions back out of R2 from the web UI
  for browsing/export).
- Per-user model preference + a switching API. Pi supports
  `session.setModel(…)`; expose a Clerk-gated route to drive it.
