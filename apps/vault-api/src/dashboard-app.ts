import { clerkMiddleware, getAuth } from "@clerk/hono";
import { authenticate, createClerkOAuthVerifier, type OAuthTokenVerifier } from "@zero/auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { LogNotifier } from "./errors/notify/LogNotifier";
import type { Notifier } from "./errors/notify/notifier";
import { createErrorsRouter } from "./errors/routes/errors";
import { createIssuesRouter } from "./errors/routes/issues";
import { reportError } from "./reporting/zero-errors";
import { createClerkWebhookRoute } from "./routes/clerk-webhook";
import { createEnvironmentsRouter } from "./routes/environments";
import { createKeysRouter } from "./routes/keys";
import { createProjectsRouter } from "./routes/projects";
import { createSecretsRouter } from "./routes/secrets";
import type { Env } from "./types";

type Variables = {
  userId: string;
  orgId: string;
};

interface CreateDashboardAppOptions {
  testUserId?: string;
  notifier?: Notifier;
  /**
   * Stand-in for Clerk's `/oauth/userinfo`. Tests inject it so the OAuth path
   * can be exercised without a live Clerk instance or a real login.
   */
  verifyOAuthToken?: OAuthTokenVerifier;
}

const publicCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400,
});

/**
 * The console's HTTP application. Browser endpoints remain same-origin under
 * /api/{product}; API-key endpoints live under /{product}/v1.
 */
export const createDashboardApp = (env: Env, options: CreateDashboardAppOptions = {}) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.onError((err, c) => {
    console.error("Error:", err);
    if (err instanceof HTTPException) return err.getResponse();

    try {
      c.executionCtx.waitUntil(
        reportError(c.env, err, { site: "http", path: c.req.path }),
      );
    } catch {
      // Unit tests do not always provide an execution context.
    }
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/ping", (c) => c.json({ ok: true }));

  const verifyOAuthToken =
    options.verifyOAuthToken ??
    createClerkOAuthVerifier({
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
      cache: env.APIKEYS,
    });

  for (const path of ["/vault/v1/*", "/errors/v1/*"]) {
    app.use(path, publicCors);
    app.use(path, async (c, next) => {
      const outcome = await authenticate(
        { apikeys: env.APIKEYS, verifyOAuthToken },
        c.req.header("Authorization"),
      );
      if (!outcome.ok) {
        // A signed-in user whose token carries no org is the one failure a
        // correct client hits, so it names the fix instead of saying "invalid".
        if (outcome.reason === "no_org") {
          return c.json(
            { error: "Token has no organization. Run `zero login` again and select an organization." },
            401,
          );
        }
        return c.json({ error: "Invalid API key" }, 401);
      }
      const auth = outcome.auth;

      c.set("userId", auth.userId);
      c.set("orgId", auth.orgId);
      const limiter = c.req.path.startsWith("/vault/v1/")
        ? env.VAULT_RATE_LIMITER
        : env.ERRORS_RATE_LIMITER;
      const { success } = await limiter.limit({ key: auth.orgId });
      if (!success) {
        return c.json({ error: "Rate limit exceeded. Try again later." }, 429, {
          "Retry-After": "60",
        });
      }
      await next();
    });
  }

  app.get("/vault/v1/whoami", (c) => c.json({ userId: c.get("userId"), orgId: c.get("orgId") }));
  app.get("/errors/v1/whoami", (c) => c.json({ userId: c.get("userId"), orgId: c.get("orgId") }));

  app.route("/", createClerkWebhookRoute());

  if (!options.testUserId) app.use("/api/*", clerkMiddleware());
  app.use("/api/*", async (c, next) => {
    if (options.testUserId) {
      c.set("userId", options.testUserId);
      c.set("orgId", c.req.header("X-Org-Id") ?? options.testUserId);
      await next();
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type mismatch with Clerk's expected Context type
    const auth = getAuth(c);
    if (!auth?.userId) return c.json({ error: "Unauthorized" }, 401);
    if (!auth.orgId) return c.json({ error: "No active organization" }, 403);
    c.set("userId", auth.userId);
    c.set("orgId", auth.orgId);
    await next();
  });

  app.route("/", createKeysRouter(env));
  app.route("/", createProjectsRouter(env));
  app.route("/", createEnvironmentsRouter(env));
  app.route("/", createSecretsRouter(env));
  app.route("/", createErrorsRouter(options.notifier ?? new LogNotifier()));
  app.route("/", createIssuesRouter());

  return app;
};
