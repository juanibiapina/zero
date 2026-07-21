/**
 * ============================================================================
 * ZeroErrors HTTP API Application
 * ============================================================================
 *
 * Main HTTP API using Hono. Provides:
 * - Public API: /v1/* (API key auth + rate limiting) — error ingest + reads
 * - Account management: /api/* (Clerk JWT auth) — dashboard reads + resolve
 *
 * Auth is shared with ZeroVault: the same `zv_` key (validated via @zero/auth
 * against the same APIKEYS KV) authorizes ingest, scoped to the key's org.
 */

import { Hono } from "hono";
import { clerkMiddleware, getAuth } from "@hono/clerk-auth";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { validateApiKey } from "@zero/auth";
import type { Env } from "./types";
import type { Notifier } from "./notify/notifier";
import { LogNotifier } from "./notify/LogNotifier";
import { createErrorsRouter } from "./routes/errors";
import { createIssuesRouter } from "./routes/issues";

type Variables = {
  userId: string;
  orgId: string;
};

interface CreateAppOptions {
  testUserId?: string;
  notifier?: Notifier;
}

export const createApp = (env: Env, options: CreateAppOptions = {}) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const notifier = options.notifier ?? new LogNotifier();

  app.onError((err, c) => {
    console.error("Error:", err);

    if (err instanceof HTTPException) {
      return err.getResponse();
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
    const authHeader = c.req.header("Authorization");
    const auth = await validateApiKey(env.APIKEYS, authHeader);

    if (!auth) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    c.set("userId", auth.userId);
    c.set("orgId", auth.orgId);

    // Rate limit per org (orgs must not share a budget).
    const { success } = await env.RATE_LIMITER.limit({ key: auth.orgId });
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
    // Test bypass: orgId comes from X-Org-Id (defaulting to testUserId). Guarded
    // strictly behind testUserId so it can never affect production.
    if (options.testUserId) {
      c.set("userId", options.testUserId);
      c.set("orgId", c.req.header("X-Org-Id") ?? options.testUserId);
      await next();
      return;
    }

    // Production: org context derives from the Clerk session. No org → 403.
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

  // Routes (registered after both middleware stacks so /v1/ and /api/ are authed)
  app.route("/", createErrorsRouter(notifier));
  app.route("/", createIssuesRouter());

  return app;
};
