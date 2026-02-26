/**
 * ============================================================================
 * HTTP API Application
 * ============================================================================
 *
 * Main HTTP API using Hono framework. Provides REST endpoints for Zero.
 * All requests are authenticated via Clerk.
 *
 * Middleware stack:
 * 1. CORS
 * 2. Logger
 * 3. Clerk JWT validation
 * 4. Auth guard (resolves UserDO + caches DO refs)
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { clerkMiddleware, getAuth } from "@hono/clerk-auth";
import { cors } from "hono/cors";
import type { Env } from "./types";
import type { UserDOReferences } from "@zero/core";
import { createProviderRoutes } from "./routes/providers";
import { createProjectRoutes } from "./routes/projects";
import { createSessionRoutes } from "./routes/sessions";
import { createSecretsRoutes } from "./routes/secrets";
import { createGitHubRoutes } from "./routes/github";
import { createWebhookRoutes } from "./routes/webhooks";
import { createRealtimeRoutes } from "./routes/realtime";

/**
 * Custom context variables available to all route handlers.
 */
type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

export const createApp = () => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // CORS for frontend
  app.use(
    "/api/*",
    cors({
      origin: ["http://localhost:5176"],
      credentials: true,
    })
  );

  // Health check (no auth)
  app.get("/api/health", (c) => {
    return c.json({ status: "ok" });
  });

  // GitHub webhook routes (no Clerk auth — verified by HMAC signature)
  app.route("/", createWebhookRoutes());

  // Clerk middleware for all other /api/* routes
  // For SSE endpoints (EventSource can't set headers), we inject the token
  // from the query param into an Authorization header before Clerk processes it.
  app.use("/api/*", async (c, next) => {
    const url = new URL(c.req.url);
    const queryToken = url.searchParams.get("token");
    if (queryToken && !c.req.header("Authorization")) {
      // Clone the request with the Authorization header
      const newReq = new Request(c.req.raw, {
        headers: new Headers(c.req.raw.headers),
      });
      newReq.headers.set("Authorization", `Bearer ${queryToken}`);
      // Replace the raw request so Clerk reads the header
      Object.defineProperty(c.req, "raw", { value: newReq, writable: true });
    }
    await next();
  });
  app.use("/api/*", clerkMiddleware());

  // Auth guard: resolve Clerk user → KV → UserDO → cache DO refs
  app.use("/api/*", async (c, next) => {
    // Skip routes that handle their own auth
    if (c.req.path === "/api/health" || c.req.path.startsWith("/api/webhooks/")) {
      return next();
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type mismatch with Clerk's expected Context type
    const auth = getAuth(c);
    if (!auth?.userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const clerkUserId = auth.userId;
    c.set("userId", clerkUserId);

    // KV lookup: user:{clerkUserId} → UserDO ID
    const env = c.env;
    let userDOIdStr = await env.KV.get(`user:${clerkUserId}`);

    if (!userDOIdStr) {
      // First request for this user — create UserDO with newUniqueId()
      const newId = env.USER_DO.newUniqueId();
      userDOIdStr = newId.toString();
      await env.KV.put(`user:${clerkUserId}`, userDOIdStr);
    }

    const userDOId = env.USER_DO.idFromString(userDOIdStr);
    const userDOStub = env.USER_DO.get(userDOId);
    c.set("userDOStub", userDOStub as unknown as DurableObjectStub);

    // Fetch DO references and cache in context
    const refsResponse = await userDOStub.getDOReferences();
    c.set("doRefs", refsResponse);

    await next();
  });

  // Mount authenticated routes
  app.route("/", createGitHubRoutes());
  app.route("/", createProviderRoutes());
  app.route("/", createProjectRoutes());
  app.route("/", createSessionRoutes());
  app.route("/", createSecretsRoutes());
  app.route("/", createRealtimeRoutes());

  return app;
};
