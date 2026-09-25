import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { ProjectAfterConflict } from "../store/project-afters";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";
import { isTaskDOFixture } from "../TaskDO/stub";

type Variables = {
  userId: string;
};

const Kind = z.enum(["free-text", "project-status"]);

const afterConflictMessage: Record<ProjectAfterConflict, string> = {
  "id-conflict": "A different relationship already uses this id.",
  "missing-source": "This project no longer exists.",
  "missing-target": "That project no longer exists.",
  "target-done": "That project is already done.",
  self: "A project cannot be after itself.",
  duplicate: "This After relationship already exists.",
  cycle: "This After relationship would create a loop.",
};

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
  router.use("/api/waits", async (c, next) => {
    if (isTaskDOFixture(c.env, c.get("userId"))) {
      return c.req.method === "GET"
        ? c.json({ conditions: [] }, 200)
        : c.json({ error: "Waiting is not supported for this fixture" }, 409);
    }
    await next();
  });
  router.use("/api/waits/*", async (c, next) => {
    if (isTaskDOFixture(c.env, c.get("userId"))) {
      return c.json({ error: "Waiting is not supported for this fixture" }, 409);
    }
    await next();
  });

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
        description: "Malformed ids, kind, or fields",
      },
      409: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "The After relationship cannot be added",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { id, projectId, kind, text, refId, targetStatus } =
      c.req.valid("json");
    const userDO = getUserDO(c.env, userId);
    if (kind === "project-status") {
      if (
        targetStatus !== "done" ||
        text != null ||
        !refId ||
        !z.string().uuid().safeParse(refId).success
      ) {
        return c.json({ error: "invalid After relationship" }, 400);
      }
      const result = await userDO.addProjectAfter(id, projectId, refId);
      if ("conflict" in result) {
        return c.json({ error: afterConflictMessage[result.conflict] }, 409);
      }
      log("project_after_added", {
        clerk_user_id: userId,
        project_id: projectId,
        ref_id: refId,
      });
      return c.json({ condition: result.relationship }, 201);
    }
    const waitingText = text?.trim();
    if (!waitingText || refId != null || targetStatus != null) {
      return c.json({ error: "invalid waiting condition" }, 400);
    }
    const condition = await userDO.addWaitingCondition(
      id,
      projectId,
      waitingText,
    );
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
