# Routes

Route files define HTTP endpoints using `createRoute()` from `@hono/zod-openapi` with Zod schemas for request/response validation. This gives us runtime validation and auto-generated OpenAPI documentation.

## File Structure

Each route file has two sections:

1. **Schemas** — Zod schemas for params, bodies, and responses (top of file, outside the factory)
2. **Router** — Factory function containing colocated route definitions + handlers

```typescript
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

// ── Schemas ──────────────────────────────────────────────────────────────

const ItemIdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    description: "Item unique identifier",
  }),
});

const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const ErrorSchema = z.object({
  error: z.string(),
});

// ── Router ───────────────────────────────────────────────────────────────

export const createItemsRouter = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── Get item ────────────────────────────────────────────────────────

  const getItemRoute = createRoute({
    method: "get",
    path: "/api/items/{id}",
    tags: ["Items"],
    summary: "Get item",
    request: {
      params: ItemIdParamSchema,
    },
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
    const { id } = c.req.valid("param");
    // ... handler logic ...
    return c.json(item, 200);
  });

  return router;
};
```

## Colocated Route Definitions

**Each `createRoute()` call lives immediately before its `router.openapi()` handler.** This keeps the OpenAPI spec and implementation as a single visual unit — you never scroll between spec and handler.

```typescript
// ✅ Correct — spec + handler together
const listRoute = createRoute({ ... });
router.openapi(listRoute, async (c) => { ... });

const getRoute = createRoute({ ... });
router.openapi(getRoute, async (c) => { ... });

// ❌ Wrong — specs grouped separately from handlers
const listRoute = createRoute({ ... });
const getRoute = createRoute({ ... });

router.openapi(listRoute, async (c) => { ... });
router.openapi(getRoute, async (c) => { ... });
```

## Validated Inputs

Use `c.req.valid()` instead of raw parsing. The input is validated against the Zod schema and fully typed.

| Instead of | Use |
|---|---|
| `c.req.param()` | `c.req.valid("param")` |
| `c.req.query("key")` | `c.req.valid("query")` |
| `c.req.json<T>()` | `c.req.valid("json")` |

## Mounting

Routers are mounted in `app.ts`:

```typescript
app.route("/", createItemsRouter());
```

## Path Parameter Syntax

OpenAPI routes use `{id}` syntax, not Hono's `:id`:

```typescript
// ✅ OpenAPI route
path: "/api/items/{id}",

// ❌ Wrong — Hono syntax, doesn't work with createRoute
path: "/api/items/:id",
```

## Response Status Codes

Use `as const` on status codes when multiple response types are possible, so TypeScript narrows the return type correctly:

```typescript
return c.json({ error: "Not found" }, 404 as const);
```

## Exceptions

WebSocket upgrades and SSE endpoints don't fit OpenAPI. Keep these as plain Hono routes:

```typescript
router.get("/api/sessions/:id/ws", async (c) => {
  // WebSocket upgrade — not OpenAPI-compatible
});
```
