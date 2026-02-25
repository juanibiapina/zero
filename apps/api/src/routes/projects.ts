/**
 * ============================================================================
 * Project Routes
 * ============================================================================
 *
 * GET  /api/projects                    — List user's repos from GitHub API
 * PUT  /api/projects/:owner/:repo/model — Set default model for a project
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import type { UserDOReferences, ProjectSummary } from "@zero/core";
import type { UserDO } from "../UserDO";
import { getInstallationToken, listInstallationRepos } from "../services/github";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

// ── Schemas ──────────────────────────────────────────────────────────────

const ProjectSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  fullName: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  private: z.boolean(),
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

// ── Route definitions ────────────────────────────────────────────────────

const listProjectsRoute = createRoute({
  method: "get",
  path: "/api/projects",
  tags: ["Projects"],
  summary: "List projects",
  description: "Lists all repos from the user's GitHub installation.",
  responses: {
    200: {
      content: { "application/json": { schema: ProjectListResponseSchema } },
      description: "List of projects with install URL",
    },
  },
});

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

// ── Router ───────────────────────────────────────────────────────────────

export const createProjectRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List projects (repos from the user's GitHub installation) ────────
  router.openapi(listProjectsRoute, async (c) => {
    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    const installation = await userDO.getGitHubInstallation();
    const installUrl = getInstallUrl(c.env);

    if (!installation) {
      return c.json({ projects: [], installUrl }, 200);
    }

    const allRepos: ProjectSummary[] = [];

    try {
      const token = await getInstallationToken(c.env, installation.installationId);
      const repos = await listInstallationRepos(token);
      for (const repo of repos) {
        allRepos.push({
          owner: repo.owner.login,
          repo: repo.name,
          fullName: repo.full_name,
          description: repo.description,
          defaultBranch: repo.default_branch,
          private: repo.private,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to list repos for installation ${installation.installationId}:`, err);
      return c.json({ projects: [], installUrl, errors: [msg] }, 200);
    }

    // Ensure each repo has a ProjectDO entry in UserDO
    for (const repo of allRepos) {
      const existing = await userDO.getProject(repo.owner, repo.repo);
      if (!existing) {
        const projectDOId = c.env.PROJECT_DO.newUniqueId().toString();
        await userDO.upsertProject({
          owner: repo.owner,
          repo: repo.repo,
          projectDOId,
        });
      }
    }

    return c.json({ projects: allRepos, installUrl }, 200);
  });

  // ── Set default model for a project ─────────────────────────────────
  router.openapi(setProjectModelRoute, async (c) => {
    const { owner, repo } = c.req.valid("param");
    const { provider, model } = c.req.valid("json");

    if (!provider || !model) {
      return c.json({ error: "Missing provider or model" }, 400 as const);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

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
