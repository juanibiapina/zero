/**
 * ============================================================================
 * Project Routes
 * ============================================================================
 *
 * GET  /api/projects                    — List user's repos from GitHub API
 * PUT  /api/projects/:owner/:repo/model — Set default model for a project
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../types";
import type { UserDOReferences, ProjectSummary } from "@zero/core";
import type { UserDO } from "../UserDO";
import { getInstallationToken, listInstallationRepos } from "../services/github";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

export const createProjectRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List projects (repos from the user's GitHub installation) ────────────
  router.get("/api/projects", async (c) => {
    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    const installation = await userDO.getGitHubInstallation();
    const installUrl = getInstallUrl(c.env);

    if (!installation) {
      return c.json({ projects: [], installUrl });
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
      return c.json({ projects: [], installUrl, errors: [msg] });
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

    return c.json({ projects: allRepos, installUrl });
  });

  // ── Set default model for a project ────────────────────────────────────
  router.put("/api/projects/:owner/:repo/model", async (c) => {
    const { owner, repo } = c.req.param();
    const body = await c.req.json<{ provider: string; model: string }>();

    if (!body.provider || !body.model) {
      return c.json({ error: "Missing provider or model" }, 400);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.updateProjectModel(owner, repo, body.provider, body.model);
    return c.json({ success: true });
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
