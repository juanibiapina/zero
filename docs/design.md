# Zero — Design Document

## Goal

Zero turns a Telegram chat (a forum topic, or a DM using topicId=0) into a
conversation with a meta-agent. The web frontend uses Telegram's
[Login Widget](https://core.telegram.org/widgets/login) to link a Clerk account
to a Telegram numeric id (HMAC-verified server-side against the bot token). From
then on, each message is processed by a two-phase agent that runs inside the
per-user `UserDO` Durable Object.

The webhook resolves the user via `KV tg:{telegramId}` and calls
`UserDO.enqueueTurn` (dedupe the update, store the user message, arm a DO
alarm), then returns 200 immediately. The alarm runs the turn:

1. **Interface agent** reads recent conversation history and a topic-based
   knowledge model (DO SQLite) and replies to the user via a `reply()` tool,
   sending live progress as it works. It tracks every topic it reads or writes.
2. **Writer agent** consolidates durable knowledge into the accessed topics.

LLM calls go through the Cloudflare AI Gateway (BYOK Anthropic; the gateway
stores the real key and bills us directly) authenticated with
`cf-aig-authorization` and tagged per user with `cf-aig-metadata`. The model is
`MODEL_ID` (`claude-sonnet-4-6`). All durable state is the DO SQLite (topics,
conversations, messages); there is no container, no per-user filesystem, and no
R2 archive. A self-rescheduling `setTimeout` drives the Telegram typing action
while a turn runs. See [`topics.md`](topics.md) for the full design of the topic
model and the two agents.

## Package Structure

```
zero/
├── apps/
│   ├── api/             (@zero/api)              — CF Worker: HTTP API, Telegram webhook, UserDO meta-agent
│   └── web/             (@zero/web)              — Vite + React: single Telegram-id form
├── packages/
│   ├── core/            (@zero/core)             — Reserved for future shared types (currently empty)
│   ├── eslint-config/                            — Shared ESLint config
│   └── typescript-config/                        — Shared TypeScript config
└── docs/                                         — Design + ops docs
```

## Tech Stack

| Concern | Choice |
|---|---|
| Frontend | React 19, Tailwind v4, shadcn/ui primitives |
| API    | Hono + OpenAPIHono + Zod on Cloudflare Workers |
| State  | UserDO (Durable Object with SQLite via [do-orm](https://github.com/juanibiapina/do-orm)) + Workers KV for identity lookups |
| Agents | `ai` SDK (`generateText` tool loop) with `@ai-sdk/anthropic` |
| LLM    | Cloudflare AI Gateway → Anthropic (BYOK) — `claude-sonnet-4-6` |
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
│      1. resolveContext: keep topic messages + DMs (topicId=0)    │
│      2. KV tg:{tgId} → clerkUserId   (drop unknown)              │
│      3. UserDO.enqueueTurn { updateId, clerkUserId,             │
│                              chatId, topicId, text }             │
│         (dedupe on processed_updates, store user message,        │
│          arm the DO alarm) → return                              │
│                                                                  │
│  UserDO (idFromName(clerkUserId), SQLite via do-orm)             │
│  ├─ alarm(): drain threads whose tail is a user message;         │
│  │    on catchable failure self-reschedule w/ backoff while work  │
│  │    remains, else stop (see do/alarm.ts)                        │
│  ├─ runTurn(chatId, topicId):                                    │
│  │    ├─ create model (AI Gateway, cf-aig-metadata)              │
│  │    ├─ setTimeout typing loop (chatAction every 4s)            │
│  │    └─ orchestrateTurn(store, model, send, search):            │
│  │         1. interface agent — reply()/topic + research tools   │
│  │            (each reply persisted before it is sent)            │
│  │         2. writer agent — consolidate accessed topics         │
│  └─ send: grammY bot.api.sendMessage(…, { message_thread_id })   │
│                                                                  │
│  LLM: POST {AI Gateway}/anthropic/v1/messages                    │
│    cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>             │
│    cf-aig-metadata: {"user_id": <clerkUserId>}                   │
└──────────────────────────────────────────────────────────────────┘
```

The agents and the turn orchestrator (`apps/api/src/agents/*`) depend on the
`Store` port (`apps/api/src/store/types.ts`), a model factory
(`agents/model.ts`), and a `WebSearch` port (`apps/api/src/websearch/types.ts`),
not on the DO or do-orm. They are unit-tested with an in-memory store, a scripted
mock model, and an in-memory search adapter; `UserDO` supplies the production
`DbStore` and `createBraveSearch` adapters and the alarm-driven execution.

The interface agent and the research agent are the **same runner**
(`agents/run.ts`: `model + system + prompt + tools → final text`) instantiated
with different system prompts and toolsets. The interface agent's returned text
is ignored (its output is the `{ replies, accessed }` collected by its tool
closures); it exposes a `research` tool that spawns a research-prompted agent
armed with `web_search`, whose final message becomes the tool result. Both run
inline in the turn's DO alarm. See [`topics.md`](topics.md),
[`research.md`](research.md), and [`framework.md`](framework.md).

## State Model

Per-user data lives in a `UserDO` Durable Object (source of truth, SQLite via
[do-orm](https://github.com/juanibiapina/do-orm)); Workers KV holds only the
Telegram→Clerk reverse lookup used to route incoming messages.

### KV (bootstrap)

| Key               | Value          | Written by                | Read by                  |
|-------------------|----------------|---------------------------|--------------------------|
| `tg:{telegramId}` | `clerkUserId`  | `POST /api/telegram-link` | webhook (route messages) |

The `tg:` reverse lookup is the only way to resolve a Telegram user ID to a
Clerk user ID; it is kept in sync by the link/unlink routes.

### UserDO (per-user, addressed by `idFromName(clerkUserId)`)

| Table               | Columns                                                        | Purpose                                        |
|---------------------|---------------------------------------------------------------|------------------------------------------------|
| `telegram_link`     | `id`, `telegramId`                                            | The user's linked Telegram account (≤1 row)    |
| `user_settings`     | `id`, `onboardingSeen`, `googleOnboardingStatus`, `createdAt`| Web onboarding + settings                      |
| `topics`            | `id`, `name`, `description`, `summary`, `body`, timestamps, `messageCount` | The knowledge model (see [`topics.md`](topics.md)) |
| `conversations`     | `id`, `chatId`, `topicId`, `createdAt`, `busySince`          | One thread per Telegram (chatId, topicId)      |
| `messages`          | `id`, `conversationId`, `role`, `content`, `createdAt`       | User/assistant exchanges                       |
| `processed_updates` | `updateId`, `createdAt`                                       | Webhook idempotency                            |

The `telegram_link` table is the source of truth for the Clerk↔Telegram mapping.
`GET /api/telegram-id` reads directly from the DO; the KV `tg:` entry is a
denormalized reverse index synced on write.

## Durable Objects

| DO | Purpose | Storage |
|---|---|---|
| **UserDO** | Per-user data store and turn runner. One instance per Clerk user (`idFromName(clerkUserId)`). Owns the Telegram link, settings, and the topic model, and runs the two-phase agent turn on a DO alarm. | SQLite via do-orm |

## Routes

```
GET    /api/telegram-id                  — Read caller's Telegram id (Clerk)
POST   /api/telegram-link                — Link via Login Widget payload (Clerk)
DELETE /api/telegram-id                  — Unlink caller's Telegram id (Clerk)
POST   /api/webhooks/telegram            — Telegram bot webhook (secret-token auth)
POST   /api/tasks                        — Parked stub, no-ops with 202 (Clerk)

GET    /api/admin/users                  — List all users (admin)
GET    /api/admin/users/{userId}         — One user's identity + link status (admin)
GET    /api/admin/github/status          — A user's GitHub install/token check (admin)
```

Admin routes are gated by the `ADMIN_USER_ID` env var. The user list is sourced
from Clerk (`apps/api/src/admin-users.ts`) so every signed-up user appears; it
does no per-user UserDO or GitHub calls. The detail route is the only admin path
that pays for a per-user Clerk `getUser` plus one UserDO read (Telegram link,
Google/onboarding status). Per-request cost tracking was removed with the
container runtime; the Cloudflare AI Gateway now logs per-user model/token/USD
cost, attributed via `cf-aig-metadata`.

`POST /api/tasks` is a parked stub. The container-backed task runner was removed;
the route accepts the request, marks Google onboarding done (so the web
onboarding flow completes), and returns 202. Reimplement later as a meta-agent
turn on the DO-alarm runtime (`TODO(tasks)`).

The link route accepts the Login Widget callback payload and verifies its HMAC
against `TELEGRAM_BOT_TOKEN` (`apps/api/src/telegram-auth.ts`). See
[`telegram-login.md`](telegram-login.md) for the algorithm, BotFather setup, and
the required `VITE_TELEGRAM_BOT_USERNAME` env var.

### Webhook flow

The webhook is built on grammY via its `hono` adapter (`webhookCallback`).
grammY validates the secret-token header against `TELEGRAM_WEBHOOK_SECRET`,
parses the `Update`, and dispatches to bot middleware. The middleware accepts
**forum topic messages** and **DMs** (topicId=0). The `/new` command resets the
conversation thread for a `(chatId, topicId)` (topics are left intact).

A regular message with text/caption is enqueued and returns 200 to Telegram
immediately. The background task:

1. `resolveContext` keeps topic messages and DMs; everything else is dropped.
2. KV `tg:{telegramId}` → `clerkUserId`; drop the message if unknown.
3. `UserDO.enqueueTurn` dedupes on `processed_updates`, stores the user
   message, and arms the DO alarm. The alarm runs the turn (see Architecture).

The webhook URL and secret are registered with Telegram manually via the Bot
API's `setWebhook` method — see [`telegram-webhook.md`](telegram-webhook.md).

### Attachments

Attachments are out of scope for the topic-model MVP. An attachment-only message
gets a short notice and is skipped; a message with both text and an attachment
is processed as text with a notice that the file was ignored. Reintroduce
downloading/handling later behind the topic model.

## Secrets

Stored in Doppler (`zero-api`):

- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `TELEGRAM_BOT_TOKEN` — used by grammY to authenticate as the bot
- `TELEGRAM_BOT_INFO` — JSON `getMe` result; lets grammY skip the per-request
  `getMe` call (see [`telegram-webhook.md`](telegram-webhook.md))
- `TELEGRAM_WEBHOOK_SECRET` — Telegram secret-token for the webhook URL
- `CLOUDFLARE_API_KEY` — Cloudflare AI Gateway token, sent as
  `cf-aig-authorization`. The gateway injects the stored Anthropic key (BYOK)
  upstream, and Anthropic bills the usage directly. The non-secret
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID` live in `wrangler.jsonc`
  vars; the `AI` binding resolves the gateway URL.

Google Workspace access is **not** stored in Doppler. Each user opts in via the
“Connect Google” button in the web UI (Clerk `createExternalAccount` with the
Workspace scopes). See [`google-workspace.md`](google-workspace.md).

## Dev Environment

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler)

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

## Logging

Every log line is a single JSON object on stdout/stderr. Cloudflare's Workers
Logs indexer auto-extracts the fields, so the dashboard can filter on e.g.
`service`, `msg`, `clerk_user_id` directly instead of grepping a message string.

Conventions:

- Always go through the `log` / `logError` helpers in `apps/api/src/log.ts`.
- Every log carries `service` (`"worker"`) and `msg` (a short snake_case event
  name).
- Failure paths use `logError` (Cloudflare maps `console.error` to
  `level=error`). Don't add a redundant `level` field.
- `Error` instances must be wrapped with `fmtErr(err)` before logging — the
  indexer otherwise serialises raw `Error` objects to `{}` (see
  [workers-sdk#10513](https://github.com/cloudflare/workers-sdk/issues/10513)).
- Field names are snake_case, with a stable canonical set: `clerk_user_id`,
  `telegram_id`, `chat_id`, `thread_id`, `host`, `len`, `error`, `status`.
- Never log message content, model replies, tool results, or request bodies.
  Counts and identifiers only.

## Future Work

- Reintroduce attachments behind the topic model.
- Reimplement `/api/tasks` as a meta-agent turn (`TODO(tasks)`).
- Add an in-app cost view sourced from the AI Gateway logs
  (`env.AI.gateway(id).getLog`, or the gateway REST API).
- Per-user model preference + a switching API.
- Surface topic/conversation history in the web UI for browsing/export.
