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
import type { UserDOReferences } from "@zero/core";
import type { UserDO } from "../UserDO";
import { getInstallationDetails } from "../services/github";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
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

    if (!installationId || typeof installationId !== "number") {
      return c.json({ error: "Missing or invalid installationId" }, 400 as const);
    }

    const userDOIdStr = await c.env.KV.get(`user:${c.get("userId")}`);
    if (!userDOIdStr) {
      return c.json({ error: "User not found" }, 404 as const);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(userDOIdStr)
    ) as DurableObjectStub<UserDO>;

    // Fetch installation details from GitHub API to get account info
    try {
      const details = await getInstallationDetails(c.env, installationId);
      await userDO.addGitHubInstallation(
        installationId,
        details.accountLogin,
        details.accountType
      );
    } catch (err) {
      console.error("Failed to fetch installation details from GitHub:", err);

      // Fallback: check KV for webhook-stored data
      const kvData = await c.env.KV.get(`gh_installation:${installationId}`);
      if (kvData) {
        const { accountLogin, accountType } = JSON.parse(kvData);
        await userDO.addGitHubInstallation(
          installationId,
          accountLogin,
          accountType
        );
      } else {
        return c.json({ error: "Installation not found" }, 404 as const);
      }
    }

    return c.json({ success: true }, 200);
  });

  return router;
};
