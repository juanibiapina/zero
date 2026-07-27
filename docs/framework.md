# Framework Architecture

This document describes the layered architecture pattern used for the
Cloudflare Workers backend.

## Layer Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      Entry Point                              │
│                 (apps/agent-api/src/index.ts)                       │
│            Worker default export + DO exports                 │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                        App Layer                              │
│                  (apps/agent-api/src/app.ts)                        │
│        Hono, CORS, Clerk middleware, auth guard               │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                      Routes Layer                             │
│                (apps/agent-api/src/routes/*.ts)                     │
│        OpenAPIHono endpoints, Zod validation, KV access       │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                Durable Object Layer                           │
│              (apps/agent-api/src/UserDO/index.ts)                   │
│   per-user SQLite (topics, conversations) + alarm turn runner │
└──────────────────────────────────────────────────────────────┘
```

Data flows down. Each layer only calls the one directly below it.

A services layer is intentionally absent for now — routes are thin enough
that they talk directly to KV and the UserDO stub from `c.env`. Add
a `services/` directory when a route needs to coordinate multiple bindings
or apply non-trivial authorization beyond the app-level guard.

---

## Entry Point

**Reference:** `apps/agent-api/src/index.ts`

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

**Reference:** `apps/agent-api/src/app.ts`

Sets up Hono and the middleware stack:

1. **CORS** — for the dev frontend origin.
2. **Public routes** — health check and the Telegram webhook (which does its
   own secret-token auth).
3. **Clerk middleware + auth guard** — for everything else under `/api/*`.
   The guard verifies the Clerk JWT and stashes `userId` on the Hono context.

```typescript
type Variables = {
  userId: string;
};
```

Routes read `c.get("userId")` and access KV directly via `c.env.KV`.

---

## Routes Layer

**Reference:** `apps/agent-api/src/routes/telegram.ts`

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

**Reference:** `apps/agent-api/src/UserDO/index.ts`

`UserDO` extends `DurableObject<Env>`, one instance per Clerk user
(`env.USER_DO.idFromName(clerkUserId)`, via the typed `getUserDO` stub). It
owns the per-user SQLite (do-orm): the Telegram link, user settings, and the
topic model (topics, conversations, messages) — see [`topics.md`](topics.md).

The webhook calls `UserDO.enqueueTurn` (dedupe the update, store the user
message, arm a DO alarm) and returns 200. The `alarm()` handler is the turn
runner: it drains every thread whose tail is a user message and runs the
meta-agent turn inside the DO, where the topic tools hit local SQLite and
replies go straight to Telegram via grammY. A self-rescheduling `setTimeout`
drives the Telegram typing action across the interface phase and stops when the
reply is sent, before the writer's consolidation runs; the alarm stays dedicated
to turn scheduling.

The agents and the turn orchestrator (`apps/agent-api/src/agents/*`) depend on the
`Store` port (`apps/agent-api/src/store/types.ts`), not on the DO or do-orm, so they
are unit-tested with an in-memory store and a scripted mock model. `UserDO`
supplies the production `DbStore` adapter. LLM access sits behind the
`AgentModel` port (`agents/protocol.ts`), whose only production adapter is
`agents/model.ts` (official `@anthropic-ai/sdk` client, Cloudflare AI Gateway,
per-user + per-agent `cf-aig-metadata`). The tool loop itself is Zero's
(`agents/run.ts`), so no SDK type reaches the agents or tools.

## State

Identity links live in Workers KV; conversation and knowledge state lives in the
per-user `UserDO` SQLite.

| Key | Value | Written by | Read by |
|---|---|---|---|
| `clerk:{clerkUserId}` | `telegramId` | `PUT /api/telegram-id` | `GET /api/telegram-id` |
| `tg:{telegramId}` | `clerkUserId` | `PUT /api/telegram-id` | webhook |

Conversations and topics are keyed by `(chatId, topicId)` inside `UserDO`; there
are no per-session KV keys.
