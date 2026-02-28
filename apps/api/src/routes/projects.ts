/**
 * ============================================================================
 * Project Routes
 * ============================================================================
 *
 * GET  /api/projects                    — List cached projects from DB
 * POST /api/projects/refresh            — Sync projects from GitHub API
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import { UserService } from "../services/user";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
};

// ── Schemas ──────────────────────────────────────────────────────────────

const ProjectSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  fullName: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
});

const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectSummarySchema),
  installUrl: z.string(),
  errors: z.array(z.string()).optional(),
});



// ── Router ───────────────────────────────────────────────────────────────

export const createProjectRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List projects (from cached DB rows) ─────────────────────────────

  const listProjectsRoute = createRoute({
    method: "get",
    path: "/api/projects",
    tags: ["Projects"],
    summary: "List projects",
    description:
      "Lists cached projects from the DB. Auto-syncs from GitHub on first use.",
    responses: {
      200: {
        content: { "application/json": { schema: ProjectListResponseSchema } },
        description: "List of projects with install URL",
      },
    },
  });

  router.openapi(listProjectsRoute, async (c) => {
    const service = new UserService(c.env, c.get("userId"));
    return c.json(await service.listProjects(), 200);
  });

  // ── Refresh projects (sync from GitHub API) ─────────────────────────

  const refreshProjectsRoute = createRoute({
    method: "post",
    path: "/api/projects/refresh",
    tags: ["Projects"],
    summary: "Refresh projects",
    description: "Syncs the project list from GitHub API and updates the cache.",
    responses: {
      200: {
        content: { "application/json": { schema: ProjectListResponseSchema } },
        description: "Refreshed list of projects",
      },
    },
  });

  router.openapi(refreshProjectsRoute, async (c) => {
    const service = new UserService(c.env, c.get("userId"));
    return c.json(await service.refreshProjects(), 200);
  });

  return router;
};
