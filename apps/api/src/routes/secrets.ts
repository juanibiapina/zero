/**
 * ============================================================================
 * Secrets Routes
 * ============================================================================
 *
 * GET    /api/secrets          — List secret names + createdAt (values never returned)
 * POST   /api/secrets          — Create or update a secret { name, value }
 * DELETE /api/secrets/:name    — Delete a secret
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import type { UserDOReferences } from "@zero/core";
import type { UserDO } from "../UserDO";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

// ── Schemas ──────────────────────────────────────────────────────────────

const SecretSummarySchema = z.object({
  name: z.string(),
  createdAt: z.string(),
});

const SecretListResponseSchema = z.object({
  secrets: z.array(SecretSummarySchema),
});

const CreateSecretBodySchema = z.object({
  name: z.string(),
  value: z.string(),
});

const SecretNameParamSchema = z.object({
  name: z.string().openapi({
    param: { name: "name", in: "path" },
    description: "Secret name",
  }),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const SuccessSchema = z.object({
  success: z.boolean(),
});

// ── Route definitions ────────────────────────────────────────────────────

const listSecretsRoute = createRoute({
  method: "get",
  path: "/api/secrets",
  tags: ["Secrets"],
  summary: "List secrets",
  description: "Lists secret names and creation dates. Values are never returned.",
  responses: {
    200: {
      content: { "application/json": { schema: SecretListResponseSchema } },
      description: "List of secret names",
    },
  },
});

const createSecretRoute = createRoute({
  method: "post",
  path: "/api/secrets",
  tags: ["Secrets"],
  summary: "Create or update secret",
  description: "Creates a new secret or updates an existing one.",
  request: {
    body: {
      content: { "application/json": { schema: CreateSecretBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Secret saved",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Missing required fields",
    },
  },
});

const deleteSecretRoute = createRoute({
  method: "delete",
  path: "/api/secrets/{name}",
  tags: ["Secrets"],
  summary: "Delete secret",
  description: "Deletes a secret by name.",
  request: {
    params: SecretNameParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Secret deleted",
    },
  },
});

// ── Router ───────────────────────────────────────────────────────────────

export const createSecretsRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List secrets (names only) ─────────────────────────────────────────
  router.openapi(listSecretsRoute, async (c) => {
    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    const rows = await userDO.listUserSecrets();
    return c.json({ secrets: rows.map((s) => ({ name: s.name, createdAt: s.createdAt })) }, 200);
  });

  // ── Create or update a secret ─────────────────────────────────────────
  router.openapi(createSecretRoute, async (c) => {
    const { name, value } = c.req.valid("json");

    if (!name || !value) {
      return c.json({ error: "Missing required fields: name, value" }, 400 as const);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.upsertUserSecret(name, value);
    return c.json({ success: true }, 200);
  });

  // ── Delete a secret ────────────────────────────────────────────────────
  router.openapi(deleteSecretRoute, async (c) => {
    const { name } = c.req.valid("param");

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.deleteUserSecret(name);
    return c.json({ success: true }, 200);
  });

  return router;
};
