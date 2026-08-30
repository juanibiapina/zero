// Middleware order matters: the Telegram webhook is mounted before Clerk
// (it carries no Clerk JWT); the user-settings routes are mounted after
// Clerk + the auth guard so handlers always see a verified `userId`.

import { OpenAPIHono } from "@hono/zod-openapi";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { logError, fmtErr } from "./log";
import { reportError } from "./reporting/zero-errors";
import { createTelegramWebhookRoute } from "./routes/telegram-webhook";
import { createClerkWebhookRoute } from "./routes/clerk-webhook";
import { createUserSettingsRoutes } from "./routes/user-settings";
import { createOnboardingRoutes } from "./routes/onboarding";
import { createAdminRoutes } from "./routes/admin";
import { createCapturesRoutes } from "./routes/captures";
import { createTasksRoutes } from "./routes/tasks";

type Variables = {
  userId: string;
};

export const createApp = () => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // Report uncaught request errors to ZeroErrors alongside the log line. The
  // webhook path swallows its own failures (returning 200), so this only fires
  // for genuinely unexpected throws in the HTTP handlers.
  app.onError((err, c) => {
    logError("http_error", { error: fmtErr(err), path: c.req.path });
    try {
      c.executionCtx.waitUntil(
        reportError(c.env, err, { site: "http", path: c.req.path }),
      );
    } catch {
      // No execution context (e.g. in unit tests): skip async reporting.
    }
    return c.json({ error: "Internal server error" }, 500);
  });

  app.use(
    "/api/*",
    cors({
      origin: ["http://localhost:5176"],
      credentials: true,
    })
  );

  app.route("/", createTelegramWebhookRoute());
  app.route("/", createClerkWebhookRoute());

  // Auth guard. Under ENVIRONMENT=test the hermetic release E2E stack has no
  // Clerk secret, so trust the bearer token as the userId and skip Clerk
  // entirely. Production and development never set ENVIRONMENT=test, so this
  // branch is inert there and the real Clerk verification always runs.
  app.use("/api/*", async (c, next) => {
    if (c.env.ENVIRONMENT === "test") {
      const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
      if (!bearer) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      c.set("userId", bearer);
      return next();
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type mismatch with Clerk's expected Context type
    return clerkMiddleware()(c, next);
  });
  app.use("/api/*", async (c, next) => {
    if (c.env.ENVIRONMENT === "test") {
      // userId already set by the test bypass above.
      return next();
    }
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
  app.route("/", createCapturesRoutes());
  app.route("/", createTasksRoutes());

  return app;
};
