# Framework Architecture

The Cloudflare Workers backend is a strict four-layer stack: Entry Point → App →
Routes → Durable Object. Data flows down and each layer calls only the one
directly below it, so a request's path is always the same and every dependency
points one way. The rest of this doc walks each layer.

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

The webhook calls `UserDO.enqueueTurn` (dedupe the update, queue the user
message, arm a DO alarm) and returns 200. The `alarm()` handler is the turn
runner: it drains every conversation that still owes work and runs the
meta-agent turn inside the DO, where the topic tools hit local SQLite and
replies go straight to Telegram via grammY. A self-rescheduling `setTimeout`
drives the Telegram typing action across the interface phase and stops when the
reply is sent; the alarm stays dedicated
to turn scheduling.

### Three Durable Objects per user

All three are keyed by the same Clerk user id, and the split exists for one
reason: **a Durable Object has exactly one alarm**. On 2026-07-29 UserDO's alarm
was shared between turn draining, an admin task and Google onboarding, and a
queued user message waited fifteen minutes behind them.

| Class | Owns | Alarm does |
|---|---|---|
| `UserDO` | user data (SQLite) and interactive turns | drain turns, nothing else |
| `ScheduleDO` | every deadline for the user (idle learning, size learning, later onboarding and admin tasks) | hand due deadlines to `LearningDO` and end |
| `LearningDO` | durable learning-job state and execution | advance one bounded slice of a job, re-arm while work remains |

`ScheduleDO` never awaits learning work, and `LearningDO` never runs a turn, so
neither can delay a reply. Both keep their decision logic in DO-free modules
(`do/schedule.ts`, `do/learning-job.ts`) so it is unit-tested without a Durable
Object, exactly like `do/alarm.ts`. `LearningDO`'s executor is not enabled yet
(Phase 3): today it records and coalesces requests and logs `learn_skipped`,
and advances one bounded slice of a job per alarm.

LearningDO reaches the user's data through the **learning port**
(`learning/types.ts`), because one Durable Object cannot read another's SQLite.
Two adapters implement it — `store-port.ts` over a local `Store` (tests) and
`remote-port.ts` over a UserDO stub (production) — and a shared test suite runs
both, so the boundary is invisible to the learner. Topic reads and writes go
through the same versioned tool module as a turn (`tools/topics.ts` is written
against `TopicToolStore`, whose methods may be sync or async), so there is no
unchecked write path for learning. A stale write crosses the RPC boundary as
data and is rebuilt into a `KnowledgeConflictError` on the far side; thrown, it
would arrive as a plain error and lose which versions collided.

`ctx.waitUntil` is not an option for this work: Cloudflare documents that
`DurableObjectState.waitUntil` does not extend the object's lifetime, so leaving a
multi-minute promise behind after an RPC returns can lose the job.

The agents and the turn orchestrator (`apps/agent-api/src/agents/*`) depend on the
`Store` port (`apps/agent-api/src/store/types.ts`), not on the DO or do-orm, so they
are unit-tested with an in-memory store and a scripted mock model. `UserDO`
supplies the production `DbStore` adapter. LLM access sits behind the
`AgentModel` port (`agents/protocol.ts`), whose only production adapter is
`agents/model-pi.ts` (pi-ai's `cloudflare-ai-gateway` provider, per-user +
per-agent `cf-aig-metadata`). The tool loop itself is Zero's (`agents/run.ts`),
so no SDK type reaches the agents or tools. The model, provider and effort are
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
