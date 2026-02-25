# Framework Architecture

This document describes the layered architecture pattern used in this codebase for Cloudflare Workers backends with Durable Objects. The pattern provides clear separation of concerns, testable components, and consistent authorization handling.

## Layer Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Entry Point                             │
│                        (worker.ts)                              │
│         Sentry wrapping, special route handling                 │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                          App Layer                              │
│                          (app.ts)                               │
│         Hono framework, middleware stack, auth context          │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Routes Layer                             │
│                       (routes/*.ts)                             │
│         OpenAPIHono endpoints, Zod validation                   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Services Layer                            │
│                      (services/*.ts)                            │
│         Authorization logic, DO orchestration                   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Durable Objects Layer                        │
│                        (*DO/index.ts)                           │
│         SQLite storage, domain logic, migrations                │
└─────────────────────────────────────────────────────────────────┘

                              ◄───────►
                                  │
┌─────────────────────────────────┴───────────────────────────────┐
│                        Shared Types                             │
│                       (packages/core)                           │
│         Types shared between frontend and backend               │
└─────────────────────────────────────────────────────────────────┘
```

**Data flows down** through the layers. Each layer only calls the layer directly below it. Responses flow back up.

---

## Entry Point

**Reference:** `apps/worker/src/worker.ts`

The entry point is the Cloudflare Worker's default export. It handles:

1. **Sentry wrapping** — All requests are wrapped with error tracking
2. **Special route handling** — Routes that need different auth (e.g., MCP) are handled before falling through to the main app

```typescript
export default Sentry.withSentry(sentryConfig, {
  async fetch(req, env, ctx) {
    // Handle special routes with different auth
    if (url.pathname === "/mcp") {
      const userId = await validateApiKey(env, authHeader, ctx);
      if (!userId) return unauthorized();
      return createMcpHandler(env, userId)(req, env, ctx);
    }

    // Fall through to main Hono app
    return createApp(env).fetch(req, env, ctx);
  },
});
```

The entry point also handles non-HTTP triggers like email:

```typescript
async email(message, env, ctx) {
  await handleEmail(message, env, ctx);
}
```

---

## App Layer

**Reference:** `apps/worker/src/app.ts`

The app layer sets up the Hono framework and middleware stack. It's responsible for:

1. **Error handling** — Catches errors and reports to Sentry
2. **Authentication** — Validates JWTs or API keys
3. **Context setup** — Sets the authenticated user ID for downstream use

### Middleware Stack

Middleware executes in order. The typical stack:

```typescript
const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// 1. Error handler — catches all errors
app.onError((err, c) => {
  Sentry.captureException(err);
  if (err instanceof HTTPException) return err.getResponse();
  return c.json({ error: "Internal server error" }, 500);
});

// 2. Clerk middleware — parses JWT (but doesn't enforce auth)
app.use("*", clerkMiddleware());

// 3. Auth guard — enforces authentication, sets userId
app.use("/api/*", async (c, next) => {
  // Check API key first
  if (authHeader?.startsWith("Bearer tc:")) {
    const userId = await validateApiKey(env, authHeader, ctx);
    if (userId) {
      c.set("userId", userId);
      return next();
    }
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Fall back to Clerk JWT
  const auth = getAuth(c);
  if (!auth?.userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("userId", auth.userId);
  await next();
});
```

### Context Variables

The app defines typed context variables that downstream handlers can access:

```typescript
type Variables = {
  userId: string;  // Set by auth middleware
};

// In a route handler:
const userId = c.get("userId");
```

---

## Routes Layer

**Reference:** `apps/api/src/routes/*.ts` | **Full guide:** [`docs/routes.md`](routes.md)

Routes define HTTP endpoints using OpenAPIHono with Zod schemas for request/response validation. Each route file has **schemas at the top** and a **factory function** containing colocated route definitions and handlers.

### Colocated Route Definitions

Each `createRoute()` call lives immediately before its `router.openapi()` handler. This keeps the OpenAPI spec and its implementation as a single visual unit:

```typescript
export const createItemsRouter = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── Get item ──────────────────────────────────────────────────────

  const getItemRoute = createRoute({
    method: "get",
    path: "/api/items/{id}",
    tags: ["Items"],
    summary: "Get item details",
    request: { params: ItemIdParamSchema },
    responses: {
      200: {
        content: { "application/json": { schema: ItemSchema } },
        description: "Item details",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Item not found",
      },
    },
  });

  router.openapi(getItemRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const service = new ItemService(c.env, userId);

    const result = await service.getItem(id);
    if (Result.isFailure(result)) {
      return c.json({ error: result.error.message }, 404 as const);
    }
    return c.json(result.value, 200);
  });

  return router;
};
```

### Organization

- **Modular files** — Grouped endpoints go in `routes/*.ts` and are mounted via `app.route()`

```typescript
// In app.ts
app.route('/', createItemsRouter());
app.route('/', createSessionsRouter());
```

### Key Rule: Routes Never Call DOs Directly

Routes instantiate a service with the authenticated user ID and delegate all business logic:

```typescript
// ✅ Correct
const service = new ItemService(c.env, userId);
const result = await service.getItem(id);

// ❌ Wrong — bypasses authorization
const itemDO = env.ITEMDO.get(env.ITEMDO.idFromName(id));
const item = await itemDO.getItem();
```

---

## Services Layer

**Reference:** `apps/worker/src/services/TripService.ts`

Services handle authorization and orchestrate operations across multiple Durable Objects. They're the single point of entry for business logic, used by both HTTP routes and MCP tools.

### Authorization Patterns

Services implement authorization as private helper methods:

```typescript
class TripService {
  constructor(private env: Env, private callerId: string) {}

  // Check if caller has any access to the trip
  private async requireTripAccess(tripId: string): Promise<Result<TripAccess, ServiceError>> {
    const tripDO = this.env.TRIPDO.get(this.env.TRIPDO.idFromName(tripId));
    const member = await tripDO.getMemberByUserId(this.callerId);
    if (!member) {
      return Result.fail({ message: 'Trip not found', code: 'NOT_FOUND' });
    }
    return Result.succeed({ tripDO, role: member.role });
  }

  // Check if caller is the owner
  private async requireOwner(tripId: string): Promise<Result<TripAccess, ServiceError>> {
    const access = await this.requireTripAccess(tripId);
    if (Result.isFailure(access)) return access;
    if (access.value.role !== 'owner') {
      return Result.fail({ message: 'Not authorized', code: 'NOT_AUTHORIZED' });
    }
    return access;
  }

  // Check if caller is the target user or an owner
  private async requireSelfOrOwner(tripId: string, targetUserId: string) { ... }
}
```

### Orchestration

Services coordinate operations across multiple DOs:

```typescript
async deleteTrip(tripId: string): Promise<Result<{ success: true }, ServiceError>> {
  // Authorization
  const access = await this.requireOwner(tripId);
  if (Result.isFailure(access)) return access;

  // Delete from TripDO
  await access.value.tripDO.deleteTrip();

  // Also remove from user's trip list in UserDO
  const userDO = this.env.USERDO.get(this.env.USERDO.idFromName(this.callerId));
  await userDO.removeTrip(tripId);

  return Result.succeed({ success: true });
}
```

### Result Types

Services return typed results using a Result monad pattern:

```typescript
type ServiceError = {
  message: string;
  code: 'NOT_FOUND' | 'NOT_AUTHORIZED' | 'INVALID';
};

// Success
return Result.succeed(trip);

// Failure
return Result.fail({ message: 'Trip not found', code: 'NOT_FOUND' });

// Usage in routes
const result = await service.getTrip(id);
if (Result.isFailure(result)) {
  return c.json({ error: result.error.message }, 404);
}
return c.json(result.value, 200);
```

---

## Durable Objects Layer

**Reference:** `apps/worker/src/TripDO/index.ts`

Durable Objects provide persistent storage and domain logic. Each DO instance is keyed by an ID (e.g., trip ID, user ID) and maintains its own SQLite database.

### Structure

```
TripDO/
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
export class TripDO extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });

    // Run migrations on initialization
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  // Pure data operations — no authorization checks
  async getTrip(): Promise<Trip | null> {
    const tripRow = await this.db.select().from(tripsTable).get();
    if (!tripRow) return null;
    // ... assemble full trip object
    return trip;
  }

  async createTrip(tripId: string, name: string): Promise<void> {
    await this.db.insert(tripsTable).values({ id: tripId, name, ... });
  }
}
```

### Key Characteristics

1. **One instance per entity** — Each trip has its own TripDO, keyed by trip ID
2. **No authorization** — DOs trust their callers (services handle auth)
3. **Pure domain logic** — Business rules and data consistency
4. **SQLite + Drizzle** — Type-safe queries with ORM

### Accessing DOs

DOs are accessed via namespace bindings in the environment:

```typescript
// Get a DO stub by ID
const tripDOId = env.TRIPDO.idFromName(tripId);
const tripDO = env.TRIPDO.get(tripDOId);

// Call methods on the stub
const trip = await tripDO.getTrip();
```

### Migration Pattern

Migrations are bundled into the worker code and run automatically:

```typescript
ctx.blockConcurrencyWhile(async () => {
  await migrate(this.db, migrations);
});
```

See `docs/migrations.md` for the full migration workflow.

---

## Shared Types

**Reference:** `packages/core/src/index.ts`

The core types package defines TypeScript types shared between frontend and backend:

```typescript
// packages/core/src/index.ts
export type Trip = {
  id: string;
  name: string;
  locations: Location[];
  members: TripMember[];
  // ...
};

export type Location = {
  id: number;
  name: string;
  cityId: number | null;
  country: string | null;
};
```

Both the worker and web app import from `@repo/core`:

```typescript
import type { Trip, Location } from '@repo/core';
```

This ensures type consistency across the stack without runtime overhead.

---

## Future Topics

The following areas use this same layered pattern but aren't covered in detail here:

- **Real-time/WebSocket** — `RealtimeDO` for push notifications
- **Email handling** — `email/handler.ts` for processing forwarded emails
- **MCP integration** — `mcp/` for AI assistant tool access
- **Workflows** — `JobWorkflow.ts` for background job processing
