import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

type Variables = {
  userId: string;
};

const TaskSchema = z.object({
  id: z.string(),
  text: z.string(),
  showUpDate: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

// A local calendar day, YYYY-MM-DD. The client mints it in the user's timezone.
const ShowUpDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createTasksRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const listRoute = createRoute({
    method: "get",
    path: "/api/tasks",
    tags: ["Tasks"],
    summary: "List the caller's open tasks",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ tasks: z.array(TaskSchema) }),
          },
        },
        description:
          "Open tasks (completedAt IS NULL), oldest first. The due-today date filter is applied client-side.",
      },
    },
  });

  router.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const userDO = getUserDO(c.env, userId);
    const tasks = await userDO.listTasks();
    return c.json({ tasks }, 200);
  });

  const addRoute = createRoute({
    method: "post",
    path: "/api/tasks",
    tags: ["Tasks"],
    summary: "Add a task",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string().uuid(),
              text: z.string().min(1),
              showUpDate: ShowUpDate,
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": { schema: z.object({ task: TaskSchema }) },
        },
        description: "The created task",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Empty text, non-UUID id, or malformed showUpDate",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { id, text, showUpDate } = c.req.valid("json");
    // The client mints the id and re-sends it verbatim on every retry/replay, so
    // the DO dedupes on the id (its primary key) and a lost ACK cannot
    // double-insert.
    const userDO = getUserDO(c.env, userId);
    const task = await userDO.addTask(id, text, showUpDate);
    log("task_added", { clerk_user_id: userId });
    return c.json({ task }, 201);
  });

  const completeRoute = createRoute({
    method: "post",
    path: "/api/tasks/{id}/complete",
    tags: ["Tasks"],
    summary: "Complete a task, removing it from the open list",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ task: TaskSchema }) },
        },
        description: "The task, now completed",
      },
      404: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "No task with that id",
      },
    },
  });

  router.openapi(completeRoute, async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const userDO = getUserDO(c.env, userId);
    const task = await userDO.completeTask(id);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }
    log("task_completed", { clerk_user_id: userId });
    return c.json({ task }, 200);
  });

  return router;
};
