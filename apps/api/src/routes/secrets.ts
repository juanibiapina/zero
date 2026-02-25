/**
 * ============================================================================
 * Secrets Routes
 * ============================================================================
 *
 * GET    /api/secrets          — List secret names + createdAt (values never returned)
 * POST   /api/secrets          — Create or update a secret { name, value }
 * DELETE /api/secrets/:name    — Delete a secret
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../types";
import type { UserDOReferences } from "@zero/core";
import type { UserDO } from "../UserDO";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

export const createSecretsRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List secrets (names only) ─────────────────────────────────────────
  router.get("/api/secrets", async (c) => {
    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    const secrets = await userDO.listUserSecrets();
    return c.json({ secrets });
  });

  // ── Create or update a secret ─────────────────────────────────────────
  router.post("/api/secrets", async (c) => {
    const body = await c.req.json<{ name?: string; value?: string }>();
    if (!body.name || !body.value) {
      return c.json({ error: "Missing required fields: name, value" }, 400);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.upsertUserSecret(body.name, body.value);
    return c.json({ success: true });
  });

  // ── Delete a secret ────────────────────────────────────────────────────
  router.delete("/api/secrets/:name", async (c) => {
    const name = c.req.param("name");

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.deleteUserSecret(name);
    return c.json({ success: true });
  });

  return router;
};
