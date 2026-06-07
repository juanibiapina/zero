// Admin-only routes for cost tracking and session analytics.
//
// Gated by ADMIN_USER_ID env var — only the matching Clerk user can
// access these endpoints. All data comes from the D1 sessions table,
// written by handle-agent-end.ts on each completed agent turn.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import { getGithubInstallationStatus } from "../github-token";
import { listClerkUsers, getClerkUser } from "../admin-users";
import { getUserDO } from "../UserDO/stub";
import { createAgentClient } from "../agent-client";
import { log, logError } from "../log";

type Variables = {
  userId: string;
};


const CostSummarySchema = z.object({
  totalCostUsd: z.number(),
  totalSessions: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
});

const AdminUserSchema = z.object({
  clerkUserId: z.string(),
  email: z.string().nullable(),
  username: z.string().nullable(),
  createdAt: z.string(),
  costUsd: z.number(),
  sessions: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

const AdminUserDetailSchema = z.object({
  clerkUserId: z.string(),
  email: z.string().nullable(),
  username: z.string().nullable(),
  createdAt: z.string(),
  telegramId: z.string().nullable(),
  googleOnboardingStatus: z.string().nullable(),
  onboardingSeen: z.boolean(),
});

const SessionCostSchema = z.object({
  sessionId: z.string(),
  clerkUserId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createAdminRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // Admin gate — runs before all /api/admin/* routes
  router.use("/api/admin/*", async (c, next) => {
    const userId = c.get("userId");
    if (userId !== c.env.ADMIN_USER_ID) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });

  // GET /api/admin/costs — aggregate totals
  const costsRoute = createRoute({
    method: "get",
    path: "/api/admin/costs",
    tags: ["Admin"],
    summary: "Get aggregate cost summary",
    responses: {
      200: {
        content: { "application/json": { schema: CostSummarySchema } },
        description: "Aggregate cost data",
      },
    },
  });

  router.openapi(costsRoute, async (c) => {
    interface CostRow {
      total_cost_usd: number;
      total_sessions: number;
      total_input_tokens: number;
      total_output_tokens: number;
    }
    const row = await c.env.SESSIONS_DB.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COUNT(*) AS total_sessions,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens
      FROM sessions
    `).first<CostRow>();

    return c.json({
      totalCostUsd: row?.total_cost_usd ?? 0,
      totalSessions: row?.total_sessions ?? 0,
      totalInputTokens: row?.total_input_tokens ?? 0,
      totalOutputTokens: row?.total_output_tokens ?? 0,
    }, 200);
  });

  // GET /api/admin/users — complete roster from Clerk, joined with cost.
  //
  // Clerk is the source of truth so every signed-up user appears, even
  // those with no sessions. Cost comes from a single D1 aggregate joined
  // in memory; no per-user UserDO/GitHub calls happen here (those live on
  // the details route).
  const usersRoute = createRoute({
    method: "get",
    path: "/api/admin/users",
    tags: ["Admin"],
    summary: "List all users with cost data",
    responses: {
      200: {
        content: { "application/json": { schema: z.array(AdminUserSchema) } },
        description: "All users joined with cost",
      },
    },
  });

  router.openapi(usersRoute, async (c) => {
    interface UserRow {
      clerk_user_id: string;
      cost_usd: number;
      sessions: number;
      input_tokens: number;
      output_tokens: number;
    }
    const [users, costRes] = await Promise.all([
      listClerkUsers(c.env),
      c.env.SESSIONS_DB.prepare(`
        SELECT
          clerk_user_id,
          SUM(cost_usd) AS cost_usd,
          COUNT(*) AS sessions,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens
        FROM sessions
        GROUP BY clerk_user_id
      `).all<UserRow>(),
    ]);

    const costByUser = new Map(costRes.results.map((r) => [r.clerk_user_id, r]));

    const merged = users.map((u) => {
      const cost = costByUser.get(u.clerkUserId);
      return {
        clerkUserId: u.clerkUserId,
        email: u.email,
        username: u.username,
        createdAt: u.createdAt,
        costUsd: cost?.cost_usd ?? 0,
        sessions: cost?.sessions ?? 0,
        inputTokens: cost?.input_tokens ?? 0,
        outputTokens: cost?.output_tokens ?? 0,
      };
    });
    merged.sort((a, b) => b.costUsd - a.costUsd);

    return c.json(merged, 200);
  });

  // GET /api/admin/users/{userId} — per-user details for the detail page.
  //
  // The only admin path that pays for per-user Clerk + UserDO reads.
  const userDetailRoute = createRoute({
    method: "get",
    path: "/api/admin/users/{userId}",
    tags: ["Admin"],
    summary: "Get a single user's identity and link status",
    request: {
      params: z.object({ userId: z.string().min(1) }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: AdminUserDetailSchema } },
        description: "User identity and link status",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Unknown user",
      },
    },
  });

  router.openapi(userDetailRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const identity = await getClerkUser(c.env, userId);
    if (!identity) {
      return c.json({ error: "Unknown user" }, 404);
    }
    const userDO = getUserDO(c.env, userId);
    const [telegramId, settings] = await Promise.all([
      userDO.getTelegramId(),
      userDO.getSettings(),
    ]);
    return c.json({
      clerkUserId: identity.clerkUserId,
      email: identity.email,
      username: identity.username,
      createdAt: identity.createdAt,
      telegramId,
      googleOnboardingStatus: settings.googleOnboardingStatus,
      onboardingSeen: settings.onboardingSeen,
    }, 200);
  });

  // GET /api/admin/costs/sessions — list sessions with cost
  const sessionsRoute = createRoute({
    method: "get",
    path: "/api/admin/costs/sessions",
    tags: ["Admin"],
    summary: "List sessions with cost data",
    request: {
      query: z.object({
        userId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.array(SessionCostSchema) } },
        description: "Session cost data",
      },
    },
  });

  // GET /api/admin/github/status — per-user GitHub App install/token check.
  // Takes an explicit userId so the admin can inspect any user; defaults
  // to the caller. Returns non-secret diagnostics only.
  const GithubStatusSchema = z.object({
    githubConnected: z.boolean(),
    githubUsername: z.string().nullable(),
    installationId: z.number().nullable(),
    tokenMinted: z.boolean(),
    tokenPrefix: z.string().nullable(),
    expiresAt: z.string().nullable(),
  });

  const githubStatusRoute = createRoute({
    method: "get",
    path: "/api/admin/github/status",
    tags: ["Admin"],
    summary: "Check a user's GitHub App installation and token minting",
    request: {
      query: z.object({ userId: z.string().optional() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: GithubStatusSchema } },
        description: "GitHub installation status (non-secret diagnostics)",
      },
    },
  });

  router.openapi(githubStatusRoute, async (c) => {
    const { userId } = c.req.valid("query");
    const target = userId ?? c.get("userId");
    const status = await getGithubInstallationStatus(c.env, target);
    return c.json(status, 200);
  });

  router.openapi(sessionsRoute, async (c) => {
    const { userId, limit, offset } = c.req.valid("query");

    interface SessionRow {
      session_id: string;
      clerk_user_id: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cost_usd: number;
      created_at: string;
      updated_at: string;
    }

    let query: string;
    let bindings: unknown[];

    if (userId) {
      query = `
        SELECT * FROM sessions
        WHERE clerk_user_id = ?
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `;
      bindings = [userId, limit, offset];
    } else {
      query = `
        SELECT * FROM sessions
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `;
      bindings = [limit, offset];
    }

    const res = await c.env.SESSIONS_DB.prepare(query)
      .bind(...bindings)
      .all<SessionRow>();

    return c.json(res.results.map((r) => ({
      sessionId: r.session_id,
      clerkUserId: r.clerk_user_id,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      costUsd: r.cost_usd,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })), 200);
  });

  // POST /api/admin/import-notes/:userId — import notes from a zip file
  const ImportNotesResultSchema = z.object({
    filesExtracted: z.number(),
  });

  const importNotesRoute = createRoute({
    method: "post",
    path: "/api/admin/import-notes/{userId}",
    tags: ["Admin"],
    summary: "Import notes from an archive (zip or tar.gz) into a user's container",
    request: {
      params: z.object({ userId: z.string().min(1) }),
      body: {
        content: {
          "application/zip": { schema: { type: "string", format: "binary" } },
          "application/gzip": { schema: { type: "string", format: "binary" } },
          "application/x-gzip": { schema: { type: "string", format: "binary" } },
          "application/x-tar": { schema: { type: "string", format: "binary" } },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ImportNotesResultSchema } },
        description: "Notes imported successfully",
      },
      500: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Import failed",
      },
    },
  });

  router.openapi(importNotesRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const body = await c.req.arrayBuffer();

    log("import_notes_request", { clerk_user_id: userId, size: body.byteLength });

    const client = createAgentClient(c.env, userId);
    const result = await client.importNotes(body);

    if (result.kind === "error") {
      logError("import_notes_failed", { clerk_user_id: userId, status: result.status });
      return c.json({ error: `Import failed with status ${result.status}` }, 500);
    }

    log("import_notes_success", { clerk_user_id: userId, files_extracted: result.filesExtracted });
    return c.json({ filesExtracted: result.filesExtracted }, 200);
  });

  return router;
};
