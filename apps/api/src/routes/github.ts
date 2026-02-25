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

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../types";
import type { UserDOReferences } from "@zero/core";
import type { UserDO } from "../UserDO";
import { getInstallationDetails } from "../services/github";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

export const createGitHubRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  /**
   * GitHub App installation callback.
   *
   * After the user installs the GitHub App, GitHub redirects them to our
   * frontend setup page with `installation_id` in the query string. The
   * frontend then calls this endpoint to link the installation to the
   * user's UserDO.
   *
   * Since this is user-initiated (via browser), Clerk auth is available.
   */
  router.post("/api/auth/github/callback", async (c) => {
    const body = await c.req.json<{ installationId: number }>();

    if (!body.installationId || typeof body.installationId !== "number") {
      return c.json({ error: "Missing or invalid installationId" }, 400);
    }

    const userDOIdStr = await c.env.KV.get(`user:${c.get("userId")}`);
    if (!userDOIdStr) {
      return c.json({ error: "User not found" }, 404);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(userDOIdStr)
    ) as DurableObjectStub<UserDO>;

    // Fetch installation details from GitHub API to get account info
    try {
      const details = await getInstallationDetails(c.env, body.installationId);
      await userDO.addGitHubInstallation(
        body.installationId,
        details.accountLogin,
        details.accountType
      );
    } catch (err) {
      console.error("Failed to fetch installation details from GitHub:", err);

      // Fallback: check KV for webhook-stored data
      const kvData = await c.env.KV.get(`gh_installation:${body.installationId}`);
      if (kvData) {
        const { accountLogin, accountType } = JSON.parse(kvData);
        await userDO.addGitHubInstallation(
          body.installationId,
          accountLogin,
          accountType
        );
      } else {
        return c.json({ error: "Installation not found" }, 404);
      }
    }

    return c.json({ success: true });
  });

  return router;
};
