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
│        OpenAPIHono endpoints, Zod validation                  │
└─────────────────────────────────┬─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                Durable Object Layer                           │
│   TaskDO: per-user todo data                                  │
│   UserDO: per-user settings                                   │
└──────────────────────────────────────────────────────────────┘
```

Data flows down. Each layer only calls the one directly below it.

A services layer is intentionally absent for now — routes are thin enough
that they talk directly to the Durable Object stubs from `c.env`. Add
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
export { TaskDO } from "./TaskDO/index";
```

The Durable Object classes must be re-exported so the Workers runtime can find
them — see the Durable Object Layer below.

---

## App Layer

**Reference:** `apps/zero-api/src/app.ts`

Sets up Hono and the middleware stack:

1. **CORS** — for the dev frontend origin.
2. **Public routes** — the Clerk webhook (Svix signature) and the MCP server
   (its own Clerk OAuth check).
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

Routes read `c.get("userId")`.

---

## Routes Layer

**Reference:** `apps/zero-api/src/routes/tasks.ts`

Routes are defined with `OpenAPIHono` + Zod schemas. Each `createRoute()`
sits immediately above its `router.openapi()` handler so the OpenAPI spec
and the implementation read as a single unit.

```typescript
export const createTasksRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const listRoute = createRoute({ ... });
  router.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const tasks = await getTaskDO(c.env, userId).listTasks();
    return c.json({ tasks }, 200);
  });

  return router;
};
```

Routers are mounted in `app.ts` via `app.route("/", createTasksRoutes())`.

## Durable Object Layer

**Reference:** `apps/zero-api/src/TaskDO/index.ts`, `apps/zero-api/src/UserDO/index.ts`

Each signed-in account has one `TaskDO` and one `UserDO`, both addressed by
`idFromName(clerkUserId)` through typed stubs (`getTaskDO`, `getUserDO`).
`TaskDO` is the todo authority (see [`storage.md`](storage.md)); `UserDO`
holds the account's settings (see [`design.md`](design.md)).
