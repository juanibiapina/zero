# Zero — Design Document

## Goal

Zero turns a Telegram forum topic into a chat session with an agent. The
web frontend lets a Clerk user paste their numeric Telegram id, which
links them to the bot. From then on, every message the user sends in a
**forum topic** is routed to a per-user agent container; the container
posts a reply back into the same topic. Direct messages, channel posts,
edits, callbacks etc. are dropped — only topic messages count today.

The agent inside the container is the pi coding agent
([@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent))
talking directly to Anthropic. Pi-ai uses its built-in `anthropic`
provider; the API key is read from `process.env.ANTHROPIC_API_KEY`, which
`AgentContainer` injects via `envVars` when starting the container. The
model is `claude-sonnet-4-5-20250929` with thinking level `high`. Replies
flow back through an on-host outbound trick — the container POSTs to
`http://zero.worker/reply` and the worker delivers via Telegram — so the
only external egress from the container is to `api.anthropic.com` and to
`<acct>.r2.cloudflarestorage.com` (for the FUSE-mounted session store,
described below).

Sessions are persisted on R2: each container mounts the user's prefix in
the shared `zero-agent-state` bucket via [tigrisfs](https://github.com/tigrisdata/tigrisfs)
(FUSE) at `/mnt/agent-state`, and pi writes its JSONL session files
there. The mount uses prefix-scoped temporary credentials minted on
every `AgentContainer.fetch` call (local JWT signing per the [R2 docs](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)),
so the container can never see another user's data either at the
filesystem layer (tigrisfs `bucket:prefix` syntax locks the FUSE root)
or at the S3 layer (R2 rejects requests outside the prefix). See
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
| State  | KV (Workers KV)                                   |
| Container | Cloudflare Containers (`@cloudflare/containers`, with `outboundByHost`) |
| Agent  | [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (Node 22 inside the container) |
| LLM    | Anthropic API direct — `claude-sonnet-4-5-20250929` |
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
│  ├─ mounts R2 prefix <clerkUserId>/ at /mnt/agent-state          │
│  │    via tigrisfs; pi writes JSONL session files there          │
│  ├─ fetch() refreshes envVars on every call:                    │
│  │    ANTHROPIC_API_KEY + REPLY_URL + R2 temp creds (1h)         │
│  └─ outboundByHost["zero.worker"] = handleContainerReply         │
│                                                                  │
│  pi-ai inside the container:                                     │
│    POST https://api.anthropic.com/v1/messages  (direct egress)   │
│    → normal Anthropic stream; tool calls, thinking, content      │
│                                                                  │
│  When pi emits agent_end, the container POSTs:                   │
│    POST http://zero.worker/reply { sessionId, text }             │
│      │   intercepted on-host                                     │
│      ▼                                                           │
│  handleContainerReply:                                           │
│    KV session:{sessionId} → { chatId, messageThreadId }          │
│    grammY bot.api.sendMessage(…, { message_thread_id })          │
│    → Telegram delivers reply into the original topic.            │
└──────────────────────────────────────────────────────────────────┘
```

## Persistence

Pi sessions live on R2 in the shared `zero-agent-state` bucket. Each
Clerk user owns the prefix `<clerkUserId>/`. Inside the container,
tigrisfs mounts that prefix at the hard-coded path `/mnt/agent-state`.
The agent-server creates one subdirectory per session id
(`/mnt/agent-state/<sessionId>/`) and hands it to pi as the session
directory; pi writes its JSONL file inside. On container restart, the
bridge lazy-loads via `SessionManager.continueRecent` against the same
directory, transparently resuming the conversation.

The directory's existence is the only persisted index — there is no
sidecar metadata file. Pi's internal session ids are not used by the
worker; the worker only knows our opaque `sessionId` (KV `topic:` →
`sessionId`) and the container resolves it by directory.

R2 configuration is mandatory — `AgentContainer` throws on missing creds
before the container even starts, and the container's entrypoint script
aborts if the mount fails. There is no in-memory fallback.

Isolation has two layers:

1. **FUSE root locked to the user's prefix.** `tigrisfs zero-agent-state:<clerkUserId> /mnt/agent-state` makes the prefix the filesystem root from inside the container; pi has no path to traverse outside it.
2. **Prefix-scoped R2 credentials.** The temp credential is bound to `prefixPaths: ["<clerkUserId>/"]`, so even a leaked credential cannot list or read other users' prefixes.

See [`r2-mount.md`](r2-mount.md) for one-time bucket and token setup.

## State Model

All non-session state is in Workers KV.

| Key                                          | Value                                              | Written by                            | Read by                                          |
|----------------------------------------------|----------------------------------------------------|---------------------------------------|--------------------------------------------------|
| `clerk:{clerkUserId}`                        | `telegramId`                                       | `PUT /api/telegram-id`                | `GET /api/telegram-id`                           |
| `tg:{telegramId}`                            | `clerkUserId`                                      | `PUT /api/telegram-id`                | webhook (route messages)                         |
| `topic:{clerkUserId}:{chatId}:{threadId}`    | `sessionId`                                        | webhook (on first message in a topic) | webhook (every message)                          |
| `session:{sessionId}`                        | `{ clerkUserId, chatId, messageThreadId }` JSON    | webhook (on session create)           | container outbound handler (for sending replies) |

KV doesn't support reverse lookup, so we keep both directions of each
relationship as explicit entries. If the container has lost its
in-memory session map (e.g. just woke from sleep) but the on-disk
session directory survives, the bridge resumes the session from disk
transparently. A 404 only happens when the on-disk dir is also gone
(data loss); the webhook then drops the stale `topic:` and `session:`
entries and starts a fresh session.

## Durable Objects

| DO | Purpose | Storage |
|---|---|---|
| **AgentContainer** | Cloudflare Container hosting `@zero/agent-server` (pi-coding-agent). One container per Clerk user (`getByName(clerkUserId)`), idles after 5 minutes. `fetch` mints prefix-scoped R2 temp creds and refreshes `envVars` on every call; the container mounts the user's R2 prefix at `/mnt/agent-state`. Defines `outboundByHost["zero.worker"]` for the Telegram reply path. | None (sessions live on the R2 mount inside the container; KV holds the topic↔session mappings) |

## Routes

```
GET    /api/telegram-id                  — Read caller's Telegram id (Clerk)
PUT    /api/telegram-id                  — Set/clear caller's Telegram id (Clerk)
POST   /api/webhooks/telegram            — Telegram bot webhook (secret-token auth)
```

The webhook handler is built on grammY via its `hono` adapter
(`webhookCallback`). grammY validates the secret-token header against
`TELEGRAM_WEBHOOK_SECRET`, parses the `Update`, and dispatches to bot
middleware.

The bot middleware accepts only **forum topic messages** (those with
`is_topic_message` and `message_thread_id` set). It schedules
`processTopicMessage` via `executionCtx.waitUntil` and returns 200 to
Telegram immediately. The background task:

1. KV `tg:{telegramId}` → `clerkUserId`; drop the message if unknown.
2. KV `topic:{clerkUserId}:{chatId}:{threadId}` → `sessionId`; on miss,
   ask the container for a fresh session and store both the topic mapping
   and the reverse `session:{sessionId}` record.
3. POST the message text to `/sessions/{sessionId}/messages` on the
   container.

Inside the container, pi-coding-agent drives the conversation. Pi-ai
talks directly to `https://api.anthropic.com/v1/messages` using its
built-in `anthropic` provider; the API key is read from
`process.env.ANTHROPIC_API_KEY`, which `AgentContainer` injects via
`envVars` when starting the container. The model is
`claude-sonnet-4-5-20250929` with thinking level `high`.

When pi emits `agent_end`, the container POSTs the final assistant text
to `http://zero.worker/reply`. That call stays on-host —
`AgentContainer.outboundByHost["zero.worker"]` intercepts it and uses
grammY to send the message back into the same Telegram topic.

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
container uses to deliver Telegram replies. Plain HTTP
(`http://zero.worker/reply`) works because the request is intercepted on
the same physical host before it hits the network — see Cloudflare's
[outbound traffic docs](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).

For interception to work, `apps/api/src/index.ts` must re-export
`ContainerProxy` from `@cloudflare/containers`.

Pi-ai's LLM traffic does *not* use this mechanism: it goes out to
`api.anthropic.com` over normal egress, authenticated with the injected
`ANTHROPIC_API_KEY`. The reply handler runs inside the Workers runtime
with full access to `env` (KV, Telegram bot token). No public route, no
shared secret.

## Secrets

Stored in Doppler (`zero-api`):

- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `TELEGRAM_BOT_TOKEN` — used by grammY to authenticate as the bot
- `TELEGRAM_BOT_INFO` — JSON `getMe` result; lets grammY skip the per-request
  `getMe` call (see [`telegram-webhook.md`](telegram-webhook.md))
- `TELEGRAM_WEBHOOK_SECRET` — Telegram secret-token for the webhook URL
- `ANTHROPIC_API_KEY` — injected into the container's env (`envVars`) so
  pi-ai can call `api.anthropic.com` directly
- `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_PARENT_ACCESS_KEY_ID`,
  `R2_PARENT_SECRET_ACCESS_KEY` — used by `AgentContainer` to mint
  prefix-scoped R2 temp credentials for the per-user FUSE mount. See
  [`r2-mount.md`](r2-mount.md).

## Dev Environment

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler) — `wrangler dev` runs the container locally
  and transparently routes `http://zero.worker/...` from the container into
  the local Workerd via TPROXY, mirroring production.

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

## Future Work

- Tighten container egress: set `enableInternet = false` plus
  `allowedHosts = ["api.anthropic.com", "zero.worker", "<acct>.r2.cloudflarestorage.com"]`.
- Surface session history (read sessions back out of R2 from the web UI
  for browsing/export).
- Per-user model preference + a switching API. Pi supports
  `session.setModel(…)`; expose a Clerk-gated route to drive it.
- Route Anthropic traffic through AI Gateway later for observability,
  per-user cost accounting, and caching.
