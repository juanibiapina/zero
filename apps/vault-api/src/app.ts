/**
 * ============================================================================
 * ZeroVault HTTP API Application
 * ============================================================================
 *
 * Main HTTP API using Hono framework. Provides:
 * - Public API: /v1/* (API key auth + rate limiting)
 * - Account management: /api/* (Clerk JWT auth)
 *
 * Middleware stack:
 * 1. Error handler
 * 2. API key auth + rate limiting (for /v1/* routes)
 * 3. Clerk JWT authentication (for /api/* routes)
 */

import { Hono } from "hono";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";
import { validateApiKey } from "@zero/auth";
import { createKeysRouter } from "./routes/keys";
import { createProjectsRouter } from "./routes/projects";
import { createEnvironmentsRouter } from "./routes/environments";
import { createSecretsRouter } from "./routes/secrets";
import { reportError } from "./reporting/zero-errors";

type Variables = {
  userId: string;
  orgId: string;
};

interface CreateAppOptions {
  testUserId?: string;
}

export const createApp = (env: Env, options: CreateAppOptions = {}) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.onError((err, c) => {
    console.error("Error:", err);

    if (err instanceof HTTPException) {
      return err.getResponse();
    }

    // Genuine 500 (not a deliberate HTTPException): report fire-and-forget.
    try {
      c.executionCtx.waitUntil(
        reportError(c.env, err, { site: "http", path: c.req.path }),
      );
    } catch {
      // No execution context (unit tests): skip async reporting.
    }

    return c.json({ error: "Internal server error" }, 500);
  });

  // ============================================================================
  // Health check
  // ============================================================================

  app.get("/ping", (c) => c.json({ ok: true }));
  // ============================================================================
  // Public API (/v1/*) — CORS + API key auth + rate limiting
  // ============================================================================

  const publicCors = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  });

  app.use("/v1/*", publicCors);

  app.use("/v1/*", async (c, next) => {
    // Org context derives from the API-key KV value ({ v: 2, orgId, userId }).
    // The key's orgId routes both DOs; legacy v1 keys are rejected (401).
    const authHeader = c.req.header("Authorization");
    const auth = await validateApiKey(env.APIKEYS, authHeader);

    if (!auth) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    c.set("userId", auth.userId);
    c.set("orgId", auth.orgId);

    // Rate limit per org (orgs must not share a budget).
    const { success } = await env.VAULT_RATE_LIMITER.limit({ key: auth.orgId });
    if (!success) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429, {
        "Retry-After": "60",
      });
    }

    await next();
  });

  // whoami endpoint
  app.get("/v1/whoami", (c) => {
    const userId = c.get("userId");
    const orgId = c.get("orgId");
    return c.json({ userId, orgId }, 200);
  });

  // ============================================================================
  // Account Management API (/api/*) — Clerk JWT authentication
  // ============================================================================

  if (!options.testUserId) {
    app.use("/api/*", clerkMiddleware());
  }

  app.use("/api/*", async (c, next) => {
    // Test bypass: orgId comes from X-Org-Id (defaulting to testUserId). This
    // override is guarded strictly behind testUserId so it can never affect
    // production.
    if (options.testUserId) {
      c.set("userId", options.testUserId);
      c.set("orgId", c.req.header("X-Org-Id") ?? options.testUserId);
      await next();
      return;
    }

    // Production: org context derives from the Clerk session. getAuth().orgId
    // is populated when the org is active on the session token. No org → 403
    // (loud failure rather than routing to a wrong/empty vault).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type mismatch with Clerk's expected Context type
    const auth = getAuth(c);
    if (!auth?.userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!auth.orgId) {
      return c.json({ error: "No active organization" }, 403);
    }

    c.set("userId", auth.userId);
    c.set("orgId", auth.orgId);
    await next();
  });

  // Routes (register after both middleware stacks so /v1/ and /api/ paths are authed)
  app.route("/", createKeysRouter(env));
  app.route("/", createProjectsRouter(env));
  app.route("/", createEnvironmentsRouter(env));
  app.route("/", createSecretsRouter(env));

  return app;
};
