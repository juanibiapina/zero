// Clerk-authed route for fire-and-forget task execution.
//
// POST /api/tasks accepts a prompt, creates a container session, and
// sends the prompt. The reply is discarded (see handleContainerReply
// guard for type="task" sessions in AgentContainer.ts).

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { fmtErr, log, logError } from "../log";
import { runTask } from "../tasks";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";

type Variables = {
  userId: string;
};

const CreateTaskSchema = z.object({
  prompt: z.string().min(1),
  name: z.string().min(1).optional(),
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
      409: {
        content: { "application/json": { schema: z.object({ status: z.string() }) } },
        description: "Task already running or done",
      },
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
    const { prompt, name } = c.req.valid("json");

    // Named tasks are idempotent: skip if already running or done
    if (name) {
      const userDO = getUserDO(c.env, clerkUserId);
      const settings = await userDO.getSettings();

      if (name === "google-onboarding") {
        const status = settings.googleOnboardingStatus;
        if (status === "running" || status === "done") {
          log("task_skipped", { name, status, clerk_user_id: clerkUserId });
          return c.json({ status }, 409);
        }
        await userDO.setGoogleOnboardingStatus("running");
      }
    }

    try {
      await runTask(c.env, clerkUserId, prompt, name);
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
