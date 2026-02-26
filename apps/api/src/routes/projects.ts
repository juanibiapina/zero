/**
 * ============================================================================
 * Project Routes
 * ============================================================================
 *
 * GET  /api/projects                    — List cached projects from DB
 * POST /api/projects/refresh            — Sync projects from GitHub API
 * PUT  /api/projects/:owner/:repo/model — Set default model for a project
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import { UserService } from "../services/user";
import { serviceResult } from "../lib/result";

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

const ProjectModelParamSchema = z.object({
  owner: z.string().openapi({
    param: { name: "owner", in: "path" },
    description: "Repository owner",
  }),
  repo: z.string().openapi({
    param: { name: "repo", in: "path" },
    description: "Repository name",
  }),
});

const SetModelBodySchema = z.object({
  provider: z.string(),
  model: z.string(),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const SuccessSchema = z.object({
  success: z.boolean(),
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

  // ── Set default model for a project ─────────────────────────────────

  const setProjectModelRoute = createRoute({
    method: "put",
    path: "/api/projects/{owner}/{repo}/model",
    tags: ["Projects"],
    summary: "Set default model",
    description: "Sets the default provider and model for a project.",
    request: {
      params: ProjectModelParamSchema,
      body: {
        content: { "application/json": { schema: SetModelBodySchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "Model updated",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing provider or model",
      },
    },
  });

  router.openapi(setProjectModelRoute, async (c) => {
    const { owner, repo } = c.req.valid("param");
    const { provider, model } = c.req.valid("json");
    const service = new UserService(c.env, c.get("userId"));
    const result = await service.setProjectModel(owner, repo, provider, model);
    return serviceResult(c, result, 200);
  });

  return router;
};
