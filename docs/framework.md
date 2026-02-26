# Framework Architecture

This document describes the layered architecture pattern used in this codebase for Cloudflare Workers backends with Durable Objects. The pattern provides clear separation of concerns, testable components, and consistent authorization handling.

## Layer Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Entry Point                             │
│                     (apps/api/src/index.ts)                     │
│                  Worker default export                          │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                          App Layer                              │
│                     (apps/api/src/app.ts)                       │
│         Hono framework, middleware stack, auth context          │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Routes Layer                             │
│                   (apps/api/src/routes/*.ts)                    │
│         OpenAPIHono endpoints, Zod validation                   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Services Layer                            │
│                  (apps/api/src/services/*.ts)                   │
│         Authorization logic, DO orchestration                   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Durable Objects Layer                        │
│                  (apps/api/src/*DO/index.ts)                    │
│         SQLite storage, domain logic, migrations                │
└─────────────────────────────────────────────────────────────────┘

                              ◄───────►
                                  │
┌─────────────────────────────────┴───────────────────────────────┐
│                        Shared Types                             │
│                   (packages/core/src/index.ts)                  │
│         Types shared between frontend and backend               │
└─────────────────────────────────────────────────────────────────┘
```

**Data flows down** through the layers. Each layer only calls the layer directly below it. Responses flow back up.

---

## Entry Point

**Reference:** `apps/api/src/index.ts`

The entry point is the Cloudflare Worker's default export. It creates the Hono app and delegates all request handling to it.

```typescript
import { createApp } from "./app";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return createApp().fetch(req, env, ctx);
  },
};

export { UserDO } from "./UserDO";
export { ProjectDO } from "./ProjectDO";
export { SessionDO } from "./SessionDO";
export { AgentContainer } from "./AgentContainer";
```

Durable Object classes are re-exported here so the Worker runtime can find them.

---

## App Layer

**Reference:** `apps/api/src/app.ts`

The app layer sets up the Hono framework and middleware stack. It's responsible for:

1. **CORS** — Allows requests from the frontend origin
2. **Authentication** — Validates Clerk JWTs
3. **Context setup** — Resolves the authenticated user's UserDO and caches DO references

### Middleware Stack

Middleware executes in order. The stack:

```typescript
const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// 1. CORS
app.use("/api/*", cors({ origin: ["http://localhost:5176"], credentials: true }));

// 2. Health check (no auth)
app.get("/api/health", (c) => c.json({ status: "ok" }));

// 3. Webhook routes (HMAC auth, not Clerk)
app.route("/", createWebhookRoutes());

// 4. Token injection for WebSocket/SSE (query param → header)
app.use("/api/*", async (c, next) => {
  const queryToken = new URL(c.req.url).searchParams.get("token");
  if (queryToken && !c.req.header("Authorization")) {
    // Inject Authorization header so Clerk can validate it
  }
  await next();
});

// 5. Clerk middleware — parses JWT
app.use("/api/*", clerkMiddleware());

// 6. Auth guard — enforces auth, resolves UserDO, caches DO refs
app.use("/api/*", async (c, next) => {
  const auth = getAuth(c);
  if (!auth?.userId) return c.json({ error: "Unauthorized" }, 401);

  c.set("userId", auth.userId);

  // KV lookup → UserDO (auto-create on first request)
  let userDOIdStr = await env.KV.get(`user:${auth.userId}`);
  if (!userDOIdStr) {
    const newId = env.USER_DO.newUniqueId();
    userDOIdStr = newId.toString();
    await env.KV.put(`user:${auth.userId}`, userDOIdStr);
  }

  const userDOStub = env.USER_DO.get(env.USER_DO.idFromString(userDOIdStr));
  c.set("userDOStub", userDOStub);
  c.set("doRefs", await userDOStub.getDOReferences());
  await next();
});
```

### Context Variables

The app defines typed context variables that downstream handlers can access:

```typescript
type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

// In a route handler:
const userId = c.get("userId");
const userDO = c.get("userDOStub");
const doRefs = c.get("doRefs");
```

---

## Routes Layer

**Reference:** `apps/api/src/routes/*.ts` | **Full guide:** [`docs/routes.md`](routes.md)

Routes define HTTP endpoints using OpenAPIHono with Zod schemas for request/response validation. Each route file has **schemas at the top** and a **factory function** containing colocated route definitions and handlers.

### Colocated Route Definitions

Each `createRoute()` call lives immediately before its `router.openapi()` handler. This keeps the OpenAPI spec and its implementation as a single visual unit:

```typescript
export const createSessionRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List sessions ────────────────────────────────────────────────────

  const listSessionsRoute = createRoute({
    method: "get",
    path: "/api/sessions",
    tags: ["Sessions"],
    summary: "List sessions",
    request: { query: ListSessionsQuerySchema },
    responses: {
      200: {
        content: { "application/json": { schema: SessionListResponseSchema } },
        description: "List of sessions",
      },
    },
  });

  router.openapi(listSessionsRoute, async (c) => {
    const { owner, repo } = c.req.valid("query");
    const service = new SessionService(c.env, c.get("userId"));
    const filter = owner && repo ? { owner, repo } : undefined;
    return c.json(await service.listSessions(filter), 200);
  });

  return router;
};
```

### Organization

- **Modular files** — Grouped endpoints go in `routes/*.ts` and are mounted via `app.route()`

```typescript
// In app.ts
app.route("/", createSessionRoutes());
app.route("/", createProjectRoutes());
app.route("/", createProviderRoutes());
```

### Key Rule: Routes Never Call DOs Directly

Routes instantiate a service with the authenticated user ID and delegate all business logic:

```typescript
// ✅ Correct
const service = new SessionService(c.env, c.get("userId"));
const result = await service.createSession(owner, repo);

// ❌ Wrong — bypasses authorization
const sessionDO = env.SESSION_DO.get(id);
const session = await sessionDO.getSession();
```

---

## Services Layer

**Reference:** `apps/api/src/services/session.ts`

Services handle authorization and orchestrate operations across multiple Durable Objects. They're the single point of entry for business logic, used by HTTP routes.

### Authorization Patterns

Services implement authorization as private helper methods:

```typescript
class SessionService {
  constructor(private env: Env, private callerId: string) {}

  private async getUserDO(): Promise<{
    userDO: DurableObjectStub<UserDO>;
    userDOId: string;
  }> {
    const userDOIdStr = await this.env.KV.get(`user:${this.callerId}`);
    if (!userDOIdStr) throw new Error("User not found in KV");
    return {
      userDO: this.env.USER_DO.get(this.env.USER_DO.idFromString(userDOIdStr)),
      userDOId: userDOIdStr,
    };
  }

  private async requireSessionAccess(sessionId: string) {
    const { userDO, userDOId } = await this.getUserDO();
    const sessionRow = await userDO.getSessionById(sessionId);
    if (!sessionRow) {
      return Result.fail({ message: "Session not found", code: "NOT_FOUND" });
    }
    return Result.succeed({ userDO, userDOId });
  }
}
```

### Orchestration

Services coordinate operations across multiple DOs:

```typescript
async deleteSession(id: string) {
  // Authorization
  const access = await this.requireSessionAccess(id);
  if (Result.isFailure(access)) return access;
  const { userDO } = access.value;

  // Full teardown: stop container, clean R2 snapshot, clear DO storage
  const sessionDO = this.env.SESSION_DO.get(this.env.SESSION_DO.idFromString(id));
  await sessionDO.destroySession();

  // Remove from UserDO index
  await userDO.removeSession(id);

  return Result.succeed({ ok: true });
}
```

### Result Types

Services return typed results using a Result monad pattern (via `@praha/byethrow`):

```typescript
type ServiceError<C extends string = string> = {
  message: string;
  code: C;
};

// Success
return Result.succeed(session);

// Failure
return Result.fail({ message: "Session not found", code: "NOT_FOUND" });

// Usage in routes
const result = await service.deleteSession(id);
return serviceResult(c, result, 200);
```

---

## Durable Objects Layer

**Reference:** `apps/api/src/UserDO/index.ts`, `apps/api/src/SessionDO/index.ts`

Durable Objects provide persistent storage and domain logic. Each DO instance is keyed by an ID and maintains its own SQLite database.

### Structure

```
UserDO/
├── index.ts       # DO class with methods
├── db/
│   ├── schema.ts  # Drizzle table definitions
│   └── drizzle/
│       ├── *.sql          # Migration files
│       ├── migrations.js  # Auto-generated import bundle
│       └── meta/          # Drizzle metadata
```

### DO Class Pattern

```typescript
export class UserDO extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });

    void ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations as MigrationConfig);
    });
  }

  // Pure data operations — no authorization checks
  async getSession(): Promise<SessionMeta | null> {
    const row = this.db.select().from(sessionMetaTable).get();
    if (!row) return null;
    return { ... };
  }
}
```

### Key Characteristics

1. **One instance per entity** — Each session has its own SessionDO, each user has their own UserDO
2. **No authorization** — DOs trust their callers (services handle auth)
3. **Pure domain logic** — Business rules and data consistency
4. **SQLite + Drizzle** — Type-safe queries with ORM

### Accessing DOs

All DOs use `newUniqueId()` for placement near the user. Lookup goes through KV → UserDO:

```typescript
// KV bootstrap: user:{clerkUserId} → UserDO ID
const userDOIdStr = await env.KV.get(`user:${userId}`);
const userDO = env.USER_DO.get(env.USER_DO.idFromString(userDOIdStr));

// UserDO stores references to other DOs
const refs = await userDO.getDOReferences();
```

### Migration Pattern

Migrations are bundled into the worker code and run automatically:

```typescript
ctx.blockConcurrencyWhile(async () => {
  migrate(this.db, migrations as MigrationConfig);
});
```

See `docs/migrations.md` for the full migration workflow.

---

## Shared Types

**Reference:** `packages/core/src/index.ts`

The core types package defines TypeScript types shared between frontend and backend:

```typescript
// packages/core/src/index.ts
export type SessionStatus =
  | "connecting" | "idle" | "starting" | "resuming"
  | "running" | "stopped" | "error";

export type SessionClientMessage =
  | { type: "message"; text: string }
  | { type: "stop" }
  | { type: "steer"; text: string }
  | { type: "ping" };
```

Both the worker and web app import from `@zero/core`:

```typescript
import type { SessionStatus, SessionClientMessage } from "@zero/core";
```

This ensures type consistency across the stack without runtime overhead.
