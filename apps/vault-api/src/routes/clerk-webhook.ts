import { verifyWebhook } from "@clerk/backend/webhooks";
import type { UserJSON, WebhookEvent } from "@clerk/backend";
import { Hono } from "hono";
import { notifyDiscord } from "../discord";
import type { Env } from "../types";

export const formatSignupMessage = (user: UserJSON): string => {
  const name = [user.first_name, user.last_name]
    .filter((part): part is string => !!part)
    .join(" ")
    .trim();
  const displayName = name || user.username || "";
  const primary = user.email_addresses.find(
    (email) => email.id === user.primary_email_address_id,
  );
  const email = primary?.email_address ?? user.email_addresses[0]?.email_address ?? "";
  const who = [displayName, email].filter((part) => part.length > 0).join(" - ");

  return who
    ? `🎉 New Zero dashboard signup: ${who} (${user.id})`
    : `🎉 New Zero dashboard signup: (${user.id})`;
};

export const handleClerkEvent = (
  event: WebhookEvent,
  env: Env,
  schedule: (promise: Promise<unknown>) => void,
): void => {
  if (event.type !== "user.created") return;

  console.log({ event: "clerk_signup", clerkUserId: event.data.id });
  schedule(
    notifyDiscord(env.DISCORD_SIGNUP_WEBHOOK_URL, formatSignupMessage(event.data)),
  );
};

export const createClerkWebhookRoute = () => {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/api/webhooks/clerk", async (c) => {
    let event: WebhookEvent;
    try {
      event = await verifyWebhook(c.req.raw, {
        signingSecret: c.env.CLERK_WEBHOOK_SIGNING_SECRET,
      });
    } catch (err) {
      console.error("clerk_webhook_invalid", { error: String(err) });
      return c.text("invalid signature", 401);
    }

    handleClerkEvent(event, c.env, (promise) => c.executionCtx.waitUntil(promise));
    return c.text("ok", 200);
  });

  return router;
};
