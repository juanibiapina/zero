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

1. **The webhook hands each message to the user's `AssistantDO` and answers 200
   immediately; Pi Durable produces the reply.** The webhook resolves the user and
   UserDO dedupes and hands the message over with an operation id; the run happens
   in AssistantDO, so a slow model call never holds the webhook open. See
   [How a message becomes a turn](#how-a-message-becomes-a-turn).
2. **Every agent is a Pi Durable session over Zero's tools and ports.** The
   interface agent, the learner, onboarding and admin tasks are extensions of one
   Pi harness with different prompts and toolsets; Pi owns the loop, the
   transcript and recovery. See [The turn](#the-turn) and [`harness.md`](harness.md).
3. **User data is the `UserDO` SQLite; transcripts are Pi's, in `AssistantDO`;
   KV is only an identity cache.** See [State model](#state-model).
4. **Work that needs its own alarm, or its own runtime, gets its own Durable
   Object**: user data in `UserDO`, deadlines in `ScheduleDO`, agents in
   `AssistantDO`. See [Durable Objects](#durable-objects).
5. **The LLM path is provider-neutral and content-free at the edges.** pi-ai over
   the Cloudflare AI Gateway (BYOK) routes by model id alone, per-user attribution
   rides on gateway metadata, and no log line carries message content. See
   [LLM path](#llm-path) and [Logging](#logging).

## How a message becomes a turn

A message is linked, routed, handed over, and answered in AssistantDO. The web
frontend uses Telegram's [Login Widget](https://core.telegram.org/widgets/login)
to link a Clerk account to a Telegram numeric id (HMAC-verified server-side
against the bot token). Each later message is resolved to that user (KV cache,
authoritative `TelegramAccountDO` on a miss), passed to `UserDO.enqueueTurn`
(dedupe the update, save its files, compose its text, submit it to
`AssistantDO` with `tg:<updateId>`), and acknowledged with 200. AssistantDO then
runs the turn on Pi Durable:

1. **Interface agent** reads the chat's transcript and the topic model (over RPC
   to UserDO) and replies to the user. There is no `reply` tool: the model's own
   text blocks are the messages, delivered as each response is committed, so
   progress is live.
2. **Learning** consolidates durable knowledge into topics later, off the turn
   path, as its own Pi session (see [`topics.md`](topics.md)).

The Telegram typing action repeats every 4 seconds while a chat has an
unanswered message.

```
┌─ CF Worker (zero-api) ───────────────────────────────────────────┐
│  POST /api/webhooks/telegram  ◀──────────── Telegram update      │
│    grammY (secret-token) → 200 OK → waitUntil:                   │
│      1. resolveContext: keep topic messages + DMs (topicId=0)    │
│      2. tgId → clerkUserId: KV, then TelegramAccountDO on a miss │
│      3. UserDO.enqueueTurn { updateId, clerkUserId, chatId,      │
│                              topicId, text, files }               │
│                                                                  │
│  UserDO (idFromName(clerkUserId), SQLite via do-orm)             │
│  └─ dedupe, save files, compose text →                           │
│     AssistantDO.submit(chat, text, operationId: tg:<updateId>)   │
│     → markProcessed                                              │
│                                                                  │
│  AssistantDO (idFromName(clerkUserId), Pi Durable + PiHarness)   │
│  ├─ Pi session per chat: generation + tool tasks, checkpointed   │
│  ├─ tools reach UserDO data over RPC (UserDataPort)              │
│  ├─ outbox: claim each committed text block, then sendMessage    │
│  └─ Lifecycle alarm keeps it running and restarts it after a     │
│     crash or deploy                                              │
│                                                                  │
│  LLM: pi-ai → {AI Gateway}/openai/responses (BYOK)               │
│    cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>             │
│    cf-aig-metadata: {"user_id": <clerkUserId>, "agent": ...}     │
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
   marker, composes the text once per update, submits it to AssistantDO, and
   only then marks the update processed (see [`harness.md`](harness.md)).

The webhook URL and secret are registered with Telegram manually via the Bot
API's `setWebhook` method — see [`telegram-webhook.md`](telegram-webhook.md).

## The turn

Every agent is a session in one Pi Durable harness inside AssistantDO, built by
`assistant/harness.ts`: the interface agent, the learner, onboarding and admin
tasks are extensions with their own system prompt and tool set. Pi runs the
tool loop, keeps the transcript, retries model requests and compacts long
chats; Zero supplies the prompts, the tools (`tools/*`, adapted by
`assistant/tools.ts`), hooks for staleness, the current-time line and the step
cap, and Telegram delivery. The interface agent investigates the web in its own
loop with `web_search` and `read_page`. See [`harness.md`](harness.md),
[`topics.md`](topics.md) and [`research.md`](research.md).

The tools depend on ports (`TopicToolStore`, `WebSearch`, `PageFetcher`,
`GoogleWorkspace`, the schedule and mail-watch books, `UserFileStore`), so the
harness definition is unit-tested in node over Pi's in-memory storage and
pi-ai's scripted `faux` model, with in-memory adapters.

### Conversation history (interface agent)

The model sees its own transcript: user messages as text with an absolute
`[YYYY-MM-DD HH:MM]` timestamp in the user's timezone, assistant responses
verbatim (thinking and tool calls included), and tool results. Agent
instructions and pinned topics are the system prompt; the volatile per-turn
context (current time, timezone, country code and name, or "not set") rides on
the newest user message only, so history stays a byte prefix of the next
request (see `docs/caching.md`). Only `text` blocks of a finished response are
ever delivered to Telegram, and neither the learner nor compaction sees
anything but text and tool calls.

### Reasoning effort

Agent calls use `MODEL_ID` at the default `high` reasoning effort (resolved in
`resolveModelSpec`, see [LLM path](#llm-path)). They persist reasoning signatures without the reasoning prose. The
background agents also run at `high`: the
learner and compaction decide what Zero remembers about a user, which is the
judgement call whose mistakes last longest. Zero requests `high` explicitly; the
OpenAI default is `medium`.

## LLM path

**LLM calls go through the Cloudflare AI Gateway (BYOK) over pi-ai, and the model
id alone decides the provider.** The gateway stores the real provider key and the
provider bills us directly; requests are authenticated with `cf-aig-authorization`
and tagged per user with `cf-aig-metadata`. The model is `MODEL_ID`
(`gpt-6-luna`, on the OpenAI Responses API). The model and its reasoning effort
resolve together in one place (`resolveModelSpec`), on pi-ai's provider-neutral
effort scale (default `high`). `assistant/models.ts` registers one gateway
provider per agent label on pi-ai's `cloudflare-ai-gateway` transport, which
routes by the model's own `api`, so `MODEL_ID` alone
decides where traffic goes and a rollback to a Cloudflare-gateway catalog id such
as `claude-sonnet-4-6` (Anthropic Messages wire) needs no code change.

Usage is accounted per model response, as an estimate. Each response writes one
call/token/cost point to the `AI_USAGE` Analytics Engine dataset, indexed by
Clerk user and attributed to its agent and conversation when one exists. The estimate can be sampled, retains about three months of history,
and can miss an execution interrupted by a hard isolate reset; AI Gateway logs
remain the request-level debugging source.

## State model

**Per-user data lives in a `UserDO` Durable Object (source of truth, SQLite via
[do-orm](https://github.com/juanibiapina/do-orm)); agent transcripts live in
Pi Durable's tables in `AssistantDO`; Workers KV holds only a cache of the
Telegram→Clerk reverse lookup used to route incoming messages.** File bytes live
in the `FILES` R2 binding. There is no container and no per-user
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
| `conversations`     | `id`, `chatId`, `topicId`, `createdAt`, `compactedThroughMessageId`, `summary` | One thread per Telegram (chatId, topicId); schedules and watched mail threads point at it. The last two columns are legacy |
| `messages`          | `id`, `conversationId`, `role`, `kind`, `content`, `stopReason`, `responseId`, `consolidatedAt`, `createdAt` | Legacy transcript, frozen since AssistantDO; read only by the import |
| `pending_messages`, `deliveries`, `learning_jobs`, `external_calls` | — | Legacy turn machinery, read only by the one-time import into AssistantDO and dropped in Phase 5 (see [`harness.md`](harness.md)) |
| `files`             | `id`, `storageKey`, `filename`, `mimeType`, `byteSize`, `createdAt` | User-owned file metadata (bytes live in R2) |
| `processed_updates` | `updateId`, `createdAt`                                       | Webhook idempotency                            |

The `telegram_link` table is the source of truth for the Clerk→Telegram
direction. `GET /api/telegram-id` reads directly from the DO. The reverse
direction is owned by `TelegramAccountDO`, with the KV `tg:` entry as its cache;
both are synced on write.

## Durable Objects

**A Durable Object has exactly one alarm, so work that needs its own alarm gets
its own object**, all keyed by the same Clerk user id. `UserDO`, `AssistantDO`
and `TelegramAccountDO` are below; `ScheduleDO`, which carries every deadline, is
detailed in [`schedules.md`](schedules.md).

| DO | Purpose | Storage |
|---|---|---|
| **UserDO** | Per-user data store. One instance per Clerk user (`idFromName(clerkUserId)`). Owns the Telegram link, settings, the topic model, files, schedules and watched mail threads, and hands every message to AssistantDO. | SQLite via do-orm |
| **AssistantDO** | Per-user agent runtime (`idFromName(clerkUserId)`). Runs every agent on Pi Durable through Cloudflare's `PiHarness` and Lifecycle, and delivers replies to Telegram. See [`harness.md`](harness.md). | SQLite: Pi's `pi_*` tables, Lifecycle's jobs, `assistant_*` bookkeeping |
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
from Clerk (`apps/zero-api/src/admin-users.ts`) so every signed-up user appears;
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
against `TELEGRAM_BOT_TOKEN` (`apps/zero-api/src/telegram-auth.ts`). See
[`telegram-login.md`](telegram-login.md) for the algorithm, BotFather setup, and
the required `VITE_TELEGRAM_BOT_USERNAME` env var.

### User files

**Files belong to the Zero user alone.** Telegram, Gmail, a conversation, and a
topic only reference them, so `/new`, topic deletion, Telegram unlink, and Google
disconnect all leave saved files intact. `delete_file` removes one file; a full account-data purge
removes all metadata and both new and legacy R2 objects.

`UserFileStore` (`apps/zero-api/src/files/`) is the only module that coordinates
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

- Always go through the `log` / `logError` helpers in `apps/zero-api/src/log.ts`.
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
- **8790**: API Worker (`vite dev` with the Cloudflare Vite plugin)

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

### Tech stack

| Concern | Choice |
|---|---|
| Frontend | React 19, Tailwind v4, shadcn/ui primitives |
| API    | Hono + OpenAPIHono + Zod on Cloudflare Workers |
| State  | UserDO (Durable Object with SQLite via [do-orm](https://github.com/juanibiapina/do-orm)) + Workers KV for identity lookups |
| Agents | [Pi Durable](https://earendil.com/posts/pi-durable/) in `AssistantDO`, hosted by the Agents SDK's `PiHarness` and Lifecycle, over [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) |
| LLM    | Cloudflare AI Gateway (BYOK) via pi-ai's built-in `cloudflare-ai-gateway` provider — `gpt-6-luna`; model + effort resolve together in `resolveModelSpec` |
| Telegram | [grammY](https://grammy.dev) (`hono` adapter) |
| Secrets | ZeroVault (`zero-api`, `zero-web`) — see [`secrets.md`](secrets.md) |

### Package structure

```
zero/
├── apps/
│   ├── zero-api/        (@zero/api)              — CF Worker: HTTP API, Telegram webhook, UserDO meta-agent
│   └── zero-web/        (@zero/web)              — Vite + React: single Telegram-id form
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