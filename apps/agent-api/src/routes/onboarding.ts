// Clerk-authed Google onboarding trigger.
//
// The web app POSTs here once when the user connects Google. The DO queues a
// one-shot Gmail scan (see docs/onboarding.md) that seeds the pinned `About
// You` topic. Enqueue is idempotent: queueOnboarding no-ops once the status
// has left `null`, so a user is onboarded at most once. LLM work runs on the
// DO alarm, not in this request.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { log } from "../log";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";

type Variables = {
  userId: string;
};

export const createOnboardingRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const postRoute = createRoute({
    method: "post",
    path: "/api/onboarding/google",
    tags: ["Onboarding"],
    summary: "Queue the one-shot Google (Gmail) onboarding scan",
    request: {
      // `force=true` re-runs onboarding for an already-onboarded user (the scan
      // is idempotent: it re-authors the same pinned topic). Default is the
      // idempotent path used by the web app's fire-once effect.
      query: z.object({ force: z.enum(["true", "1"]).optional() }),
    },
    responses: {
      202: {
        description: "Onboarding queued (or already queued/done: idempotent)",
      },
    },
  });

  router.openapi(postRoute, async (c) => {
    const clerkUserId = c.get("userId");
    const { force } = c.req.valid("query");
    const userDO = getUserDO(c.env, clerkUserId);
    await userDO.queueOnboarding(Boolean(force));
    log("onboarding_queued", { clerk_user_id: clerkUserId, force: Boolean(force) });
    return c.body(null, 202);
  });

  return router;
};
