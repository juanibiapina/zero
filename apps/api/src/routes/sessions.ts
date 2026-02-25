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

import { OpenAPIHono } from "@hono/zod-openapi";
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

export const createSessionRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List sessions ──────────────────────────────────────────────────────
  router.get("/api/sessions", async (c) => {
    const owner = c.req.query("owner");
    const repo = c.req.query("repo");

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
    });
  });

  // ── Delete session ────────────────────────────────────────────────────
  router.delete("/api/sessions/:id", async (c) => {
    const { id } = c.req.param();

    // Verify session belongs to this user
    const userDO = c.get("userDOStub") as DurableObjectStub<UserDO>;
    const sessionRow = await userDO.getSessionById(id);
    if (!sessionRow) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Get SessionDO for cleanup
    let sessionDO;
    try {
      const doId = c.env.SESSION_DO.idFromString(id);
      sessionDO = c.env.SESSION_DO.get(doId);
    } catch {
      // Invalid ID — just remove from index
      await userDO.removeSession(id);
      return c.json({ ok: true });
    }

    const session = await sessionDO.getSession();
    if (!session) {
      // SessionDO already cleared — just clean up index
      await userDO.removeSession(id);
      return c.json({ ok: true });
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
      return c.json({ error: "Failed to remove session from index" }, 500);
    }

    return c.json({ ok: true });
  });

  // ── Create session ──────────────────────────────────────────────────────
  router.post("/api/sessions", async (c) => {
    const body = await c.req.json<{ owner: string; repo: string; prompt?: string }>();
    const { owner, repo } = body;

    if (!owner || !repo) {
      return c.json({ error: "owner and repo are required" }, 400);
    }

    // Verify user has access to this project
    const doRefs = c.get("doRefs");
    const projectRef = doRefs.projects.find(
      (p) => p.owner === owner && p.repo === repo
    );
    if (!projectRef) {
      return c.json({ error: "Project not found" }, 404);
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
        400
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
        prompt: body.prompt,
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
        500
      );
    }
  });

  // ── WebSocket upgrade → SessionDO ─────────────────────────────────────
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
