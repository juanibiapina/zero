# Framework Architecture

This document describes the layered architecture pattern used for the
Cloudflare Workers backend.

## Layer Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      Entry Point                              │
│                 (apps/api/src/index.ts)                       │
│            Worker default export + DO exports                 │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                        App Layer                              │
│                  (apps/api/src/app.ts)                        │
│        Hono, CORS, Clerk middleware, auth guard               │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                      Routes Layer                             │
│                (apps/api/src/routes/*.ts)                     │
│        OpenAPIHono endpoints, Zod validation, KV access       │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                Container Layer                                │
│              (apps/api/src/AgentContainer.ts)                 │
│        Container DO + outboundByHost (container → worker)     │
└──────────────────────────────────────────────────────────────┘
```

Data flows down. Each layer only calls the one directly below it.

A services layer is intentionally absent for now — routes are thin enough
that they talk directly to KV and the container binding from `c.env`. Add
a `services/` directory when a route needs to coordinate multiple bindings
or apply non-trivial authorization beyond the app-level guard.

---

## Entry Point

**Reference:** `apps/api/src/index.ts`

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

export { AgentContainer } from "./AgentContainer";
export { ContainerProxy } from "@cloudflare/containers";
```

`ContainerProxy` must be re-exported for the container's outbound
handlers to be reachable — see the Container Layer below.

---

## App Layer

**Reference:** `apps/api/src/app.ts`

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

**Reference:** `apps/api/src/routes/telegram.ts`

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

## Container Layer

**Reference:** `apps/api/src/AgentContainer.ts`

`AgentContainer` extends `Container<Env>` from `@cloudflare/containers`. It
hosts `@zero/agent-server`. One container per Clerk user — selected with
`env.AGENT_CONTAINER.getByName(clerkUserId)` — that idles after 5 minutes
of inactivity.

The class wires the **outbound handler** that lets the container deliver
Telegram replies without going through the public internet, and the
constructor injects `ANTHROPIC_API_KEY` into the container's process env
so pi-ai can talk to `api.anthropic.com` directly:

```typescript
constructor(ctx, env) {
  super(ctx, env);
  this.envVars = {
    REPLY_URL: "http://zero.worker/reply",
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  };
}

AgentContainer.outboundByHost = {
  "zero.worker": (req, env) => handleContainerReply(req, env),
};
```

The container `fetch`es `http://zero.worker/reply`; that request never
leaves the machine — the handler runs inside the Workers runtime with
full access to `env` (KV, Telegram bot token) and uses grammY to send
the reply. Pi-ai's LLM calls go directly to `api.anthropic.com` over
normal egress. `index.ts` must re-export `ContainerProxy` for the
outbound interception to work.

For docs and configuration see
<https://developers.cloudflare.com/containers/platform-details/outbound-traffic/>.

## State

All persistent state is in Workers KV:

| Key | Value | Written by | Read by |
|---|---|---|---|
| `clerk:{clerkUserId}` | `telegramId` | `PUT /api/telegram-id` | `GET /api/telegram-id` |
| `tg:{telegramId}` | `clerkUserId` | `PUT /api/telegram-id` | webhook |
| `topic:{clerkUserId}:{chatId}:{threadId}` | `sessionId` | webhook (on session create) | webhook |
| `session:{sessionId}` | `{ clerkUserId, chatId, messageThreadId }` JSON | webhook (on session create) | `outboundByHost["zero.worker"]` |
