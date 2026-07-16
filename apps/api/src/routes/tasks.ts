// Clerk-authed task route.
//
// TODO(tasks): the container-backed task runner was removed with the
// container runtime. This is a parked stub that accepts the request and
// no-ops so the web onboarding call keeps working. Reimplement later as a
// meta-agent turn on the DO-alarm runtime.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { log } from "../log";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";

type Variables = {
  userId: string;
};

const CreateTaskSchema = z.object({
  prompt: z.string().min(1),
  name: z.string().min(1).optional(),
});

export const createTaskRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const postRoute = createRoute({
    method: "post",
    path: "/api/tasks",
    tags: ["Tasks"],
    summary: "Run a fire-and-forget task (parked: currently a no-op)",
    request: {
      body: {
        content: { "application/json": { schema: CreateTaskSchema } },
      },
    },
    responses: {
      202: {
        description: "Task accepted (no-op)",
      },
    },
  });

  router.openapi(postRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const { name } = c.req.valid("json");

    // Preserve the Google onboarding contract: mark it done so the web
    // onboarding flow completes even though no task actually runs.
    if (name === "google-onboarding") {
      const userDO = getUserDO(c.env, clerkUserId);
      await userDO.setGoogleOnboardingStatus("done");
    }

    log("task_noop", { name: name ?? null, clerk_user_id: clerkUserId });
    return c.body(null, 202);
  });

  return router;
};
