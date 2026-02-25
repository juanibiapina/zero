# Routes

Route files define HTTP endpoints using `createRoute()` from `@hono/zod-openapi` with Zod schemas for request/response validation. This gives us runtime validation and auto-generated OpenAPI documentation.

## Pattern

Each endpoint has two parts: a **route definition** with Zod schemas, and a **handler** registered via `app.openapi()`.

```typescript
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

// 1. Define schemas
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

// 2. Define route
const getItemRoute = createRoute({
  method: "get",
  path: "/api/items/{id}",       // OpenAPI uses {id}, not :id
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

// 3. Register handler
app.openapi(getItemRoute, async (c) => {
  const { id } = c.req.valid("param");   // validated + typed
  // ... handler logic ...
  return c.json(item, 200);
});
```

## Validated Inputs

Use `c.req.valid()` instead of raw parsing. The input is validated against the Zod schema and fully typed.

| Instead of | Use |
|---|---|
| `c.req.param()` | `c.req.valid("param")` |
| `c.req.query("key")` | `c.req.valid("query")` |
| `c.req.json<T>()` | `c.req.valid("json")` |

## Router File Structure

Each route file exports a factory function that creates and returns an `OpenAPIHono` router:

```typescript
export const createItemsRouter = () => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ... schemas, route definitions, handlers ...

  return app;
};
```

Mounted in `app.ts`:

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
