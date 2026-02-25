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
import type { UserDOReferences, ProviderInfo } from "@zero/core";
import type { UserDO } from "../UserDO";

type Variables = {
  userId: string;
  userDOStub: DurableObjectStub;
  doRefs: UserDOReferences;
};

// Anthropic OAuth constants (extracted from @mariozechner/pi-ai source)
const ANTHROPIC_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference",
};

/** Known providers and their capabilities. */
const PROVIDER_REGISTRY: Record<
  string,
  { name: string; supportsOAuth: boolean; supportsApiKey: boolean }
> = {
  anthropic: { name: "Anthropic", supportsOAuth: true, supportsApiKey: true },
};

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
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

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
    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    const credentials = await userDO.listProviderCredentials();
    const connectedSet = new Set(credentials.map((cr) => cr.provider));

    const providers: ProviderInfo[] = Object.entries(PROVIDER_REGISTRY).map(
      ([id, info]) => ({
        id,
        name: info.name,
        connected: connectedSet.has(id),
        credentialType: credentials.find((cr) => cr.provider === id)?.credentialType as ProviderInfo["credentialType"] ?? null,
        supportsOAuth: info.supportsOAuth,
        supportsApiKey: info.supportsApiKey,
      })
    );

    return c.json({ providers }, 200);
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
    if (providerId !== "anthropic") {
      return c.json({ error: "OAuth not supported for this provider" }, 400 as const);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    // Generate PKCE challenge
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const verifier = btoa(String.fromCharCode(...verifierBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const challengeBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeBuffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    // Random state token
    const state = crypto.randomUUID();

    // Store verifier in UserDO
    await userDO.storePKCEVerifier(state, verifier, providerId);

    // Build authorization URL
    // Note: Anthropic's flow uses `code=true` and passes the verifier as `state`
    // (the verifier is needed both as state and for PKCE verification)
    const params = new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_OAUTH.clientId,
      response_type: "code",
      redirect_uri: ANTHROPIC_OAUTH.redirectUri,
      scope: ANTHROPIC_OAUTH.scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
    });

    const authUrl = `${ANTHROPIC_OAUTH.authorizeUrl}?${params}`;
    return c.json({ authUrl, state }, 200);
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
    if (providerId !== "anthropic") {
      return c.json({ error: "OAuth not supported for this provider" }, 400 as const);
    }

    const body = c.req.valid("json");
    const code = body.code;

    // Parse code#state format from Anthropic
    let actualCode = code;
    let state = body.state;
    if (code.includes("#")) {
      const parts = code.split("#");
      actualCode = parts[0];
      state = state || parts[1];
    }

    if (!state) {
      return c.json({ error: "Missing state parameter" }, 400 as const);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    // Retrieve stored PKCE verifier
    const pkce = await userDO.consumePKCEVerifier(state);
    if (!pkce) {
      return c.json({ error: "Invalid or expired state" }, 400 as const);
    }

    // Exchange code for tokens
    const tokenResp = await fetch(ANTHROPIC_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: ANTHROPIC_OAUTH.clientId,
        code: actualCode,
        state,
        redirect_uri: ANTHROPIC_OAUTH.redirectUri,
        code_verifier: pkce.verifier,
      }),
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      console.error("Token exchange failed:", err);
      return c.json({ error: "Token exchange failed" }, 400 as const);
    }

    const tokens = (await tokenResp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    await userDO.upsertProviderCredential({
      provider: providerId,
      credentialType: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
    });

    return c.json({ success: true }, 200);
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
    const providerConfig = PROVIDER_REGISTRY[providerId];
    if (!providerConfig?.supportsApiKey) {
      return c.json({ error: "API key not supported for this provider" }, 400 as const);
    }

    const { apiKey } = c.req.valid("json");
    if (!apiKey) {
      return c.json({ error: "Missing apiKey" }, 400 as const);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.upsertProviderCredential({
      provider: providerId,
      credentialType: "api_key",
      apiKey,
    });

    return c.json({ success: true }, 200);
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

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.deleteProviderCredential(providerId);
    return c.json({ success: true }, 200);
  });

  return router;
};
