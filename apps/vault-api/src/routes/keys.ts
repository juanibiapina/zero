/**
 * ============================================================================
 * API Key Management Routes (/v1/keys + /api/keys)
 * ============================================================================
 *
 * Create, list, and revoke org-scoped API keys (stored in OrgDO + KV).
 * Accessible via both API key auth (/v1/) and Clerk JWT auth (/api/).
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { getOrgVault } from "../vaults";

type Variables = { userId: string; orgId: string };
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export const createKeysRouter = (_env: Env) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  const create = async (c: Ctx) => {
    const body = await c.req
      .json<{ label?: string }>()
      .catch((): { label?: string } => ({}));
    const result = await getOrgVault(c).createApiKey(
      { orgId: c.get("orgId"), userId: c.get("userId") },
      body.label,
    );
    return c.json(result, 201);
  };

  const list = async (c: Ctx) => {
    const keys = await getOrgVault(c).listApiKeys();
    return c.json({ keys }, 200);
  };

  const revoke = async (c: Ctx) => {
    const id = parseInt(c.req.param("id")!, 10);
    await getOrgVault(c).revokeApiKey(id);
    return new Response(null, { status: 204 });
  };

  // API key auth (/vault/v1/)
  app.post("/vault/v1/keys", create);
  app.get("/vault/v1/keys", list);
  app.delete("/vault/v1/keys/:id", revoke);

  // Clerk JWT auth (/api/vault/)
  app.post("/api/vault/keys", create);
  app.get("/api/vault/keys", list);
  app.delete("/api/vault/keys/:id", revoke);

  return app;
};
