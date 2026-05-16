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
talking to Anthropic. Pi-ai uses its built-in `anthropic` provider; the
API key is read from `process.env.ANTHROPIC_API_KEY`, which `AgentContainer`
injects via `envVars` — but the value pi sees is a **sentinel fake**
(`Z3R0-FAKE-ANTHROPIC_API_KEY`), not the real key. Every container
request to anywhere except `zero.worker` is intercepted by the worker's
catch-all `outbound` handler, which byte-replaces registered fakes with
their real env values before forwarding. The real `ANTHROPIC_API_KEY`
lives only in the worker; if pi exfiltrates its own env, the leaked
string is a useless sentinel. See "Secret proxying" below.

The model is `claude-sonnet-4-5-20250929` with thinking level `high`.
Replies flow back through a separate on-host outbound trick — the
container POSTs to `http://zero.worker/reply` and the worker delivers
via Telegram. The only external egress from the container is to
`api.anthropic.com` and to `<acct>.r2.cloudflarestorage.com` (for the
FUSE-mounted session store, described below).

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
│  │    ANTHROPIC_API_KEY=Z3R0-FAKE-...   (sentinel, not real)     │
│  │    REPLY_URL + R2 temp creds (1h)                             │
│  ├─ outboundByHost["zero.worker"] = handleContainerReply         │
│  └─ outbound = secretProxy.outbound  (catch-all substitution)   │
│                                                                  │
│  pi-ai inside the container:                                     │
│    POST https://api.anthropic.com/v1/messages                    │
│      x-api-key: Z3R0-FAKE-ANTHROPIC_API_KEY                      │
│      │  intercepted on-host by the catch-all handler             │
│      ▼                                                           │
│    secretProxy.outbound:                                         │
│      url/headers/body — byte-replace fake → env.ANTHROPIC_API_KEY │
│      fetch(api.anthropic.com, ...)  (real key, only here)        │
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

### Durable writes

Every write pi makes is durable on R2 before it returns. The entrypoint
passes `--fsync-on-close` to tigrisfs, which forces every `close(2)` to
block until R2 confirms the upload. Pi persists each session entry via
`appendFileSync` (open + write + close), so each entry pays one R2
round-trip and is durable before pi proceeds. This covers crashes,
idle eviction, deploy rollouts, and Cloudflare's Durable Object
code-update reset — by the time any of those tear the container down,
every entry pi has acknowledged is already on R2. Trade-off: ~hundreds
of ms per turn (pi writes 1-3 entries per turn) in exchange for not
losing user-visible state. An earlier `fsync` on the session directory
was a no-op because GeeseFS (tigrisfs's library) does not implement
`FUSE_FSYNCDIR`.

The entrypoint is intentionally minimal: it mounts tigrisfs (which
daemonises after the mount is ready), drops privileges, and `exec`s
node. SIGTERM goes directly to node, which closes its HTTP listener
and exits; in-flight prompts that haven't yet produced a Telegram
reply are dropped (no reply for that turn), but the JSONL on R2
remains consistent.

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
| `topic:{clerkUserId}:{chatId}:{threadId}`    | `sessionId`                                        | `sessions.recordSession`              | `sessions.lookupSessionId`                       |
| `session:{sessionId}`                        | `{ clerkUserId, chatId, messageThreadId }` JSON    | `sessions.recordSession`              | `sessions.lookupSessionRecord`                   |

The `topic:` and `session:` pair is managed as a unit by
`apps/api/src/sessions.ts` — it owns the key formats, the record
schema, and the "create both, delete both" invariant. Both the webhook
route and the container outbound reply handler call into it instead of
touching the keys directly.

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

The worker→container HTTP calls go through `apps/api/src/agent-client.ts`,
which derives a fully-typed [Hono RPC](https://hono.dev/docs/guides/rpc)
client from the contract defined in
`packages/agent-server/src/contract.ts`. URLs, methods, and request /
response shapes are inferred from the shared Zod schemas; the worker
never hand-encodes them.

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

Pi-ai's LLM traffic uses a different mechanism ("Secret proxying",
below): the catch-all `outbound` handler intercepts every container
egress except `zero.worker` and substitutes registered fakes for their
real env values before forwarding to the upstream host. The reply
handler runs inside the Workers runtime with full access to `env` (KV,
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

For the substitution to fire on HTTPS traffic (Anthropic, R2),
`AgentContainer.interceptHttps = true` is required, and the container's
entrypoint installs Cloudflare's MITM CA cert
(`/etc/cloudflare/certs/cloudflare-containers-ca.crt`, mounted at
runtime) into the system trust store and exports `NODE_EXTRA_CA_CERTS`
so both tigrisfs (Go AWS SDK) and node (undici) accept it. Without
this, HTTPS bypasses the catch-all entirely.

Today only `ANTHROPIC_API_KEY` is registered. The R2 temporary
credentials follow a different pattern: they are consumed exclusively
by tigrisfs at mount time, and the entrypoint shell scrubs them from
the environment immediately afterwards. tigrisfs (running as root)
keeps them cached in its own address space for the lifetime of the
daemon, while node — and therefore pi — is execed under the
unprivileged `pi` user via `setpriv`. Because `/proc/<pid>/environ` is
mode `0400` owned by the process, pi cannot read tigrisfs's env to
recover the credentials. The mount itself is published with
`-o allow_other` (and `user_allow_other` in `/etc/fuse.conf`) so the
non-root pi user can still read and write through it. This OS-level
fix removes the only credential currently injected into pi's process
and replaces substitution-on-egress with simple file permissions.

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
  `allowedHosts = ["api.anthropic.com", "zero.worker", "<acct>.r2.cloudflarestorage.com"]`.
- Surface session history (read sessions back out of R2 from the web UI
  for browsing/export).
- Per-user model preference + a switching API. Pi supports
  `session.setModel(…)`; expose a Clerk-gated route to drive it.
- Route Anthropic traffic through AI Gateway later for observability,
  per-user cost accounting, and caching.
