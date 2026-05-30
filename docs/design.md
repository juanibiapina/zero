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
| State  | KV (Workers KV) + UserDO (Durable Object with SQLite via [do-orm](https://github.com/juanibiapina/do-orm)) |
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
│  ├─ fetch() refreshes envVars on every call:                     │
│  │    ANTHROPIC_API_KEY=Z3R0-FAKE-... (env-resolved)             │
│  │    GOOGLE_WORKSPACE_CLI_TOKEN=Z3R0-FAKE-... (runtime; opt-in) │
│  │    CALLBACK_URL + R2 temp creds (1h)                             │
│  ├─ outboundByHost["zero.worker"] = handleContainerReply         │
│  └─ outboundHandlers.substitute = secretProxy.outbound           │
│       (catch-all; per-container overrides via                    │
│        setOutboundHandler('substitute', { overrides }))          │
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

Each Clerk user owns the prefix `<clerkUserId>/` on the shared
`zero-agent-state` bucket. Inside that prefix, top-level sub-prefixes
partition the namespace by scope:

- `<clerkUserId>/sessions/<sessionId>/` — pi session JSONL files
- `<clerkUserId>/notes/`               — the long-term notes vault
  (see [Notes vault](#notes-vault-long-term-memory) below)

New scopes can be added as further siblings (`<clerkUserId>/<scope>/`)
without colliding with the session-id namespace.

For sessions, tigrisfs mounts `<clerkUserId>/sessions/` at the
hard-coded path `/mnt/agent-state`. The agent-server creates one
subdirectory per session id (`/mnt/agent-state/<sessionId>/`) and
hands it to pi as the session directory; pi writes its JSONL file
inside. On container restart, the bridge lazy-loads via
`SessionManager.continueRecent` against the same directory,
transparently resuming the conversation.

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

1. **FUSE root locked to the scope sub-prefix.** `tigrisfs zero-agent-state:<clerkUserId>/sessions /mnt/agent-state` makes the sessions sub-prefix the filesystem root for the sessions mount; pi has no path to traverse out of it (not even sideways into `<clerkUserId>/notes/`, which is reachable only via the separate `/mnt/notes` mount).
2. **Prefix-scoped R2 credentials.** The temp credential is bound to `prefixPaths: ["<clerkUserId>/"]` — covering the whole user prefix so sibling scope mounts can attach with the same token — so even a leaked credential cannot list or read other users' prefixes.

See [`r2-mount.md`](r2-mount.md) for one-time bucket and token setup.

### Notes vault (long-term memory)

Alongside the sessions mount, every container also mounts a per-user
**notes vault** at `/mnt/notes`. This is pi's long-term memory across
conversations; the contract is described in the `AGENTS.md` baked into
`/workspace/AGENTS.md` (see `packages/agent-server/context/AGENTS.md`),
which pi auto-loads at session start.

By default, the notes vault is a Zero-managed R2 prefix
(`<clerkUserId>/notes/`). Users can override this with an external
S3-compatible endpoint via the web UI ("Configure external storage"
under Notes Storage). The configuration is stored in the `UserDO`'s
`mount_configs` table. When present, `resolveMounts` swaps the R2
notes entry for a `MountSpec` using the user's endpoint, bucket,
prefix, and credentials. The entrypoint, `AgentContainer`, and
`flattenMounts` stay untouched — they consume the same `MOUNT_<n>_*`
shape regardless of provider.

User-supplied S3 credentials follow the same privilege-separation
path as R2 temp creds: consumed by tigrisfs (root) at mount time,
scrubbed from the env before node starts, inaccessible to pi.
No sentinel substitution is used — tigrisfs computes SigV4 in-process.

Default (R2) layout:

- Sibling scope under the user prefix: `<clerkUserId>/notes/`
  alongside `<clerkUserId>/sessions/`. Covered by the same
  `prefixPaths: ["<clerkUserId>/"]` temp credential — no additional
  R2 setup or second bucket.
- Same durability flags as the sessions mount (`--fsync-on-close`,
  `--file-mode=0666`, `--dir-mode=0777`, `-o allow_other`). Mount
  failure aborts the container (pi has been promised memory;
  degraded boot would risk silent data loss).
### Mount assembly

Both the sessions mount and the notes vault are produced by a single
seam:

```
apps/api/src/mounts.ts → resolveMounts(env, clerkUserId, creds, notesMountConfig?)
   → MountSpec[]   // ordered list of mounts to bring up
```

`AgentContainer.refreshEnvVars` fetches the user's mount config from
the `UserDO` (`getMountConfig("notes")`) in parallel with R2 temp cred
minting and Google token fetching, then passes it to `resolveMounts`.
The result is flattened into numbered `MOUNT_<n>_*` env groups (`NAME`,
`POINT`, `ENDPOINT`, `BUCKET`, `PREFIX`, `ACCESS_KEY_ID`,
`SECRET_ACCESS_KEY`, `SESSION_TOKEN`) plus a `MOUNT_COUNT`.
`entrypoint.sh` loops over them and fires one `tigrisfs` invocation
per spec; the shell is entirely scope-agnostic.

The sessions mount always uses Zero-managed R2. The notes mount
defaults to R2 but switches to the user's S3 endpoint/bucket/creds
when a `mount_configs` row exists for scope `"notes"`. Each
`MOUNT_<n>_*` group carries its own AWS_* values, so per-invocation
creds in the entrypoint trivially scope to one mount.
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
| `mount_configs`  | `id`, `scope`, `endpoint`, `bucket`, `prefix`, `accessKeyId`, `secretAccessKey` | User-configured S3 mount overrides (one row per scope; only `notes` today) |

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
| **UserDO** | Per-user data store. One instance per Clerk user (`idFromName(clerkUserId)`). Owns the Telegram link, session mappings, and mount configurations. | SQLite via do-orm (`telegram_link`, `sessions`, `mount_configs` tables) |
| **AgentContainer** | Cloudflare Container hosting `@zero/agent-server` (pi-coding-agent). One container per Clerk user (`getByName(clerkUserId)`), idles after 5 minutes. `fetch` mints prefix-scoped R2 temp creds, fetches the user's mount config from UserDO, resolves the user's mounts via `resolveMounts`, and refreshes `envVars` on every call; the container mounts each scope (sessions, notes) via its own tigrisfs invocation. Defines `outboundByHost["zero.worker"]` for the Telegram reply path. Callbacks (reply, close-session) include `clerkUserId` so the worker can address the UserDO for session lookups. | None (sessions and notes live on R2/S3 mounts inside the container) |

## Routes

```
GET    /api/telegram-id                  — Read caller's Telegram id (Clerk)
POST   /api/telegram-link                — Link via Login Widget payload (Clerk)
DELETE /api/telegram-id                  — Unlink caller's Telegram id (Clerk)
GET    /api/mount-config/notes           — Read caller's notes mount config (Clerk)
PUT    /api/mount-config/notes           — Validate and save notes mount config (Clerk)
DELETE /api/mount-config/notes           — Remove notes mount config, revert to R2 (Clerk)
POST   /api/mount-config/notes/validate  — Re-validate saved notes mount config (Clerk)
POST   /api/webhooks/telegram            — Telegram bot webhook (secret-token auth)
```

The link route accepts the Login Widget callback payload and verifies
its HMAC against `TELEGRAM_BOT_TOKEN` (`apps/api/src/telegram-auth.ts`).
See [`telegram-login.md`](telegram-login.md) for the algorithm, BotFather
setup, and the required `VITE_TELEGRAM_BOT_USERNAME` env var.

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
built-in `anthropic` provider, reading `process.env.ANTHROPIC_API_KEY`
— which is a sentinel that the worker's catch-all outbound handler
swaps for the real key on the way out (see “Secret Proxying”). The
model is `claude-sonnet-4-5-20250929` with thinking level `high`.

When pi emits `agent_end`, the container POSTs the final assistant text
to `http://zero.worker/reply` (always, even when the turn produced no
text). That call stays on-host —
`AgentContainer.outboundByHost["zero.worker"]` intercepts it and uses
grammY to send the message back into the same Telegram topic.

While a turn is running, Telegram shows a “typing…” indicator. It is
driven by a `status` column (`idle`/`active`) on the `sessions` row in
`UserDO`: `markSessionActive` flips it on after a message is forwarded
and arms a DO alarm that re-sends the typing action every few seconds
(Telegram's action expires after ~5s). The `/reply` callback runs
`markSessionIdle`, and the alarm self-cancels once no session is
`active`. Because `agent_end` always calls `/reply`, the indicator
reliably stops at the end of every turn (reply, empty turn, abort, or
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

Two categories of registered secret share the same substitution
handler:

- **env-resolved** — real value lives in worker `env`, resolved on
  every outbound. Used for app-wide secrets like `ANTHROPIC_API_KEY`.
- **runtime-resolved** — real value is per-container, pushed via
  `Container.setOutboundHandler('substitute', { overrides })`. The
  framework persists the override map into DO storage and threads it
  through `ContainerProxy` props, where the handler reads it as
  `ctx.params.overrides[name]`. Used for `GOOGLE_WORKSPACE_CLI_TOKEN`,
  which is a per-user OAuth access token fetched live from Clerk in
  `refreshEnvVars`. Pi sees the same constant sentinel in env; the
  substitution swaps in the right token for that user on the way out.
  When the user hasn't connected Google, the sentinel is omitted from
  `envVars` entirely so `gws` exits with a clear auth error rather
  than forwarding a sentinel nothing can substitute.

A third secret class, **per-mount S3 credentials** (carried by every
`MOUNT_<n>_*` env group the worker emits, see
[Mount assembly](#mount-assembly)), follows a privilege-separation
pattern instead of substitution: each tigrisfs invocation (root)
consumes its own `MOUNT_<n>_ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`/
`SESSION_TOKEN` at mount time, the entrypoint shell scrubs every
such trio in a loop, and node is execed under the unprivileged `pi`
user via `setpriv`. `/proc/<pid>/environ` is mode `0400` owned by
the process, so pi cannot recover them by reading tigrisfs's env.
Mounts are published with `-o allow_other` (and `user_allow_other`
in `/etc/fuse.conf`) so the non-root pi user can still read and
write through them. This OS-level fix replaces substitution-on-egress
with simple file permissions for the credentials tigrisfs needs
in-process. Sentinels would be wrong here regardless: tigrisfs
computes SigV4 over the request body, and a mid-flight byte swap on
egress would invalidate the signature.

## Secrets

Stored in Doppler (`zero-api`):

- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `TELEGRAM_BOT_TOKEN` — used by grammY to authenticate as the bot
- `TELEGRAM_BOT_INFO` — JSON `getMe` result; lets grammY skip the per-request
  `getMe` call (see [`telegram-webhook.md`](telegram-webhook.md))
- `TELEGRAM_WEBHOOK_SECRET` — Telegram secret-token for the webhook URL
- `ANTHROPIC_API_KEY` — substituted on egress to `api.anthropic.com` by
  the catch-all outbound handler; pi sees only a sentinel
- `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_PARENT_ACCESS_KEY_ID`,
  `R2_PARENT_SECRET_ACCESS_KEY` — used by `AgentContainer` to mint
  prefix-scoped R2 temp credentials shared across the per-user FUSE
  mounts (sessions, notes) under `<clerkUserId>/`. See
  [`r2-mount.md`](r2-mount.md).

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
  `allowedHosts = ["api.anthropic.com", "zero.worker", "<acct>.r2.cloudflarestorage.com"]`.
- Surface session history (read sessions back out of R2 from the web UI
  for browsing/export).
- Per-user model preference + a switching API. Pi supports
  `session.setModel(…)`; expose a Clerk-gated route to drive it.
- Route Anthropic traffic through AI Gateway later for observability,
  per-user cost accounting, and caching.
