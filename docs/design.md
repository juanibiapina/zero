# Zero — Design Document

## Goal

Zero receives Telegram bot webhooks, drops anything from an unknown sender,
and (for now) just logs everything else against the right user. The web
frontend exists only so a signed-in user can paste their Telegram numeric
user id, which is used by the worker to route webhooks.

## Package Structure

```
zero/
├── apps/
│   ├── api/             (@zero/api)              — CF Worker: HTTP API + Telegram webhook
│   └── web/             (@zero/web)              — Vite + React: single Telegram-id form
├── packages/
│   ├── core/            (@zero/core)             — Reserved for future shared types (currently empty)
│   ├── agent-server/    (@zero/agent-server)     — Stub Node.js HTTP server for the CF Container (placeholder)
│   ├── eslint-config/                            — Shared ESLint config
│   └── typescript-config/                        — Shared TypeScript config
└── docs/                                         — Design + ops docs
```

## Tech Stack

| Layer  | Tech                                              |
|--------|---------------------------------------------------|
| Auth   | Clerk                                             |
| Frontend | React 19, Tailwind v4, shadcn/ui primitives    |
| API    | Hono + OpenAPIHono + Zod on Cloudflare Workers    |
| State  | KV (Workers KV)                                   |
| Container | Cloudflare Containers (no-op stub kept so the binding stays stable) |
| Secrets | Doppler (`zero-api`, `zero-web`) — see [`docs/secrets.md`](secrets.md) |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                Frontend (Vite + React)                        │
│                one screen: Telegram id input                  │
└──────────────────────────┬───────────────────────────────────┘
                           │ REST (Clerk-authed)
┌──────────────────────────▼───────────────────────────────────┐
│              CF Worker (zero-api)                             │
│                                                               │
│  GET/PUT /api/telegram-id        Clerk JWT                    │
│  POST /api/webhooks/telegram     X-Telegram-Bot-Api-Secret-Token│
│           │                                                   │
│           │ 200 OK immediately, then in waitUntil:             │
│           ▼                                                   │
│  ┌────────────────────────────┐                              │
│  │ KV                          │                              │
│  │ clerk:{clerkUserId} → tgId  │                              │
│  │ tg:{telegramId} → clerkId   │                              │
│  └────────────────────────────┘                              │
│     known user: log + (later) handle the update                │
│     unknown user: log + drop                                   │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ AgentContainer (stub, kept for future agent work)         ││
│  └──────────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────┘
```

## State Model

Two KV entries per user:

| Key                       | Value         | Written by         | Read by      |
|---------------------------|---------------|--------------------|--------------|
| `clerk:{clerkUserId}`     | `telegramId`  | PUT /api/telegram-id | GET /api/telegram-id |
| `tg:{telegramId}`         | `clerkUserId` | PUT /api/telegram-id | POST /api/webhooks/telegram |

Both keys are maintained atomically in the same handler. KV doesn't support
reverse lookup, so we keep both directions explicitly.

## Durable Objects

| DO | Purpose | Storage |
|---|---|---|
| **AgentContainer** | CF Container, no-op stub. Kept so future agent work doesn't require new DO migrations. | None |

## Routes

```
GET    /api/telegram-id                  — Read caller's Telegram id (Clerk)
PUT    /api/telegram-id                  — Set/clear caller's Telegram id (Clerk)
POST   /api/webhooks/telegram            — Telegram bot webhook (secret-token auth)
```

The webhook handler is built on [grammY](https://grammy.dev) via its `hono`
adapter (`webhookCallback`). grammY does the secret-token check, parses the
Telegram `Update`, and dispatches to bot middleware. The worker compares the
`X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`
and rejects mismatches with 401.

The bot middleware doesn't do any KV work synchronously — it schedules
`processUpdate` via `executionCtx.waitUntil` and returns. That keeps the
response to Telegram fast and lets the worker do the routing decision
after the 200. Tradeoff: a worker crash inside `waitUntil` silently drops
the update — Telegram won't retry. Acceptable for this app today.

Unknown users (no `tg:{telegramId}` entry in KV) are dropped at this stage.
Known users are logged for now; real per-user handling will live inside
`processUpdate` later.

The webhook URL and secret are registered with Telegram manually via the
Bot API's `setWebhook` method — see
[`docs/telegram-webhook.md`](telegram-webhook.md).

## Secrets

Stored in Doppler (`zero-api`):

- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `TELEGRAM_BOT_TOKEN` — used by grammY to authenticate as the bot
- `TELEGRAM_BOT_INFO` — JSON `getMe` result; lets grammY skip the per-request
  `getMe` call (see [`telegram-webhook.md`](telegram-webhook.md))
- `TELEGRAM_WEBHOOK_SECRET` — Telegram secret-token for the webhook URL

## Dev Environment

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler)
- Dev server auto-started via `.config/gobfile.toml` running `pnpm turbo dev`.

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

## Future Work

- Grow `processUpdate` in the Telegram webhook to do real work for known
  users (reply via the bot, hand off to the container, etc.).
- Flesh out the container — its binding and DO migration are already in place;
  only `packages/agent-server` and `AgentContainer` need real code.
