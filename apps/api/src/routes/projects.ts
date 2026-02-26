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
import type { ProjectSummary } from "@zero/core";
import type { UserDO } from "../UserDO";
import { getInstallationToken, listInstallationRepos } from "../services/github";

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

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Fetch repos from GitHub API and sync into UserDO.
 * Returns the fresh project list as ProjectSummary[].
 */
async function syncFromGitHub(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  installationId: number,
): Promise<{ projects: ProjectSummary[]; errors: string[] }> {
  const allRepos: ProjectSummary[] = [];

  try {
    const token = await getInstallationToken(env, installationId);
    const repos = await listInstallationRepos(token);
    for (const repo of repos) {
      allRepos.push({
        owner: repo.owner.login,
        repo: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        defaultBranch: repo.default_branch,
        private: repo.private,
        archived: repo.archived,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to list repos for installation ${installationId}:`, err);
    return { projects: [], errors: [msg] };
  }

  await userDO.syncProjects(
    allRepos.map((r) => ({
      owner: r.owner,
      repo: r.repo,
      fullName: r.fullName,
      description: r.description,
      defaultBranch: r.defaultBranch,
      isPrivate: r.private,
      archived: r.archived,
    })),
  );

  return { projects: allRepos, errors: [] };
}

/**
 * Convert DB rows to ProjectSummary[].
 */
function rowsToSummaries(
  rows: {
    owner: string;
    repo: string;
    fullName: string | null;
    description: string | null;
    defaultBranch: string | null;
    isPrivate: boolean | null;
    archived: boolean | null;
  }[],
): ProjectSummary[] {
  return rows.map((r) => ({
    owner: r.owner,
    repo: r.repo,
    fullName: r.fullName ?? `${r.owner}/${r.repo}`,
    description: r.description,
    defaultBranch: r.defaultBranch ?? "main",
    private: r.isPrivate ?? false,
    archived: r.archived ?? false,
  }));
}

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
    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!,
      ),
    );

    const installation = await userDO.getGitHubInstallation();
    const installUrl = getInstallUrl(c.env);

    if (!installation) {
      return c.json({ projects: [], installUrl }, 200);
    }

    const rows = await userDO.listProjects();

    // Auto-sync on first use (empty cache or pre-migration rows without fullName)
    if (rows.length === 0 || rows[0].fullName === null) {
      const result = await syncFromGitHub(c.env, userDO, installation.installationId);
      return c.json(
        { projects: result.projects, installUrl, errors: result.errors.length > 0 ? result.errors : undefined },
        200,
      );
    }

    return c.json({ projects: rowsToSummaries(rows), installUrl }, 200);
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
    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!,
      ),
    );

    const installation = await userDO.getGitHubInstallation();
    const installUrl = getInstallUrl(c.env);

    if (!installation) {
      return c.json({ projects: [], installUrl }, 200);
    }

    const result = await syncFromGitHub(c.env, userDO, installation.installationId);
    return c.json(
      { projects: result.projects, installUrl, errors: result.errors.length > 0 ? result.errors : undefined },
      200,
    );
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

    if (!provider || !model) {
      return c.json({ error: "Missing provider or model" }, 400 as const);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!,
      ),
    );

    await userDO.updateProjectModel(owner, repo, provider, model);
    return c.json({ success: true }, 200);
  });

  return router;
};

/**
 * GitHub App installation URL for the user to install the app on their account.
 * The setup URL configured in the GitHub App settings handles the redirect back
 * to our /github/setup page, which links the installation to the user's account.
 */
function getInstallUrl(env: Env): string {
  const base = "https://github.com/apps/zerocoding-app/installations/new";
  if (env.ENVIRONMENT === "development") {
    return `${base}?state=localhost:5176`;
  }
  return base;
}
