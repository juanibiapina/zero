// POST /api/webhooks/clerk — public route.
//
// Clerk fires a Svix-signed webhook on account events. We verify the
// signature with the shared signing secret, and on `user.created` post a
// signup message to Discord. The Discord call runs via `executionCtx.waitUntil`
// so the route returns 200 immediately; a Discord outage never makes us 5xx
// (Clerk retries on non-2xx). Bad/missing signatures return 401.
//
// See docs/design.md § Routes.

import { OpenAPIHono } from "@hono/zod-openapi";
import { verifyWebhook } from "@clerk/backend/webhooks";
import type { UserJSON, WebhookEvent } from "@clerk/backend";
import type { Env } from "../types";
import { log, logError, fmtErr } from "../log";
import { notifyDiscord } from "../discord";

// Builds the signup line from a Clerk user, including name and email when
// present and degrading gracefully when pieces are missing.
export const formatSignupMessage = (user: UserJSON): string => {
  const name = [user.first_name, user.last_name]
    .filter((part): part is string => !!part)
    .join(" ")
    .trim();
  const displayName = name || user.username || "";

  const primary = user.email_addresses.find(
    (e) => e.id === user.primary_email_address_id,
  );
  const email = primary?.email_address ?? user.email_addresses[0]?.email_address ?? "";

  const parts = [displayName, email].filter((p) => p.length > 0);
  const who = parts.join(" — ");
  return who ? `🎉 New signup: ${who} (${user.id})` : `🎉 New signup: (${user.id})`;
};

// Decides what to do with a verified event. Pure aside from the injected
// `schedule`, which the route wires to `executionCtx.waitUntil`.
export const handleClerkEvent = (
  event: WebhookEvent,
  env: Env,
  schedule: (promise: Promise<unknown>) => void,
): void => {
  if (event.type !== "user.created") return;
  const message = formatSignupMessage(event.data);
  log("clerk_signup", { clerk_user_id: event.data.id });
  schedule(notifyDiscord(env.DISCORD_SIGNUP_WEBHOOK_URL, message));
};

export const createClerkWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/clerk", async (c) => {
    let event: WebhookEvent;
    try {
      event = await verifyWebhook(c.req.raw, {
        signingSecret: c.env.CLERK_WEBHOOK_SIGNING_SECRET,
      });
    } catch (err) {
      logError("clerk_webhook_invalid", { error: fmtErr(err) });
      return c.text("invalid signature", 401);
    }

    handleClerkEvent(event, c.env, (promise) => c.executionCtx.waitUntil(promise));
    return c.text("ok", 200);
  });

  return router;
};
