/**
 * ============================================================================
 * Provider Routes
 * ============================================================================
 *
 * GET    /api/providers                  — List providers + connection status
 * POST   /api/providers/:id/connect      — Start OAuth flow (returns auth URL)
 * POST   /api/providers/:id/callback     — Complete OAuth flow
 * POST   /api/providers/:id/api-key      — Set API key
 * DELETE /api/providers/:id              — Disconnect provider
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../types";
import { UserService } from "../services/user";
import { serviceResult } from "../lib/result";
import { getModels, getProviderMeta, getDefaultModel } from "@zero/providers";

// ── Schemas ──────────────────────────────────────────────────────────────

const ProviderIdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    description: "Provider identifier (e.g. 'anthropic')",
  }),
});

const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  credentialType: z.enum(["oauth", "api_key"]).nullable(),
  supportsOAuth: z.boolean(),
  supportsApiKey: z.boolean(),
});

const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderInfoSchema),
});

const OAuthConnectResponseSchema = z.object({
  authUrl: z.string(),
  state: z.string(),
});

const OAuthCallbackBodySchema = z.object({
  code: z.string(),
  state: z.string().optional(),
});

const ApiKeyBodySchema = z.object({
  apiKey: z.string(),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const SuccessSchema = z.object({
  success: z.boolean(),
});

// ── Router ───────────────────────────────────────────────────────────────

export const createProviderRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();

  // ── List providers ──────────────────────────────────────────────────

  const listProvidersRoute = createRoute({
    method: "get",
    path: "/api/providers",
    tags: ["Providers"],
    summary: "List providers",
    description: "Lists all known providers with their connection status for the authenticated user.",
    responses: {
      200: {
        content: { "application/json": { schema: ProviderListResponseSchema } },
        description: "List of providers",
      },
    },
  });

  router.openapi(listProvidersRoute, async (c) => {
    const service = new UserService(c.env, c.get("userId"));
    return c.json(await service.listProviders(), 200);
  });

  // ── Start OAuth flow (Anthropic PKCE) ──────────────────────────────

  const connectProviderRoute = createRoute({
    method: "post",
    path: "/api/providers/{id}/connect",
    tags: ["Providers"],
    summary: "Start OAuth flow",
    description: "Initiates an OAuth PKCE flow for the provider. Returns the authorization URL.",
    request: {
      params: ProviderIdParamSchema,
    },
    responses: {
      200: {
        content: { "application/json": { schema: OAuthConnectResponseSchema } },
        description: "Authorization URL and state",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "OAuth not supported for this provider",
      },
    },
  });

  router.openapi(connectProviderRoute, async (c) => {
    const { id: providerId } = c.req.valid("param");
    const service = new UserService(c.env, c.get("userId"));
    const result = await service.startOAuthFlow(providerId);
    return serviceResult(c, result, 200);
  });

  // ── Complete OAuth flow ────────────────────────────────────────────

  const oauthCallbackRoute = createRoute({
    method: "post",
    path: "/api/providers/{id}/callback",
    tags: ["Providers"],
    summary: "Complete OAuth flow",
    description: "Exchanges the authorization code for tokens and stores the credential.",
    request: {
      params: ProviderIdParamSchema,
      body: {
        content: { "application/json": { schema: OAuthCallbackBodySchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "OAuth flow completed",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Invalid provider, missing state, or token exchange failed",
      },
    },
  });

  router.openapi(oauthCallbackRoute, async (c) => {
    const { id: providerId } = c.req.valid("param");
    const { code, state } = c.req.valid("json");
    const service = new UserService(c.env, c.get("userId"));
    const result = await service.completeOAuthFlow(providerId, code, state);
    return serviceResult(c, result, 200);
  });

  // ── Set API key ────────────────────────────────────────────────────

  const setApiKeyRoute = createRoute({
    method: "post",
    path: "/api/providers/{id}/api-key",
    tags: ["Providers"],
    summary: "Set API key",
    description: "Sets an API key credential for a provider.",
    request: {
      params: ProviderIdParamSchema,
      body: {
        content: { "application/json": { schema: ApiKeyBodySchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "API key saved",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "API key not supported or missing",
      },
    },
  });

  router.openapi(setApiKeyRoute, async (c) => {
    const { id: providerId } = c.req.valid("param");
    const { apiKey } = c.req.valid("json");
    const service = new UserService(c.env, c.get("userId"));
    const result = await service.setApiKey(providerId, apiKey);
    return serviceResult(c, result, 200);
  });

  // ── Disconnect provider ────────────────────────────────────────────

  const disconnectProviderRoute = createRoute({
    method: "delete",
    path: "/api/providers/{id}",
    tags: ["Providers"],
    summary: "Disconnect provider",
    description: "Removes the stored credential for a provider.",
    request: {
      params: ProviderIdParamSchema,
    },
    responses: {
      200: {
        content: { "application/json": { schema: SuccessSchema } },
        description: "Provider disconnected",
      },
    },
  });

  router.openapi(disconnectProviderRoute, async (c) => {
    const { id: providerId } = c.req.valid("param");
    const service = new UserService(c.env, c.get("userId"));
    return c.json(await service.disconnectProvider(providerId), 200);
  });

  // ── List models for a provider ─────────────────────────────────────

  const ModelSchema = z.object({
    id: z.string(),
    name: z.string(),
    reasoning: z.boolean(),
  });

  const ModelListResponseSchema = z.object({
    models: z.array(ModelSchema),
    defaultModelId: z.string().nullable(),
  });

  const listModelsRoute = createRoute({
    method: "get",
    path: "/api/providers/{id}/models",
    tags: ["Providers"],
    summary: "List models for a provider",
    description: "Returns the available models for a specific provider.",
    request: {
      params: ProviderIdParamSchema,
    },
    responses: {
      200: {
        content: { "application/json": { schema: ModelListResponseSchema } },
        description: "List of models",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Provider not found",
      },
    },
  });

  router.openapi(listModelsRoute, async (c) => {
    const { id: providerId } = c.req.valid("param");
    const meta = getProviderMeta(providerId);
    if (!meta) {
      return c.json({ error: "Provider not found" }, 404);
    }
    const models = getModels(providerId as Parameters<typeof getModels>[0]);
    const defaultModelId = getDefaultModel(providerId) ?? null;
    return c.json({
      models: models.map((m) => ({ id: m.id, name: m.name ?? m.id, reasoning: m.reasoning })),
      defaultModelId,
    }, 200);
  });

  return router;
};
