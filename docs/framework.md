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
`fetch` override refreshes `this.envVars` on every incoming call so the
container always boots with fresh per-user credentials:

```typescript
override async fetch(request) {
  await this.refreshEnvVars();   // assemble per-user envVars
  return super.fetch(request);
}

AgentContainer.outboundByHost = {
  "zero.worker": (req, env) => {
    const path = new URL(req.url).pathname;
    if (path === "/message-end") return handleMessageEnd(req, env);
    if (path === "/agent-end") return handleAgentEnd(req, env);
    if (path === "/close-session") return handleCloseSession(req, env);
    if (path === "/state") return handleState(req, env);
    return new Response("not found", { status: 404 });
  },
};
```

`refreshEnvVars` packs `envVars` with `CALLBACK_URL`, the secret
sentinels (`CLOUDFLARE_API_KEY` and, when the user has connected Google,
`GOOGLE_WORKSPACE_CLI_TOKEN`), and `CLERK_USER_ID`. It also fetches a
live Google access token and pushes it — along with the user id used to tag
AI Gateway requests (`cf-aig-metadata`, see [`design.md`](design.md) under
**Secret Proxying**) — to the `substitute` outbound handler. There are no R2
credentials and no mount specs: the container
persists its `/workspace` tree as a single `state.tar.gz` archive
through the worker's `/state` route (see [`design.md`](design.md) under
**Persistence**). The Container base class only restarts the underlying
process when it isn't already running, so a live container keeps its
existing env; the next cold boot picks up the fresh values.

The container `fetch`es `http://zero.worker/message-end` (and
`/agent-end`, `/state`); that request never leaves the machine — the
handler runs inside the Workers runtime with
full access to `env` (KV, Telegram bot token) and uses grammY to send
the reply. Pi-ai's LLM calls route through the Cloudflare AI Gateway
(BYOK) over normal egress. `index.ts` must
re-export `ContainerProxy` for the outbound interception to work.

The reverse direction (worker→container) goes through
`apps/api/src/agent-client.ts`, a Hono RPC client derived from
`@zero/agent-server`'s typed `AppType`. The agent-server defines its
routes once (`OpenAPIHono` + Zod) in
`packages/agent-server/src/contract.ts`; the worker imports the app's
TS type and uses `hc<AppType>` to call it, so URLs, methods, and
request / response shapes are never restated.

For docs and configuration see
<https://developers.cloudflare.com/containers/platform-details/outbound-traffic/>.

## State

All persistent state is in Workers KV:

| Key | Value | Written by | Read by |
|---|---|---|---|
| `clerk:{clerkUserId}` | `telegramId` | `PUT /api/telegram-id` | `GET /api/telegram-id` |
| `tg:{telegramId}` | `clerkUserId` | `PUT /api/telegram-id` | webhook |
| `topic:{clerkUserId}:{chatId}:{threadId}` | `sessionId` | `sessions.recordSession` | `sessions.lookupSessionId` |
| `session:{sessionId}` | `{ clerkUserId, chatId, messageThreadId }` JSON | `sessions.recordSession` | `sessions.lookupSessionRecord` |

The `topic:` and `session:` pair is managed as a unit by
`apps/api/src/sessions.ts`; the webhook route and the container outbound
reply handler both go through it instead of touching the keys directly.
