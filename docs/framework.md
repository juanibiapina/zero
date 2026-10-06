# Framework Architecture

The Cloudflare Workers backend is a strict four-layer stack: Entry Point → App →
Routes → Durable Object. Data flows down and each layer calls only the one
directly below it, so a request's path is always the same and every dependency
points one way. The rest of this doc walks each layer.

## Layer Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      Entry Point                              │
│                 (apps/zero-api/src/index.ts)                       │
│            Worker default export + DO exports                 │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                        App Layer                              │
│                  (apps/zero-api/src/app.ts)                        │
│        Hono, CORS, Clerk middleware, auth guard               │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                      Routes Layer                             │
│                (apps/zero-api/src/routes/*.ts)                     │
│        OpenAPIHono endpoints, Zod validation, KV access       │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                Durable Object Layer                           │
│   UserDO: per-user data (topics, settings, files, schedules)  │
│   AssistantDO: every agent, on Pi Durable (see harness.md)    │
└──────────────────────────────────────────────────────────────┘
```

Data flows down. Each layer only calls the one directly below it.

A services layer is intentionally absent for now — routes are thin enough
that they talk directly to KV and the UserDO stub from `c.env`. Add
a `services/` directory when a route needs to coordinate multiple bindings
or apply non-trivial authorization beyond the app-level guard.

---

## Entry Point

**Reference:** `apps/zero-api/src/index.ts`

The entry point is the Worker's default export. It creates the Hono app and
delegates request handling to it, and re-exports the Durable Object classes
so the Worker runtime can find them.

```typescript
import { createApp } from "./app";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return createApp().fetch(req, env, ctx);
  },
};

export { UserDO } from "./UserDO/index";
```

`UserDO` must be re-exported so the Workers runtime can find the Durable
Object class — see the Durable Object Layer below.

---

## App Layer

**Reference:** `apps/zero-api/src/app.ts`

Sets up Hono and the middleware stack:

1. **CORS** — for the dev frontend origin.
2. **Public routes** — health check and the Telegram webhook (which does its
   own secret-token auth).
3. **Clerk middleware + auth guard** — for everything else under `/api/*`.
   The guard verifies the Clerk JWT and stashes `userId` on the Hono context.
   Exception: under `ENVIRONMENT=test` (the hermetic Pixel E2E Worker,
   `wrangler.e2e.jsonc`) the guard skips Clerk and trusts the bearer as the
   `userId`. Production and development never set `ENVIRONMENT=test`, so this
   branch is inert there. See `apps/agent-mobile/README.md` ("End-to-end tests").

```typescript
type Variables = {
  userId: string;
};
```

Routes read `c.get("userId")` and access KV directly via `c.env.KV`.

---

## Routes Layer

**Reference:** `apps/zero-api/src/routes/telegram.ts`

Routes are defined with `OpenAPIHono` + Zod schemas. Each `createRoute()`
sits immediately above its `router.openapi()` handler so the OpenAPI spec
and the implementation read as a single unit.

```typescript
export const createTelegramRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const getRoute = createRoute({ ... });
  router.openapi(getRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const telegramId = await c.env.KV.get(`clerk:${clerkUserId}`);
    return c.json({ telegramId }, 200);
  });

  return router;
};
```

Routers are mounted in `app.ts` via `app.route("/", createTelegramRoutes())`.

## Durable Object Layer

**Reference:** `apps/zero-api/src/UserDO/index.ts`

`UserDO` extends `DurableObject<Env>`, one instance per Clerk user
(`env.USER_DO.idFromName(clerkUserId)`, via the typed `getUserDO` stub). It
owns the per-user SQLite (do-orm): the Telegram link, user settings, files,
schedules, watched mail threads and the topic model — see
[`topics.md`](topics.md).

The webhook calls `UserDO.enqueueTurn` (dedupe the update, save its files,
submit the message to `AssistantDO` with an operation id) and returns 200.
`AssistantDO` runs the turn on Pi Durable, reaches the topic tools' data over
RPC, and sends replies to Telegram via grammY; see [`harness.md`](harness.md).

### Three Durable Objects per user

All three are keyed by the same Clerk user id. **A Durable Object has exactly
one alarm**, and on 2026-07-29 UserDO's alarm was shared between turn draining,
an admin task and Google onboarding, so a queued user message waited fifteen
minutes behind them. The agents also run on a beta runtime that owns its
object's alarm and handlers, which is the second reason they live apart from
user data.

| Class | Owns | Alarm does |
|---|---|---|
| `UserDO` | user data (SQLite): topics, settings, files, schedules, mail threads | only hands a leftover legacy turn to AssistantDO |
| `ScheduleDO` | every deadline for the user (idle learning, reminders, mail polls, wakes, onboarding and admin tasks) | hand due deadlines to their owner and end |
| `AssistantDO` | every agent, on Pi Durable through `PiHarness` and Lifecycle | Lifecycle's job queue: keep running sessions awake, re-run delivery and settlement |

`ScheduleDO` never awaits agent work, so it cannot delay a reply. Its decision
logic lives in a DO-free module (`do/schedule.ts`) so it is unit-tested without
a Durable Object.

AssistantDO reaches the user's data through `UserDataPort`
(`assistant/user-data.ts`), because one Durable Object cannot read another's
SQLite. Topic reads and writes go through the same versioned tool module
everywhere (`tools/topics.ts` is written against `TopicToolStore`, whose methods
may be sync or async), so there is no unchecked write path. A stale write crosses
the RPC boundary as data and is rebuilt into a `KnowledgeConflictError` on the
far side; thrown, it would arrive as a plain error and lose which versions
collided.

`ctx.waitUntil` is not an option for agent work: Cloudflare documents that
`DurableObjectState.waitUntil` does not extend the object's lifetime. Lifecycle's
heartbeat alarm is what keeps a running agent alive and restarts it after an
eviction. See [`harness.md`](harness.md).

UserDO's code depends on the `Store` port (`apps/zero-api/src/store/types.ts`),
not on the DO or do-orm, so it is unit-tested with an in-memory store. The agents'
harness definition (`assistant/harness.ts`) is unit-tested over Pi's in-memory
storage with pi-ai's scripted `faux` model. The model, provider and effort are
owned by `design.md` (Architecture); prompt caching by `caching.md`.

## State

Identity links are cached in Workers KV and owned by Durable Objects
(`UserDO` for the Clerk side, `TelegramAccountDO` for the Telegram side);
conversation and knowledge state lives in the per-user `UserDO` SQLite.

| Key | Value | Written by | Read by |
|---|---|---|---|
| `clerk:{clerkUserId}` | `telegramId` | `PUT /api/telegram-id` | `GET /api/telegram-id` |
| `tg:{telegramId}` | `clerkUserId` | `POST /api/telegram-link` | webhook (cache; falls back to `TelegramAccountDO`) |

Conversations and topics are keyed by `(chatId, topicId)` inside `UserDO`; there
are no per-session KV keys.
