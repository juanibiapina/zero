/**
 * ============================================================================
 * Session Routes (top-level, not nested under projects)
 * ============================================================================
 *
 * GET    /api/sessions                — List sessions (optional ?owner=X&repo=Y filter)
 * POST   /api/sessions               — Create + start session
 * DELETE /api/sessions/:id            — Delete session
 * GET    /api/sessions/:id/ws         — WebSocket upgrade → SessionDO
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { getContainer } from "@cloudflare/containers";
import type { Env } from "../types";
import type { UserDOReferences } from "@zero/core";
import type { UserDO } from "../UserDO";
import { createSession } from "../services/session";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

// ── Schemas ──────────────────────────────────────────────────────────────

const SessionIdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    description: "Session unique identifier",
  }),
});

const ListSessionsQuerySchema = z.object({
  owner: z.string().optional().openapi({
    param: { name: "owner", in: "query" },
    description: "Filter by repository owner",
  }),
  repo: z.string().optional().openapi({
    param: { name: "repo", in: "query" },
    description: "Filter by repository name",
  }),
});

const CreateSessionBodySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  prompt: z.string().optional(),
});

const SessionSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});

const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const SuccessSchema = z.object({
  ok: z.boolean(),
});

// ── Router ───────────────────────────────────────────────────────────────

export const createSessionRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List sessions ────────────────────────────────────────────────────

  const listSessionsRoute = createRoute({
    method: "get",
    path: "/api/sessions",
    tags: ["Sessions"],
    summary: "List sessions",
    description: "Lists all sessions for the authenticated user. Optionally filter by owner and repo.",
    request: {
      query: ListSessionsQuerySchema,
    },
    responses: {
      200: {
        content: { "application/json": { schema: SessionListResponseSchema } },
        description: "List of sessions",
      },
    },
  });

  router.openapi(listSessionsRoute, async (c) => {
    const { owner, repo } = c.req.valid("query");

    const userDO = c.get("userDOStub") as DurableObjectStub<UserDO>;
    const filter = owner && repo ? { owner, repo } : undefined;
    const sessions = await userDO.listSessions(filter);

    return c.json({
      sessions: sessions.map((s) => ({
        id: s.sessionDOId,
        owner: s.owner,
        repo: s.repo,
        title: s.title,
        status: s.status,
        provider: s.provider,
        model: s.model,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    }, 200);
  });

  // ── Create session ───────────────────────────────────────────────────

  const createSessionRoute = createRoute({
    method: "post",
    path: "/api/sessions",
    tags: ["Sessions"],
    summary: "Create session",
    description: "Creates and starts a new coding session for a project.",
    request: {
      body: {
        content: { "application/json": { schema: CreateSessionBodySchema } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: CreateSessionResponseSchema } },
        description: "Session created",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing required fields or no GitHub installation",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Project not found",
      },
      500: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Failed to create session",
      },
    },
  });

  router.openapi(createSessionRoute, async (c) => {
    const { owner, repo, prompt } = c.req.valid("json");

    if (!owner || !repo) {
      return c.json({ error: "owner and repo are required" }, 400 as const);
    }

    // Verify user has access to this project
    const doRefs = c.get("doRefs");
    const projectRef = doRefs.projects.find(
      (p) => p.owner === owner && p.repo === repo
    );
    if (!projectRef) {
      return c.json({ error: "Project not found" }, 404 as const);
    }

    // Get UserDO stub and ID
    const userDOIdStr = (await c.env.KV.get(`user:${c.get("userId")}`))!;
    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(userDOIdStr)
    ) as DurableObjectStub<UserDO>;

    // Look up installationId from the user's linked GitHub installation
    const installation = await userDO.getGitHubInstallation();
    if (!installation) {
      return c.json(
        { error: "No GitHub installation linked. Install or link the GitHub App first." },
        400 as const
      );
    }

    try {
      const result = await createSession({
        env: c.env,
        userDO,
        userDOId: userDOIdStr,
        owner,
        repo,
        installationId: installation.installationId,
        prompt,
      });

      return c.json(result, 201);
    } catch (err) {
      console.error("Failed to create session:", err);
      return c.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Failed to create session",
        },
        500 as const
      );
    }
  });

  // ── Delete session ───────────────────────────────────────────────────

  const deleteSessionRoute = createRoute({
    method: "delete",
    path: "/api/sessions/{id}",
    tags: ["Sessions"],
    summary: "Delete session",
    description: "Deletes a session and cleans up associated resources (container, snapshot, DO storage).",
    request: {
      params: SessionIdParamSchema,
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "Session deleted",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Session not found",
      },
      500: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Failed to remove session from index",
      },
    },
  });

  router.openapi(deleteSessionRoute, async (c) => {
    const { id } = c.req.valid("param");

    // Verify session belongs to this user
    const userDO = c.get("userDOStub") as DurableObjectStub<UserDO>;
    const sessionRow = await userDO.getSessionById(id);
    if (!sessionRow) {
      return c.json({ error: "Session not found" }, 404 as const);
    }

    // Get SessionDO for cleanup
    let sessionDO;
    try {
      const doId = c.env.SESSION_DO.idFromString(id);
      sessionDO = c.env.SESSION_DO.get(doId);
    } catch {
      // Invalid ID — just remove from index
      await userDO.removeSession(id);
      return c.json({ ok: true }, 200);
    }

    const session = await sessionDO.getSession();
    if (!session) {
      // SessionDO already cleared — just clean up index
      await userDO.removeSession(id);
      return c.json({ ok: true }, 200);
    }

    // Step 1: Best-effort stop container process
    try {
      const container = getContainer(
        c.env.AGENT_CONTAINER,
        session.containerName
      );
      await container.fetch("http://container/stop", { method: "POST" });
    } catch (err) {
      console.error("Delete: container stop failed (ok):", err);
    }

    // Step 2: Clear R2 workspace snapshot
    try {
      await c.env.SNAPSHOTS.delete(`workspace-snapshots/${id}/snapshot.tar.zst`);
    } catch (err) {
      console.error("Delete: R2 snapshot cleanup failed (ok):", err);
    }

    // Step 3: Clear SessionDO storage
    try {
      await sessionDO.deleteSession();
    } catch (err) {
      console.error("Delete: session DO cleanup failed (ok):", err);
    }

    // Step 4: Remove from UserDO index
    try {
      await userDO.removeSession(id);
    } catch (err) {
      console.error("Delete: index removal failed:", err);
      return c.json({ error: "Failed to remove session from index" }, 500 as const);
    }

    return c.json({ ok: true }, 200);
  });

  // ── WebSocket upgrade → SessionDO ────────────────────────────────────
  // WebSocket upgrades don't fit OpenAPI — kept as a plain route.
  router.get("/api/sessions/:id/ws", async (c) => {
    const { id } = c.req.param();

    // Verify upgrade header
    const upgrade = c.req.header("Upgrade");
    if (upgrade !== "websocket") {
      return c.json({ error: "Expected WebSocket upgrade" }, 426);
    }

    // Verify session belongs to this user
    const userDO = c.get("userDOStub") as DurableObjectStub<UserDO>;
    const sessionRow = await userDO.getSessionById(id);
    if (!sessionRow) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Look up SessionDO
    let sessionDO;
    try {
      const doId = c.env.SESSION_DO.idFromString(id);
      sessionDO = c.env.SESSION_DO.get(doId);
    } catch {
      return c.json({ error: "Invalid session ID" }, 400);
    }

    // Forward WebSocket upgrade to SessionDO
    return sessionDO.fetch(c.req.raw);
  });

  return router;
};
