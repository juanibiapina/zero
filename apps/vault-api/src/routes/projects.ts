/**
 * ============================================================================
 * Project Routes (/v1/projects + /api/projects)
 * ============================================================================
 *
 * Projects span two DOs: the registry row lives in OrgDO, the vault (DEK,
 * environments, secrets) lives in a per-project ProjectVaultDO. These routes
 * are the only place that orchestrates both.
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { getOrgVault, getProjectVault } from "../vaults";

type Variables = { userId: string; orgId: string };

function projectHandlers() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.get("/", async (c) => {
    const projects = await getOrgVault(c).listProjects();
    return c.json({ projects }, 200);
  });

  app.post("/", async (c) => {
    const body = await c.req.json<{ name: string }>();
    const project = await getOrgVault(c).createProject(body.name);

    if (project === null) {
      return c.json({ error: `Project '${body.name}' already exists` }, 409);
    }

    // Initialize the per-project vault (mint DEK + default envs). Recombine to
    // preserve the public 201 response shape.
    const environments = await getProjectVault(c, project.name).initialize();
    return c.json({ ...project, environments }, 201);
  });

  app.delete("/:project", async (c) => {
    const projectName = c.req.param("project");

    // Registry-row-first: the project disappears from listing before its DEK is
    // shredded. destroy() is idempotent, so a crash between the two is safe.
    const existed = await getOrgVault(c).deleteProject(projectName);
    if (!existed) {
      return c.json({ error: "Project not found" }, 404);
    }

    await getProjectVault(c, projectName).destroy();
    return new Response(null, { status: 204 });
  });

  return app;
}

export const createProjectsRouter = (_env: Env) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const handlers = projectHandlers();
  app.route("/v1/projects", handlers);
  app.route("/api/projects", handlers);
  return app;
};
