/**
 * ============================================================================
 * Secrets Routes (/v1/projects/:project/environments/:env/secrets + /api/...)
 * ============================================================================
 *
 * One DO hop, no OrgDO round-trip on the hot path. A non-existent/deleted
 * project addresses an empty ProjectVaultDO whose env resolution returns
 * null/false → 404 (same semantics as before, without an OrgDO lookup).
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { getProjectVault } from "../vaults";

type Variables = { userId: string; orgId: string };

function secretsHandlers() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.get("/", async (c) => {
    const projectName = c.req.param("project")!;
    const envName = c.req.param("env")!;
    const secrets = await getProjectVault(c, projectName).getSecrets(envName);

    if (secrets === null) {
      return c.json({ error: "Project or environment not found" }, 404);
    }

    return c.json({ secrets }, 200);
  });

  app.put("/", async (c) => {
    const projectName = c.req.param("project")!;
    const envName = c.req.param("env")!;
    const body = await c.req.json<{ secrets: { key: string; value: string }[] }>();
    const ok = await getProjectVault(c, projectName).putSecrets(envName, body.secrets);

    if (!ok) {
      return c.json({ error: "Project or environment not found" }, 404);
    }

    return c.json({ ok: true }, 200);
  });

  app.patch("/", async (c) => {
    const projectName = c.req.param("project")!;
    const envName = c.req.param("env")!;
    const body = await c.req.json<{
      secrets: { key: string; value: string | null }[];
    }>();
    const ok = await getProjectVault(c, projectName).patchSecrets(envName, body.secrets);

    if (!ok) {
      return c.json({ error: "Project or environment not found" }, 404);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}

export const createSecretsRouter = (_env: Env) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const handlers = secretsHandlers();
  app.route("/v1/projects/:project/environments/:env/secrets", handlers);
  app.route("/api/projects/:project/environments/:env/secrets", handlers);
  return app;
};
