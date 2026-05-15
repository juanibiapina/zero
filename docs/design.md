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
only external egress from the container is to `api.anthropic.com`.

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
│  ├─ envVars.ANTHROPIC_API_KEY (set by the DO constructor)        │
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

## State Model

All persistent state is in Workers KV.

| Key                                          | Value                                              | Written by                            | Read by                                          |
|----------------------------------------------|----------------------------------------------------|---------------------------------------|--------------------------------------------------|
| `clerk:{clerkUserId}`                        | `telegramId`                                       | `PUT /api/telegram-id`                | `GET /api/telegram-id`                           |
| `tg:{telegramId}`                            | `clerkUserId`                                      | `PUT /api/telegram-id`                | webhook (route messages)                         |
| `topic:{clerkUserId}:{chatId}:{threadId}`    | `sessionId`                                        | webhook (on first message in a topic) | webhook (every message)                          |
| `session:{sessionId}`                        | `{ clerkUserId, chatId, messageThreadId }` JSON    | webhook (on session create)           | container outbound handler (for sending replies) |

KV doesn't support reverse lookup, so we keep both directions of each
relationship as explicit entries. Stale `topic:` entries (e.g. when the
container's in-memory session set is lost on restart) are accepted today;
recovery is future work.

## Durable Objects

| DO | Purpose | Storage |
|---|---|---|
| **AgentContainer** | Cloudflare Container hosting `@zero/agent-server` (pi-coding-agent). One container per Clerk user (`getByName(clerkUserId)`), idles after 5 minutes. Injects `ANTHROPIC_API_KEY` into the container's env; defines `outboundByHost["zero.worker"]` for the Telegram reply path. | None (in-memory session set; KV holds the topic↔session mappings) |

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
- A container restart loses its in-memory session set, so any subsequent
  message on a known topic will get a 404 from `/sessions/{id}/messages`.
  We log and drop. Recovery is future work.

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

## Dev Environment

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler) — `wrangler dev` runs the container locally
  and transparently routes `http://zero.worker/...` from the container into
  the local Workerd via TPROXY, mirroring production.

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

## Future Work

- Persist pi sessions outside the container (snapshot on each
  `agent_end`) so they survive restarts and let other surfaces view
  them. Today `SessionManager.inMemory()` means a sleep loses state.
- Recover from container restart: when a message to an existing topic
  returns 404, drop the stale mapping and create a fresh session
  transparently. (Today we log and drop.)
- Tighten container egress: set `enableInternet = false` plus
  `allowedHosts = ["api.anthropic.com", "zero.worker"]`.
- Per-user model preference + a switching API. Pi supports
  `session.setModel(…)`; expose a Clerk-gated route to drive it.
- Route Anthropic traffic through AI Gateway later for observability,
  per-user cost accounting, and caching.
