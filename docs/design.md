# Zero — Design Document

## Summary

**Zero runs each Telegram message as a self-contained agent turn inside one
per-user Durable Object (`UserDO`), which owns all of that user's state and runs
the turn on an alarm.** The web frontend only links a Clerk account to a Telegram
id; from then on the webhook routes, enqueues, and returns 200 immediately, and
everything expensive happens later on the DO alarm. That single choice — one
Durable Object per user, the turn as an alarm over local SQLite — is what makes
replies durable, resumable, and strongly consistent with no container and no
per-user filesystem.

This document is the single source of truth for the model and LLM transport
(see [LLM path](#llm-path)); [`topics.md`](topics.md) owns the topic model and
the agents, [`framework.md`](framework.md) the layered worker structure, and
[`caching.md`](caching.md) prompt caching.

## Key design decisions

Everything below is detail under these five decisions:

1. **The webhook enqueues each message and answers 200 immediately; a DO alarm
   produces the reply.** The webhook resolves the user, dedupes, and enqueues; the
   alarm runs the turn. A slow model call runs on the alarm, so it never holds the
   webhook open. See [How a message becomes a turn](#how-a-message-becomes-a-turn).
2. **The turn is one agent loop over ports.** The interface agent, the learner,
   and onboarding are the same runner with different prompts and toolsets, and
   they depend only on ports (`Store`, `WebSearch`, `GoogleWorkspace`,
   `AgentModel`), so they are unit-tested off the platform. See [The turn](#the-turn).
3. **All durable state is the `UserDO` SQLite; KV is only an identity cache.**
   Topics, conversations, messages, and file metadata live in the DO; KV holds
   one reverse-lookup key. See [State model](#state-model).
4. **Work that needs its own alarm gets its own Durable Object.** A DO has exactly
   one alarm, so turn draining, scheduling, and learning are split across
   `UserDO`, `ScheduleDO`, and `LearningDO`. See [Durable Objects](#durable-objects).
5. **The LLM path is provider-neutral and content-free at the edges.** pi-ai over
   the Cloudflare AI Gateway (BYOK) routes by model id alone, per-user attribution
   rides on gateway metadata, and no log line carries message content. See
   [LLM path](#llm-path) and [Logging](#logging).

## How a message becomes a turn

A message is linked, routed, enqueued, and answered on an alarm. The web frontend
uses Telegram's [Login Widget](https://core.telegram.org/widgets/login) to link a
Clerk account to a Telegram numeric id (HMAC-verified server-side against the bot
token). Each later message is resolved to that user (KV cache, authoritative
`TelegramAccountDO` on a miss), passed to `UserDO.enqueueTurn` (dedupe the
update, store the user message, arm a DO alarm), and acknowledged with 200. The
alarm then runs the turn:

1. **Interface agent** reads recent conversation history and a topic-based
   knowledge model (DO SQLite) and replies to the user. There is no `reply` tool:
   the model's own text blocks are the messages, delivered as it writes them, so
   progress is live. It tracks every topic it reads or writes.
2. **Learning** consolidates durable knowledge into the accessed topics later,
   off the turn path, in `LearningDO` (see [`topics.md`](topics.md)).

A self-rescheduling `setTimeout` drives the Telegram typing action across the
interface phase and stops when the reply is sent, which ends the turn.

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
│      2. tgId → clerkUserId: KV, then TelegramAccountDO on a miss │
│         (drop unknown)                                           │
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
│  │         1. interface agent — topic + web_search/read_page +   │
│  │            set_timezone + Gmail/Calendar tools                 │
│  │            (each reply persisted before it is sent)            │
│  │      (consolidation happens later, in LearningDO)             │
│  └─ send: grammY bot.api.sendMessage(…, { message_thread_id })   │
│                                                                  │
│  LLM: pi-ai → {AI Gateway}/openai/responses (BYOK)               │
│    cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>             │
│    cf-aig-metadata: {"user_id": <clerkUserId>}                   │
└──────────────────────────────────────────────────────────────────┘
```

### Webhook flow

The webhook is built on grammY via its `hono` adapter (`webhookCallback`).
grammY validates the secret-token header against `TELEGRAM_WEBHOOK_SECRET`,
parses the `Update`, and dispatches to bot middleware. The middleware accepts
**forum topic messages**, **DMs** and **ordinary group messages**, including a
forum's General tab; anything without a topic uses topicId=0. The `/new` command
resets the conversation thread for a `(chatId, topicId)` (topics are left
intact). The `/start` command runs a normal turn on a user's first contact so
Zero introduces itself, and answers with a short ack on every later `/start`; an
unlinked sender is told where to sign in (see
[`telegram-login.md`](telegram-login.md)).

A regular message with text/caption is enqueued and returns 200 to Telegram
immediately. The background task:

1. `resolveContext` keeps topic messages, and maps any other private, group or
   supergroup chat to topicId=0; channel posts are dropped.
2. Resolve `telegramId` → `clerkUserId` (KV cache, `TelegramAccountDO` on a
   miss); drop the message if neither knows it.
3. For any downloadable file under 20 MB, the route resolves Telegram's file,
   downloads the bytes, and hands canonical metadata plus bytes to UserDO.
4. `UserDO.enqueueTurn` saves through `UserFileStore`, appends the canonical
   marker, dedupes the update, queues the message, and arms the DO alarm. The
   alarm runs the turn.

The webhook URL and secret are registered with Telegram manually via the Bot
API's `setWebhook` method — see [`telegram-webhook.md`](telegram-webhook.md).

## The turn

The three agents are one runner instantiated three ways, each depending on ports
so it runs off the platform. `agents/run.ts` (`model + system + (prompt | messages) +
tools → final text`) is the interface agent, the learner, and onboarding, each
with different system prompts and toolsets. The interface agent's returned text
is ignored (its output is the `{ replies, accessed }` collected by its tool
closures); it investigates the web in its own loop with `web_search` and
`read_page`, no nested agent involved, inline in the turn's DO alarm. See
[`topics.md`](topics.md) and [`research.md`](research.md).

The agents and the turn orchestrator (`apps/agent-api/src/agents/*`) depend only on the
`Store` port (`apps/agent-api/src/store/types.ts`), a model factory
(`agents/model.ts`), a `WebSearch` port (`apps/agent-api/src/websearch/types.ts`), and a
`GoogleWorkspace` port (`apps/agent-api/src/google/types.ts`); the DO and do-orm stay out of reach.
They are unit-tested with an in-memory store, a scripted mock model, and
in-memory search/Google adapters; `UserDO` supplies the production `DbStore`,
`createBraveSearch`, and `createGoogleWorkspace` (with a memoized Clerk token
provider) adapters and the alarm-driven execution.

### Structured message history (interface agent)

The interface agent builds a real multi-turn conversation
(`buildConversationMessages` in `agents/interface.ts`), so each turn extends the
cacheable prefix instead of rewriting a single flattened blob. The split is
deliberate:

- **System prompt** carries everything that is instruction or stable reference,
  not a turn: agent instructions and the pinned-topics block. The datetime
  anchor is not there; it is volatile, so it rides on the current user message
  (see `docs/caching.md`).
- **`messages`** carries only the Telegram dialogue: each stored user/assistant
  message as a native turn, ending with the current user message. The tool loop
  appends the assistant response and one `tool_result` turn per step during the
  run. The current user message also carries the volatile per-turn context:
  current time, timezone, and the user's country code with its country name (or
  "not set"), which sits after the cache anchor by construction.

Each user message is prefixed with an absolute timestamp `[YYYY-MM-DD HH:MM]` in
the user's timezone (stable turn-to-turn, cache-friendly); assistant messages are
verbatim. Rendering is **append-only**: one stored row becomes one wire message,
in id order, never merged, reordered, or dropped. That is what keeps turn N's
request a byte prefix of turn N+1's, so nothing appended later can change a
position the cache already covers. (Until 2026-08-01 the renderer coalesced
consecutive same-role turns and dropped leading assistant turns; both dated from
the pre-SDK proxy era and neither is required — the API states that consecutive
same-role turns are combined server-side, and a leading assistant turn is
accepted.) The one real ordering rule, that `tool_result` blocks must directly
follow the `tool_use` they answer, holds by row order alone: a message arriving
mid-run waits in `pendingMessages` and only becomes a row at the loop's idle
point.

Assistant responses and tool results are persisted **verbatim**, including
`thinking` blocks and their signatures, so a resumed turn can hand the model back
its own reasoning. Only `text` blocks are ever delivered to Telegram, and neither
the learner nor compaction sees anything but text. The learning and onboarding
agents still use the single-`prompt` path.

### Reasoning effort

Every agent runs `MODEL_ID` at the default `high` reasoning effort (resolved in
`resolveModelSpec`, see [LLM path](#llm-path)), and persists the reasoning
signature without the reasoning prose. That includes the background agents: the
learner and compaction decide what Zero remembers about a user, which is the
judgement call whose mistakes last longest. Reasoning makes learner slices
slower, which the slice contract already absorbs (bounded steps per alarm, wire
log persisted as it goes, a slice lost to wall time retried from where it
stopped). Effort is left at the API default `high`, which is where Zero has
always run.

## LLM path

**LLM calls go through the Cloudflare AI Gateway (BYOK) over pi-ai, and the model
id alone decides the provider.** The gateway stores the real provider key and the
provider bills us directly; requests are authenticated with `cf-aig-authorization`
and tagged per user with `cf-aig-metadata`. The model is `MODEL_ID`
(`gpt-5.6-luna`, on the OpenAI Responses API). The model and its reasoning effort
resolve together in one place (`resolveModelSpec`), on pi-ai's provider-neutral
effort scale (default `high`). pi-ai's built-in `cloudflare-ai-gateway` provider
owns the transport and routes by the model's own `api`, so `MODEL_ID` alone
decides where traffic goes and a rollback to a Cloudflare-gateway catalog id such
as `claude-sonnet-4.6` (dotted, Anthropic Messages wire) needs no code change.

Usage is accounted per execution, as an estimate. Each completed agent execution
writes one aggregate call/token/cost point to the `AI_USAGE` Analytics Engine
dataset, indexed by Clerk user and attributed to its agent and conversation when
one exists. The estimate can be sampled, retains about three months of history,
and can miss an execution interrupted by a hard isolate reset; AI Gateway logs
remain the request-level debugging source.

## State model

**Per-user data lives in a `UserDO` Durable Object (source of truth, SQLite via
[do-orm](https://github.com/juanibiapina/do-orm)); Workers KV holds only a cache
of the Telegram→Clerk reverse lookup used to route incoming messages.** Durable
state is the DO SQLite (topics, conversations, messages, file metadata); file
bytes live in the `FILES` R2 binding. There is no container and no per-user
filesystem.

### KV (bootstrap)

| Key               | Value          | Written by                | Read by                  |
|-------------------|----------------|---------------------------|--------------------------|
| `tg:{telegramId}` | `clerkUserId`  | `POST /api/telegram-link` | webhook (route messages) |

This entry is a cache of `TelegramAccountDO`, which is the authoritative record
of which Clerk user a Telegram account belongs to and answers whenever KV misses
(KV's per-colo negative caching would otherwise hide a fresh link for a minute).
Both stores are behind `telegram/identity.ts` and are kept in sync by the
link/unlink routes. See [`telegram-login.md`](telegram-login.md).

The settings route resolves country from the signed-in device request, preferring
Cloudflare's `cf.country`, then the browser locale region, then leaving it unset.
It never reads country from a Telegram webhook because that request originates
from a Telegram datacenter rather than the user's device.

### UserDO (per-user, addressed by `idFromName(clerkUserId)`)

| Table               | Columns                                                        | Purpose                                        |
|---------------------|---------------------------------------------------------------|------------------------------------------------|
| `telegram_link`     | `id`, `telegramId`                                            | The user's linked Telegram account (≤1 row)    |
| `user_settings`     | `id`, `onboardingSeen`, `googleOnboardingStatus`, `createdAt`, `timezone`, `country` | Web onboarding + settings                      |
| `topics`            | `id`, `name`, `description`, `body`, timestamps, `messageCount` | The knowledge model (see [`topics.md`](topics.md)) |
| `knowledge`         | `id`, `version`, `systemFingerprint`                         | The knowledge version guarding topic writes    |
| `conversations`     | `id`, `chatId`, `topicId`, `createdAt`, `compactedThroughMessageId`, `summary` | One thread per Telegram (chatId, topicId); the last two are the non-destructive compaction boundary |
| `messages`          | `id`, `conversationId`, `role`, `kind`, `content`, `stopReason`, `responseId`, `consolidatedAt`, `createdAt` | The conversation's protocol log: `content` is a JSON array of wire-format content blocks; `responseId` is the model's own id, chained into the next turn's cache diagnostics |
| `pending_messages`  | `id`, `conversationId`, `content`, `createdAt`, `injectedAt` | Telegram messages queued until a turn injects them |
| `deliveries`        | `messageId`, `blockIndex`, `claimedAt`                       | Assistant text blocks already handed to Telegram |
| `learning_jobs`     | `jobId`, `highWaterMessageId`, `startedAt`, `completedAt` | One consolidation run's frozen input range; completion is idempotent by job id |
| `external_calls`    | `toolUseId`, `tool`, `status`, `result`, `startedAt`, `completedAt` | Irreversible outbound calls (send mail, create event), claimed before the request leaves |
| `files`             | `id`, `storageKey`, `filename`, `mimeType`, `byteSize`, `createdAt` | User-owned file metadata (bytes live in R2) |
| `processed_updates` | `updateId`, `createdAt`                                       | Webhook idempotency                            |

The `telegram_link` table is the source of truth for the Clerk→Telegram
direction. `GET /api/telegram-id` reads directly from the DO. The reverse
direction is owned by `TelegramAccountDO`, with the KV `tg:` entry as its cache;
both are synced on write.

## Durable Objects

**A Durable Object has exactly one alarm, so work that needs its own alarm gets
its own object**, all keyed by the same Clerk user id. `UserDO` and
`TelegramAccountDO` are below; `ScheduleDO` and `LearningDO`, which carry the
scheduling and learning alarms off the turn path, are detailed in
[`topics.md`](topics.md) and [`schedules.md`](schedules.md).

| DO | Purpose | Storage |
|---|---|---|
| **UserDO** | Per-user data store and turn runner. One instance per Clerk user (`idFromName(clerkUserId)`). Owns the Telegram link, settings, and the topic model, and runs the agent turn on a DO alarm. | SQLite via do-orm |
| **TelegramAccountDO** | One instance per Telegram account (`idFromName(telegramId)`). Owns that account's claim on a Zero user, and answers the webhook's lookup whenever the KV cache misses. | `ctx.storage` (one key) |

## HTTP surface

### Routes

```
GET    /api/telegram-id                  — Read caller's Telegram id (Clerk)
POST   /api/telegram-link                — Link via Login Widget payload (Clerk)
DELETE /api/telegram-id                  — Unlink caller's Telegram id (Clerk)
DELETE /api/user-data                    — Erase everything stored for the caller (Clerk)
POST   /api/webhooks/telegram            — Telegram bot webhook (secret-token auth)
POST   /api/onboarding/google            — Queue the Gmail onboarding scan, 202 (Clerk)

GET    /api/admin/users                         — List all users (admin)
GET    /api/admin/users/{userId}                — One user's identity + link status (admin)
GET    /api/admin/ai-usage                      — AI usage grouped by user (admin)
GET    /api/admin/users/{userId}/ai-usage       — Agent/conversation usage (admin)
GET    /api/admin/github/status                 — A user's GitHub install/token check (admin)
```

Admin routes are gated by the `ADMIN_USER_ID` env var. The user list is sourced
from Clerk (`apps/agent-api/src/admin-users.ts`) so every signed-up user appears;
it does no per-user UserDO or GitHub calls. The identity detail route pays for a
per-user Clerk `getUser` plus one UserDO read (Telegram link and
Google/onboarding status). Usage routes query Analytics Engine separately, so a
query failure cannot prevent the Clerk roster or identity detail from loading.
The SQL adapter validates fixed ranges, escapes request-derived string literals,
and weights calls, tokens, and cost by `_sample_interval`. Unknown models remain
visible as unpriced calls and tokens rather than known zero-cost usage.

`POST /api/onboarding/google` queues a one-shot Gmail scan on the user's DO
(`queueOnboarding`: set status `queued` + arm the alarm, idempotent on the
`googleOnboardingStatus` state machine) and returns 202. The scan runs on the DO
alarm, off Telegram, and seeds the pinned `User` topic. See
[`onboarding.md`](onboarding.md).

`DELETE /api/user-data` erases the caller across all four Durable Objects, KV
and R2, leaving the objects empty rather than re-initialised, and the web app
signs the user out on success. The order the stores are cleared in is the load-
bearing part; see [`data-deletion.md`](data-deletion.md).

The link route accepts the Login Widget callback payload and verifies its HMAC
against `TELEGRAM_BOT_TOKEN` (`apps/agent-api/src/telegram-auth.ts`). See
[`telegram-login.md`](telegram-login.md) for the algorithm, BotFather setup, and
the required `VITE_TELEGRAM_BOT_USERNAME` env var.

### User files

**Files belong to the Zero user alone.** Telegram, Gmail, a conversation, and a
topic only reference them, so `/new`, topic deletion, Telegram unlink, and Google
disconnect all leave saved files intact. `delete_file` removes one file; a full account-data purge
removes all metadata and both new and legacy R2 objects.

`UserFileStore` (`apps/agent-api/src/files/`) is the only module that coordinates
SQLite metadata and R2 bytes. New files use deterministic IDs derived from the
normalized filename, MIME type, and bytes, with objects under
`files/{clerkUserId}/{fileId}`. Save writes R2 first and metadata second. A replay
deduplicates an intact file or repairs a missing object. Migrated `att_*` rows
retain their old `attachments/{clerkUserId}/...` object keys and get their sizes
backfilled lazily from R2.

Each file is capped at 20 MB (Telegram's getFile ceiling is why it is not higher)
and each user at 100 MB. Filename and MIME
normalization, PDF signature validation, quota checks, listing, reads, and
deletion all live behind the same store interface so Telegram, Gmail and Drive follow
the same policy. File bytes never enter SQLite, topic text, durable messages, or
ordinary tool results.

New files use this stable marker:

```text
[file id=file_123 name="report.pdf" mime="application/pdf"]
```

Topics may keep markers as durable references, resolved through `get_file`. A
marker survives an edit because no tool replaces a whole body: text the agent
does not quote is left byte-for-byte. Editing topic text never changes file
ownership. Legacy `[image ...]` and `[pdf ...]` markers and the
`view_attachment` alias remain readable.

The generic tools are `get_file`, `list_files`, `send_file`, and `delete_file`.
`send_file` uses Telegram `sendDocument` in the active topic and requires an
explicit user request. Images use `view_image`, which accepts only JPEG, PNG,
GIF, and WebP before returning a native model image block. PDFs use
`read_pdf(id, start_page, end_page)`, with one-indexed ranges, a 20-page limit,
page-labelled text, and bounded output. Audio, video, voice messages, stickers,
and other documents remain stored, listable, sendable, and deletable even when
Zero has no reader for their content.

## Cross-cutting concerns

### Secrets

Stored in ZeroVault (`zero-api`); see [`secrets.md`](secrets.md) for how each
value is sourced and served. The design-relevant ones:

- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `TELEGRAM_BOT_TOKEN` — used by grammY to authenticate as the bot
- `TELEGRAM_BOT_INFO` — JSON `getMe` result; lets grammY skip the per-request
  `getMe` call (see [`telegram-webhook.md`](telegram-webhook.md))
- `TELEGRAM_WEBHOOK_SECRET` — Telegram secret-token for the webhook URL
- `CLOUDFLARE_API_KEY` — Cloudflare AI Gateway token, sent as
  `cf-aig-authorization`. The gateway injects the stored provider key (BYOK)
  upstream, and the provider bills the usage directly. The non-secret
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID` live in `wrangler.jsonc`
  vars; the `AI` binding resolves the gateway URL.
- `CLOUDFLARE_ANALYTICS_TOKEN` — a separate Cloudflare token with only Account
  Analytics Read, used by admin routes to query the `zero-ai-usage` Analytics
  Engine dataset. The write path uses the `AI_USAGE` binding and does not use
  this token.

Google Workspace access is **not** a stored secret. Each user opts in via the
“Connect Google” button in the web UI (Clerk `createExternalAccount` with the
Workspace scopes). See [`google-workspace.md`](google-workspace.md).

### Logging

**Every log line is a single JSON object on stdout/stderr, content-free.**
Cloudflare's Workers Logs indexer auto-extracts the fields, so the dashboard can
filter on e.g. `service`, `msg`, `clerk_user_id` directly instead of grepping a
message string.

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

### Dev environment

- **5176**: Web frontend (Vite)
- **8790**: API worker (Wrangler)

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

### Tech stack

| Concern | Choice |
|---|---|
| Frontend | React 19, Tailwind v4, shadcn/ui primitives |
| API    | Hono + OpenAPIHono + Zod on Cloudflare Workers |
| State  | UserDO (Durable Object with SQLite via [do-orm](https://github.com/juanibiapina/do-orm)) + Workers KV for identity lookups |
| Agents | Zero-owned tool loop (`agents/run.ts`) over [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) behind the `AgentModel` seam (`agents/model-pi.ts`) |
| LLM    | Cloudflare AI Gateway (BYOK) via pi-ai's built-in `cloudflare-ai-gateway` provider — `gpt-5.6-luna`; model + effort resolve together in `resolveModelSpec` |
| Telegram | [grammY](https://grammy.dev) (`hono` adapter) |
| Secrets | ZeroVault (`zero-api`, `zero-web`) — see [`secrets.md`](secrets.md) |

### Package structure

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

Prompt caching (system prefix, tool schemas, and conversation history) is
documented in [`caching.md`](caching.md).

## Future work

- Add format-specific readers for stored audio and video files.
- Consider structured multi-turn history for the learning agent (it currently
  uses the single-`prompt` path).
- Generalise off-Telegram agent runs (crons, workflows, email triggers) once the
  shapes are known; Google onboarding is the first, deliberately minimal, one
  (see [`onboarding.md`](onboarding.md)).
- Per-user model/effort preference: the decision point already exists
  (`resolveModelSpec`), so a policy plus a switching API on top of it covers this,
  with no new seam.
- Surface topic/conversation history in the web UI for browsing/export.
```