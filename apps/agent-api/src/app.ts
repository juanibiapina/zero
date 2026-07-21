// Middleware order matters: the Telegram webhook is mounted before Clerk
// (it carries no Clerk JWT); the user-settings routes are mounted after
// Clerk + the auth guard so handlers always see a verified `userId`.

import { OpenAPIHono } from "@hono/zod-openapi";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createTelegramWebhookRoute } from "./routes/telegram-webhook";
import { createClerkWebhookRoute } from "./routes/clerk-webhook";
import { createUserSettingsRoutes } from "./routes/user-settings";
import { createOnboardingRoutes } from "./routes/onboarding";
import { createAdminRoutes } from "./routes/admin";

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

  app.route("/", createTelegramWebhookRoute());
  app.route("/", createClerkWebhookRoute());

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

  app.route("/", createUserSettingsRoutes());
  app.route("/", createOnboardingRoutes());
  app.route("/", createAdminRoutes());

  return app;
};
