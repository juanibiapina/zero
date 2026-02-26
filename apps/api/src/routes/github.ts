/**
 * ============================================================================
 * GitHub Auth Routes
 * ============================================================================
 *
 * POST /api/auth/github/callback — GitHub App installation callback
 *
 * Called by the frontend after GitHub redirects the user back from
 * installing the GitHub App. Receives the installation_id and links
 * it to the user's UserDO.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import { UserService } from "../services/user";
import { serviceResult } from "../lib/result";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
};

// ── Schemas ──────────────────────────────────────────────────────────────

const GitHubCallbackBodySchema = z.object({
  installationId: z.number(),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const SuccessSchema = z.object({
  success: z.boolean(),
});

// ── Router ───────────────────────────────────────────────────────────────

export const createGitHubRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const githubCallbackRoute = createRoute({
    method: "post",
    path: "/api/auth/github/callback",
    tags: ["GitHub"],
    summary: "GitHub App installation callback",
    description:
      "Called by the frontend after GitHub redirects the user back from installing the GitHub App. Links the installation to the user's account.",
    request: {
      body: {
        content: { "application/json": { schema: GitHubCallbackBodySchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "Installation linked",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing or invalid installationId",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "User or installation not found",
      },
    },
  });

  router.openapi(githubCallbackRoute, async (c) => {
    const { installationId } = c.req.valid("json");
    const service = new UserService(c.env, c.get("userId"));
    const result = await service.linkGitHubInstallation(installationId);
    return serviceResult(c, result, 200);
  });

  return router;
};
