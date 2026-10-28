# Zero — Design Document

## Summary

**`zero-api` is the todo app's server: one Worker that owns each signed-in
account's todo data in a per-user `TaskDO` and its settings in a per-user
`UserDO`.** Mobile and web keep a local replica and synchronize it with
`TaskDO`; REST routes and the MCP server reach the same object. How todo data is
stored and synchronized is owned by [`storage.md`](storage.md), the layered
worker structure by [`framework.md`](framework.md), and the MCP server by
[`mcp.md`](mcp.md).

```
┌─ CF Worker (zero-api) ───────────────────────────────────────────┐
│  /api/task-sync (WebSocket)  ◀── mobile + web replicas            │
│  /api/tasks, /api/projects, /api/waits  ◀── REST clients          │
│  /mcp  ◀── local agents (Clerk OAuth)                             │
│  /api/user-settings, /api/user-data  ◀── mobile + web             │
│  /api/webhooks/clerk  ◀── Clerk (Svix-signed)                     │
│                                                                  │
│  TaskDO (idFromName(clerkUserId)) — todo authority, TinyBase      │
│  UserDO (idFromName(clerkUserId)) — settings, SQLite via do-orm   │
└──────────────────────────────────────────────────────────────────┘
```

## Durable Objects

| DO | Purpose | Storage |
|---|---|---|
| **TaskDO** | The only server authority for the account's Tasks, Projects, Waiting conditions, Afters, Medicines and night routine. See [`storage.md`](storage.md). | TinyBase mergeable store persisted to SQLite |
| **UserDO** | The account's settings: the IANA `timezone` reported by a client, and `createdAt`. MCP reads the timezone to resolve "today". | SQLite via [do-orm](https://github.com/juanibiapina/do-orm), table `user_settings` |

UserDO's SQLite once held the Telegram agent's data. Migration `0058` dropped
those tables; the earlier migrations stay because `migrate` replays them on a
fresh object.

## HTTP surface

```
GET    /api/user-settings     — Read the caller's settings (Clerk)
PATCH  /api/user-settings     — Set the caller's timezone (Clerk)
DELETE /api/user-data         — Erase everything stored for the caller (Clerk)
POST   /api/webhooks/clerk    — Signup notice to Discord (Svix signature)
```

The todo routes (`/api/tasks`, `/api/projects`, `/api/waits`,
`/api/task-sync`, `/api/task-recoveries`) live in `apps/zero-api/src/routes/`;
their OpenAPI definitions sit next to each handler.

`DELETE /api/user-data` empties TaskDO and UserDO and aborts both, and the web app
signs the user out on success. See [`data-deletion.md`](data-deletion.md).

The first `GET /api/user-settings` for an account seeds its settings row and
writes a `signup` point to the `ANALYTICS` Analytics Engine dataset.

## Cross-cutting concerns

### Secrets

Stored in ZeroVault (`zero-api`); see [`secrets.md`](secrets.md) for how each
value is sourced and served. The Worker needs the Clerk keys and webhook signing
secret, `DISCORD_SIGNUP_WEBHOOK_URL`, `TYPESAFE_API_KEY` (Project and icon
suggestions), `OPENAI_API_KEY` (Recording transcripts) and `ZERO_API_KEY` (error
reporting). `wrangler.jsonc` lists them
under `secrets.required`.

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
  `host`, `len`, `error`, `status`.
- Never log task text or request bodies. Counts and identifiers only.

### Dev environment

- **5176**: Web frontend (Vite)
- **8790**: API Worker (`vite dev` with the Cloudflare Vite plugin)

See [`AGENTS.md`](../AGENTS.md) for CI and deploy instructions.

### Tech stack

| Concern | Choice |
|---|---|
| Frontend | React 19, Tailwind v4, shadcn/ui primitives |
| Mobile | Expo (React Native) |
| API    | Hono + OpenAPIHono + Zod on Cloudflare Workers |
| State  | TaskDO (TinyBase on Durable Object SQLite) and UserDO (SQLite via do-orm) |
| Secrets | ZeroVault (`zero-api`, `zero-web`) — see [`secrets.md`](secrets.md) |
