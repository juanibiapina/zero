// Clerk-authed route for fire-and-forget task execution.
//
// POST /api/tasks accepts a prompt, creates a container session, and
// sends the prompt. The reply is discarded (see handleContainerReply
// guard for type="task" sessions in AgentContainer.ts).

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { fmtErr, logError } from "../log";
import { runTask } from "../tasks";
import type { Env } from "../types";

type Variables = {
  userId: string;
};

const CreateTaskSchema = z.object({
  prompt: z.string().min(1),
});

const ErrorSchema = z.object({ error: z.string() });

export const createTaskRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const postRoute = createRoute({
    method: "post",
    path: "/api/tasks",
    tags: ["Tasks"],
    summary: "Run a fire-and-forget task",
    request: {
      body: {
        content: { "application/json": { schema: CreateTaskSchema } },
      },
    },
    responses: {
      202: {
        description: "Task accepted",
      },
      500: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Failed to start task",
      },
    },
  });

  router.openapi(postRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const { prompt } = c.req.valid("json");

    try {
      await runTask(c.env, clerkUserId, prompt);
    } catch (err) {
      logError("task_route_failed", {
        clerk_user_id: clerkUserId,
        error: fmtErr(err),
      });
      return c.json({ error: "failed to start task" }, 500);
    }

    return c.body(null, 202);
  });

  return router;
};
