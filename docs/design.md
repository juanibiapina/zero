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
`MODEL_ID` (`claude-sonnet-4-6`). Durable state is the DO SQLite (topics,
conversations, messages, attachment metadata); image bytes live in the
`ATTACHMENTS` R2 bucket. There is no container and no per-user filesystem. A
self-rescheduling `setTimeout` drives the Telegram typing action across the
interface phase and stops when the reply is sent, which ends the turn. See
[`topics.md`](topics.md) for the full design of the topic model and the two
agents.

## Package Structure

```
zero/
├── apps/
│   ├── agent-api/       (@zero/agent-api)        — CF Worker: HTTP API, Telegram webhook, UserDO meta-agent
│   └── agent-web/       (@zero/agent-web)        — Vite + React: single Telegram-id form
├── packages/
│   ├── agent-core/      (@zero/agent-core)       — Reserved for future shared types (currently empty)
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
| Agents | Zero-owned tool loop (`agents/run.ts`) over `@anthropic-ai/sdk` |
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
│  ├─ alarm(): drain conversations that still owe work;            │
│  │    on catchable failure self-reschedule w/ backoff while work  │
│  │    remains, else stop (see do/alarm.ts)                        │
│  ├─ runTurn(chatId, topicId):                                    │
│  │    ├─ create model (AI Gateway, cf-aig-metadata)              │
│  │    ├─ setTimeout typing loop (chatAction every 4s)            │
│  │    └─ orchestrateTurn(store, model, send, search, google):     │
│  │         1. interface agent — reply()/topic + research +        │
│  │            set_timezone + Gmail/Calendar tools                 │
│  │            (each reply persisted before it is sent)            │
│  │      (consolidation happens later, in LearningDO)             │
│  └─ send: grammY bot.api.sendMessage(…, { message_thread_id })   │
│                                                                  │
│  LLM: POST {AI Gateway}/anthropic/v1/messages                    │
│    cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>             │
│    cf-aig-metadata: {"user_id": <clerkUserId>}                   │
└──────────────────────────────────────────────────────────────────┘
```

The agents and the turn orchestrator (`apps/agent-api/src/agents/*`) depend on the
`Store` port (`apps/agent-api/src/store/types.ts`), a model factory
(`agents/model.ts`), a `WebSearch` port (`apps/agent-api/src/websearch/types.ts`), and a
`GoogleWorkspace` port (`apps/agent-api/src/google/types.ts`), not on the DO or do-orm.
They are unit-tested with an in-memory store, a scripted mock model, and
in-memory search/Google adapters; `UserDO` supplies the production `DbStore`,
`createBraveSearch`, and `createGoogleWorkspace` (with a memoized Clerk token
provider) adapters and the alarm-driven execution.

The interface agent and the research agent are the **same runner**
(`agents/run.ts`: `model + system + (prompt | messages) + tools → final text`)
instantiated with different system prompts and toolsets. The interface agent's
returned text is ignored (its output is the `{ replies, accessed }` collected by
its tool closures); it exposes a `research` tool that spawns a research-prompted
agent armed with `web_search`, whose final message becomes the tool result. Both
run inline in the turn's DO alarm. See [`topics.md`](topics.md),
[`research.md`](research.md), and [`framework.md`](framework.md).

**Structured message history (interface agent).** The interface agent builds a
real multi-turn conversation (`buildConversationMessages` in
`agents/interface.ts`), not a single flattened blob. The split is deliberate:

- **System prompt** carries everything that is instruction or stable reference,
  not a turn: agent instructions, the datetime anchor, and the pinned-topics
  block.
- **`messages`** carries only the Telegram dialogue: each stored user/assistant
  message as a native turn, ending with the current user message. The tool loop
  appends the assistant response and one `tool_result` turn per step during the
  run.

Each user message is prefixed with an absolute timestamp `[YYYY-MM-DD HH:MM]` in
the user's timezone (stable turn-to-turn, cache-friendly); assistant messages
are verbatim. Leading assistant messages are dropped so the array starts on a
`user` turn (Anthropic requirement), and consecutive same-role turns are
coalesced (proxy compatibility). Only final user/assistant **text** is persisted
— never tool blocks — which structurally avoids orphaned `tool_use` 400s and
keeps cross-turn memory in topics as well as the log. The research, learning, and
onboarding agents still use the single-`prompt` path.

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
| `topics`            | `id`, `name`, `description`, `body`, timestamps, `messageCount` | The knowledge model (see [`topics.md`](topics.md)) |
| `knowledge`         | `id`, `version`, `systemFingerprint`                         | The knowledge version guarding topic writes    |
| `conversations`     | `id`, `chatId`, `topicId`, `createdAt`, `compactedThroughMessageId`, `summary` | One thread per Telegram (chatId, topicId); the last two are the non-destructive compaction boundary |
| `messages`          | `id`, `conversationId`, `role`, `kind`, `content`, `stopReason`, `responseId`, `consolidatedAt`, `createdAt` | The conversation's protocol log: `content` is a JSON array of wire-format content blocks; `responseId` is the model's own id, chained into the next turn's cache diagnostics |
| `pending_messages`  | `id`, `conversationId`, `content`, `createdAt`, `injectedAt` | Telegram messages queued until a turn injects them |
| `deliveries`        | `messageId`, `blockIndex`, `claimedAt`                       | Assistant text blocks already handed to Telegram |
| `learning_jobs`     | `jobId`, `highWaterMessageId`, `startedAt`, `completedAt` | One consolidation run's frozen input range; completion is idempotent by job id |
| `external_calls`    | `toolUseId`, `tool`, `status`, `result`, `startedAt`, `completedAt` | Irreversible outbound calls (send mail, create event), claimed before the request leaves |
| `attachments`       | `id`, `conversationId`, `r2Key`, `filename`, `mimeType`, `createdAt` | Image lookup-by-id (bytes live in R2)  |
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
POST   /api/onboarding/google            — Queue the Gmail onboarding scan, 202 (Clerk)

GET    /api/admin/users                  — List all users (admin)
GET    /api/admin/users/{userId}         — One user's identity + link status (admin)
GET    /api/admin/github/status          — A user's GitHub install/token check (admin)
```

Admin routes are gated by the `ADMIN_USER_ID` env var. The user list is sourced
from Clerk (`apps/agent-api/src/admin-users.ts`) so every signed-up user appears; it
does no per-user UserDO or GitHub calls. The detail route is the only admin path
that pays for a per-user Clerk `getUser` plus one UserDO read (Telegram link,
Google/onboarding status). Per-request cost tracking was removed with the
container runtime; the Cloudflare AI Gateway now logs per-user model/token/USD
cost, attributed via `cf-aig-metadata`.

`POST /api/onboarding/google` queues a one-shot Gmail scan on the user's DO
(`queueOnboarding`: set status `queued` + arm the alarm, idempotent on the
`googleOnboardingStatus` state machine) and returns 202. The scan runs on the DO
alarm, off Telegram, and seeds the pinned `User` topic. See
[`onboarding.md`](onboarding.md).

The link route accepts the Login Widget callback payload and verifies its HMAC
against `TELEGRAM_BOT_TOKEN` (`apps/agent-api/src/telegram-auth.ts`). See
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
3. For an image, the bytes are downloaded to R2 and an `attachments` row plus a
   text marker are prepared (see Attachments).
4. `UserDO.enqueueTurn` dedupes on `processed_updates`, stores the user
   message (with any marker) and attachment rows, and arms the DO alarm. The
   alarm runs the turn (see Architecture).

The webhook URL and secret are registered with Telegram manually via the Bot
API's `setWebhook` method — see [`telegram-webhook.md`](telegram-webhook.md).

### Attachments

**Images** are supported via an on-demand `view_attachment` tool. Image bytes
never ride in the conversation history (they would cost ~1,600 tokens every turn
they stayed in context, and could not persist at their real position across a
re-flattened turn). Instead:

1. On an image message the webhook downloads the bytes
   (`downloadTelegramFile`), enforces a ~5 MB cap, and puts them in the
   `ATTACHMENTS` R2 bucket under `attachments/{clerkUserId}/{file_unique_id}`
   (per-user prefix so a user's files list/delete together; the unique-id
   component makes duplicate webhooks idempotent). It persists an `attachments`
   metadata row and enqueues the turn with a text marker appended to the message
   body: `[image "cat.jpg" id=att_abc]`.
2. The interface agent calls `view_attachment(id)` when it needs to see an
   image; the tool resolves the id to R2 bytes (user-scoped via the DO) and
   returns them inside an intra-turn `tool_result` image block.
3. Across turns only the marker persists (tool results are stripped), so a later
   reference re-fetches by id. Images are billed only on turns where they are
   viewed.

The `AttachmentStore` port (`apps/agent-api/src/attachments/types.ts`) abstracts the
bytes: `createR2Attachments` in prod, an in-memory adapter in tests.
`deleteAllForUser` (wired into Telegram unlink) removes every object under the
user's prefix. The bot token stays in the download URL and never reaches
Anthropic.

**Non-image attachments** (PDF, audio, video, voice, stickers, documents) stay
out of scope: an attachment-only message gets a short notice and is skipped; a
message with both text and such a file is processed as text with a notice that
the file was ignored.

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

- Always go through the `log` / `logError` helpers in `apps/agent-api/src/log.ts`.
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

Prompt caching (system prefix, tool schemas, and conversation history) is
documented in [caching.md](./caching.md).

## Future Work

- Support non-image attachments (PDF, audio, video) through the same
  `view_attachment` path once their `tool_result` serialization is verified.
- Consider structured multi-turn history for the research and learning agents
  (they currently use the single-`prompt` path).
- An R2 lifecycle expiry rule for attachment objects.
- Generalise off-Telegram agent runs (crons, workflows, email triggers) once the
  shapes are known; Google onboarding is the first, deliberately minimal, one
  (see [`onboarding.md`](onboarding.md)).
- Add an in-app cost view sourced from the AI Gateway logs
  (`env.AI.gateway(id).getLog`, or the gateway REST API).
- Per-user model preference + a switching API.
- Surface topic/conversation history in the web UI for browsing/export.
