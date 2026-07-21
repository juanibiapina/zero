/**
 * ============================================================================
 * Environment Routes (/v1/projects/:project/environments + /api/...)
 * ============================================================================
 *
 * All operations hit only the project's ProjectVaultDO (single hop, no OrgDO
 * round-trip). An unknown/deleted project addresses an empty vault, so listing
 * returns [] rather than 404 (avoids an OrgDO lookup on the hot path).
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { getProjectVault } from "../vaults";

type Variables = { userId: string; orgId: string };

function envHandlers() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.get("/", async (c) => {
    const projectName = c.req.param("project")!;
    const environments = await getProjectVault(c, projectName).listEnvironments();
    return c.json({ environments }, 200);
  });

  app.post("/", async (c) => {
    const projectName = c.req.param("project")!;
    const body = await c.req.json<{ name: string }>();

    try {
      const env = await getProjectVault(c, projectName).createEnvironment(body.name);
      return c.json(env, 201);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        return c.json(
          { error: `Environment '${body.name}' already exists in project '${projectName}'` },
          409,
        );
      }
      throw err;
    }
  });

  app.delete("/:env", async (c) => {
    const projectName = c.req.param("project")!;
    const envName = c.req.param("env")!;
    const deleted = await getProjectVault(c, projectName).deleteEnvironment(envName);

    if (!deleted) {
      return c.json({ error: "Environment not found" }, 404);
    }

    return new Response(null, { status: 204 });
  });

  return app;
}

export const createEnvironmentsRouter = (_env: Env) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const handlers = envHandlers();
  app.route("/v1/projects/:project/environments", handlers);
  app.route("/api/projects/:project/environments", handlers);
  return app;
};
