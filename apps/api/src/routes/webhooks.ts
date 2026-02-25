/**
 * ============================================================================
 * Webhook Routes
 * ============================================================================
 *
 * POST /api/webhooks/github — Receives GitHub App webhook events
 *
 * No Clerk auth — verified by HMAC signature.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../types";
import { verifyWebhookSignature } from "../services/github";
export const createWebhookRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/github", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const payload = await c.req.text();

    const valid = await verifyWebhookSignature(
      c.env.GITHUB_WEBHOOK_SECRET,
      payload,
      signature
    );
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const event = c.req.header("x-github-event");
    const body = JSON.parse(payload);

    console.log(`GitHub webhook: ${event} action=${body.action ?? "n/a"}`);

    // Handle installation events
    if (event === "installation") {
      await handleInstallationEvent(c.env, body);
    }

    return c.json({ received: true });
  });

  return router;
};

/**
 * Handle GitHub App installation created/deleted events.
 * Maps installation to user via KV: installation:{id} → clerkUserId
 */
async function handleInstallationEvent(
  env: Env,
  body: {
    action: string;
    installation: {
      id: number;
      account: { login: string; type: string };
    };
    sender: { login: string; id: number };
  }
) {
  const installationId = body.installation.id;
  const accountLogin = body.installation.account.login;
  const accountType = body.installation.account.type;

  if (body.action === "created") {
    // Store installation → sender mapping in KV for webhook routing
    // Note: We can't know the Clerk userId from the webhook alone.
    // The GitHub installation callback route (user-initiated) handles
    // linking the installation to the user's UserDO.
    // For now, log it.
    console.log(
      `GitHub App installed: ${installationId} by ${accountLogin} (${accountType})`
    );

    // Store a reverse lookup for webhook routing
    await env.KV.put(
      `gh_installation:${installationId}`,
      JSON.stringify({ accountLogin, accountType })
    );
  } else if (body.action === "deleted") {
    console.log(`GitHub App uninstalled: ${installationId}`);
    await env.KV.delete(`gh_installation:${installationId}`);
  }
}
