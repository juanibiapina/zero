/**
 * ============================================================================
 * HTTP API Application
 * ============================================================================
 *
 * Hono app. Provides:
 * - POST /api/webhooks/telegram (Telegram secret-token auth)
 * - GET/PUT /api/telegram-id    (Clerk auth)
 *
 * Middleware order matters: the webhook router is mounted *before* Clerk so
 * Telegram requests (which carry no Clerk JWT) aren't rejected; the
 * telegram-id router is mounted *after* Clerk + the auth guard so its
 * handlers always see a verified `userId`.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { clerkMiddleware, getAuth } from "@hono/clerk-auth";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createTelegramWebhookRoute } from "./routes/telegram-webhook";
import { createUserSettingsRoutes } from "./routes/user-settings";

type Variables = {
  userId: string;
};

export const createApp = () => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  app.use(
    "/api/*",
    cors({
      origin: ["http://localhost:5176"],
      credentials: true,
    })
  );

  // Public: Telegram webhook (does its own secret-token auth).
  app.route("/", createTelegramWebhookRoute());

  // Clerk auth + guard for everything that follows.
  app.use("/api/*", clerkMiddleware());
  app.use("/api/*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type mismatch with Clerk's expected Context type
    const auth = getAuth(c);
    if (!auth?.userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("userId", auth.userId);
    await next();
  });

  // Authenticated routes.
  app.route("/", createUserSettingsRoutes());

  return app;
};
