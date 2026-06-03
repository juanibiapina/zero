import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import { createAdminRoutes } from "./admin";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const fakeD1 = (rows: Record<string, unknown>[] = []) => ({
  prepare: (query: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async () => ({ results: rows }),
      first: async () => {
        // For aggregate queries, return the single row
        if (rows.length > 0) return rows[0];
        return { total_cost_usd: 0, total_sessions: 0, total_input_tokens: 0, total_output_tokens: 0 };
      },
      run: async () => ({ success: true }),
    }),
    // Also support calling without bind (for queries with no params)
    all: async () => ({ results: rows }),
    first: async () => {
      if (rows.length > 0) return rows[0];
      return { total_cost_usd: 0, total_sessions: 0, total_input_tokens: 0, total_output_tokens: 0 };
    },
    _query: query,
  }),
});

const fakeEnv = (adminUserId: string, sessionsDb = fakeD1()): Env =>
  ({
    ADMIN_USER_ID: adminUserId,
    SESSIONS_DB: sessionsDb,
  }) as unknown as Env;

const buildApp = (env: Env, userId: string) => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  // Inject userId as Clerk auth would
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createAdminRoutes());
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, env),
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin gate", () => {
  it("returns 403 for non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_123"), "other_user");
    const res = await app.request("/api/admin/costs");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("allows admin user through", async () => {
    const app = buildApp(fakeEnv("admin_123"), "admin_123");
    const res = await app.request("/api/admin/costs");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/costs", () => {
  it("returns aggregate summary from D1", async () => {
    const db = fakeD1([{
      total_cost_usd: 1.23,
      total_sessions: 5,
      total_input_tokens: 10000,
      total_output_tokens: 5000,
    }]);
    const app = buildApp(fakeEnv("admin_1", db), "admin_1");

    const res = await app.request("/api/admin/costs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totalCostUsd: 1.23,
      totalSessions: 5,
      totalInputTokens: 10000,
      totalOutputTokens: 5000,
    });
  });

  it("returns zeros when no sessions exist", async () => {
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request("/api/admin/costs");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      totalCostUsd: 0,
      totalSessions: 0,
    });
  });
});

describe("GET /api/admin/costs/by-user", () => {
  it("returns per-user breakdown", async () => {
    const db = fakeD1([
      { clerk_user_id: "user_a", cost_usd: 0.80, sessions: 3, input_tokens: 5000, output_tokens: 2000 },
      { clerk_user_id: "user_b", cost_usd: 0.20, sessions: 1, input_tokens: 1000, output_tokens: 500 },
    ]);
    const app = buildApp(fakeEnv("admin_1", db), "admin_1");

    const res = await app.request("/api/admin/costs/by-user");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { clerkUserId: "user_a", costUsd: 0.80, sessions: 3, inputTokens: 5000, outputTokens: 2000 },
      { clerkUserId: "user_b", costUsd: 0.20, sessions: 1, inputTokens: 1000, outputTokens: 500 },
    ]);
  });
});

describe("GET /api/admin/costs/sessions", () => {
  it("returns session list", async () => {
    const db = fakeD1([{
      session_id: "sess-1",
      clerk_user_id: "user_a",
      model: "anthropic/claude-sonnet-4-5-20250929",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 100,
      cache_write_tokens: 50,
      cost_usd: 0.05,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T01:00:00Z",
    }]);
    const app = buildApp(fakeEnv("admin_1", db), "admin_1");

    const res = await app.request("/api/admin/costs/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{
      sessionId: "sess-1",
      clerkUserId: "user_a",
      model: "anthropic/claude-sonnet-4-5-20250929",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      costUsd: 0.05,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T01:00:00Z",
    }]);
  });
});
