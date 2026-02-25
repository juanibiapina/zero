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
import { Result } from "@praha/byethrow";
import { SecretsService } from "../services/secrets";

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
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Internal error",
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
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Internal error",
    },
  },
});

// ── Router ───────────────────────────────────────────────────────────────

export const createSecretsRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List secrets (names only) ─────────────────────────────────────────
  router.openapi(listSecretsRoute, async (c) => {
    const service = new SecretsService(c.env, c.get("userId"));
    const result = await service.listSecrets();
    if (Result.isFailure(result)) {
      return c.json({ error: result.error.message }, 500 as const);
    }
    return c.json(result.value, 200);
  });

  // ── Create or update a secret ─────────────────────────────────────────
  router.openapi(createSecretRoute, async (c) => {
    const { name, value } = c.req.valid("json");
    const service = new SecretsService(c.env, c.get("userId"));
    const result = await service.upsertSecret(name, value);
    if (Result.isFailure(result)) {
      return c.json({ error: result.error.message }, 400 as const);
    }
    return c.json(result.value, 200);
  });

  // ── Delete a secret ────────────────────────────────────────────────────
  router.openapi(deleteSecretRoute, async (c) => {
    const { name } = c.req.valid("param");
    const service = new SecretsService(c.env, c.get("userId"));
    const result = await service.deleteSecret(name);
    if (Result.isFailure(result)) {
      return c.json({ error: result.error.message }, 500 as const);
    }
    return c.json(result.value, 200);
  });

  return router;
};
