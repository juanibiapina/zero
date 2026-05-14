# Zero — Design Document

## Goal

Zero turns a Telegram forum topic into a chat session with an agent. The
web frontend lets a Clerk user paste their numeric Telegram id, which
links them to the bot. From then on, every message the user sends in a
**forum topic** is routed to a per-user agent container; the container
posts a reply back into the same topic. Direct messages, channel posts,
edits, callbacks etc. are dropped — only topic messages count today.

The agent itself is a placeholder (hard-coded "Replying to: ..."); this
document is about the wiring, not the agent.

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
│  ├─ hosts @zero/agent-server (Node 22 HTTP server)               │
│  └─ outboundByHost["zero.worker"] = handleContainerReply         │
│                                          ▲                       │
│                       container POST http://zero.worker/reply    │
│                       { sessionId, text }                        │
│                       (intercepted on-host; no public URL)       │
│                                                                  │
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
| **AgentContainer** | Cloudflare Container hosting `@zero/agent-server`. One container per Clerk user (`getByName(clerkUserId)`), idles after 5 minutes. Also defines `outboundByHost["zero.worker"]`, the reply handler that runs in the Workers runtime. | None (in-memory session set; KV holds the topic↔session mappings) |

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

The container then POSTs a reply to `http://zero.worker/reply`. That
call never leaves the host — `AgentContainer.outboundByHost["zero.worker"]`
intercepts it inside the Workers runtime and uses grammY to send the
message back into the same topic.

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

`AgentContainer.outboundByHost["zero.worker"]` is the only path from the
container back into the worker. Plain HTTP (`http://zero.worker/...`) is
fine because the request is intercepted on the same physical host before
it ever hits the network — see Cloudflare's
[outbound traffic docs](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).

For interception to work, `apps/api/src/index.ts` must re-export
`ContainerProxy` from `@cloudflare/containers`.

Today we have a single virtual host. As capabilities grow, more virtual
hosts (e.g. `tools.worker`, `kv.worker`) can be added to the same map.

## Secrets

Stored in Doppler (`zero-api`):

- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `TELEGRAM_BOT_TOKEN` — used by grammY to authenticate as the bot
- `TELEGRAM_BOT_INFO` — JSON `getMe` result; lets grammY skip the per-request
  `getMe` call (see [`telegram-webhook.md`](telegram-webhook.md))
- `TELEGRAM_WEBHOOK_SECRET` — Telegram secret-token for the webhook URL

## Dev Environment

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler) — `wrangler dev` runs the container locally
  and transparently routes `http://zero.worker/...` from the container into
  the local Workerd via TPROXY, mirroring production.

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

## Future Work

- Real agent logic inside `@zero/agent-server` (model, tools, persistence)
  in place of the hard-coded reply.
- Recover from container restart: when a message to an existing topic
  returns 404, drop the stale mapping and create a fresh session
  transparently. (Today we log and drop.)
- Tighten container egress: set `enableInternet = false` plus explicit
  `allowedHosts`, once the agent is built.
- Persist sessions outside the container so they survive restarts and
  let other surfaces (the web app) view them.
