import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

type Variables = {
  userId: string;
};

const Kind = z.enum(["free-text", "task-done", "project-status"]);

const WaitingConditionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: Kind,
  text: z.string().nullable(),
  refId: z.string().nullable(),
  targetStatus: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});

// Waiting conditions: why a project is waiting. Per-user isolated, a sibling of
// the tasks/projects routes. The list returns the open conditions across all
// projects (the client filters by project). See docs/entities/waiting-condition.md.
export const createWaitsRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const listRoute = createRoute({
    method: "get",
    path: "/api/waits",
    tags: ["Waiting conditions"],
    summary: "List the caller's open waiting conditions",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ conditions: z.array(WaitingConditionSchema) }),
          },
        },
        description: "Open conditions (resolvedAt IS NULL), oldest first.",
      },
    },
  });

  router.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const userDO = getUserDO(c.env, userId);
    const conditions = await userDO.listWaitingConditions();
    return c.json({ conditions }, 200);
  });

  const addRoute = createRoute({
    method: "post",
    path: "/api/waits",
    tags: ["Waiting conditions"],
    summary: "Add a waiting condition to a project",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string().uuid(),
              projectId: z.string().uuid(),
              kind: Kind,
              text: z.string().nullable().optional(),
              refId: z.string().nullable().optional(),
              targetStatus: z.string().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": {
            schema: z.object({ condition: WaitingConditionSchema }),
          },
        },
        description: "The created condition",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "A non-UUID id/projectId or an unknown kind",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { id, projectId, kind, text, refId, targetStatus } =
      c.req.valid("json");
    const userDO = getUserDO(c.env, userId);
    const condition = await userDO.addWaitingCondition(id, projectId, kind, {
      text: text ?? null,
      refId: refId ?? null,
      targetStatus: targetStatus ?? null,
    });
    log("waiting_condition_added", { clerk_user_id: userId });
    return c.json({ condition }, 201);
  });

  const resolveRoute = createRoute({
    method: "post",
    path: "/api/waits/{id}/resolve",
    tags: ["Waiting conditions"],
    summary: "Resolve a waiting condition (unblock the project)",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ condition: WaitingConditionSchema }),
          },
        },
        description: "The resolved condition",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No condition with that id",
      },
    },
  });

  router.openapi(resolveRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const userDO = getUserDO(c.env, userId);
    const condition = await userDO.resolveWaitingCondition(id);
    if (!condition) return c.json({ error: "condition not found" }, 404);
    log("waiting_condition_resolved", { clerk_user_id: userId });
    return c.json({ condition }, 200);
  });

  const deleteRoute = createRoute({
    method: "delete",
    path: "/api/waits/{id}",
    tags: ["Waiting conditions"],
    summary: "Delete a waiting condition",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: "Deleted (or already absent)" },
    },
  });

  // Idempotent: a missing row still returns 204, so a replayed offline delete
  // never makes the client's outbox throw and retry forever.
  router.openapi(deleteRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const userDO = getUserDO(c.env, userId);
    await userDO.deleteWaitingCondition(id);
    log("waiting_condition_deleted", { clerk_user_id: userId });
    return c.body(null, 204);
  });

  return router;
};
