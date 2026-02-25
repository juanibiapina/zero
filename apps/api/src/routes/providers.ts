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

import { OpenAPIHono } from "@hono/zod-openapi";
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

export const createProviderRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  // ── List providers ──────────────────────────────────────────────────────
  router.get("/api/providers", async (c) => {
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

    return c.json({ providers });
  });

  // ── Start OAuth flow (Anthropic PKCE) ──────────────────────────────────
  router.post("/api/providers/:id/connect", async (c) => {
    const providerId = c.req.param("id");
    if (providerId !== "anthropic") {
      return c.json({ error: "OAuth not supported for this provider" }, 400);
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
    return c.json({ authUrl, state });
  });

  // ── Complete OAuth flow ────────────────────────────────────────────────
  router.post("/api/providers/:id/callback", async (c) => {
    const providerId = c.req.param("id");
    if (providerId !== "anthropic") {
      return c.json({ error: "OAuth not supported for this provider" }, 400);
    }

    const body = await c.req.json<{ code: string; state?: string }>();
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
      return c.json({ error: "Missing state parameter" }, 400);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    // Retrieve stored PKCE verifier
    const pkce = await userDO.consumePKCEVerifier(state);
    if (!pkce) {
      return c.json({ error: "Invalid or expired state" }, 400);
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
      return c.json({ error: "Token exchange failed" }, 400);
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

    return c.json({ success: true });
  });

  // ── Set API key ────────────────────────────────────────────────────────
  router.post("/api/providers/:id/api-key", async (c) => {
    const providerId = c.req.param("id");
    const providerConfig = PROVIDER_REGISTRY[providerId];
    if (!providerConfig?.supportsApiKey) {
      return c.json({ error: "API key not supported for this provider" }, 400);
    }

    const body = await c.req.json<{ apiKey: string }>();
    if (!body.apiKey) {
      return c.json({ error: "Missing apiKey" }, 400);
    }

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.upsertProviderCredential({
      provider: providerId,
      credentialType: "api_key",
      apiKey: body.apiKey,
    });

    return c.json({ success: true });
  });

  // ── Disconnect provider ────────────────────────────────────────────────
  router.delete("/api/providers/:id", async (c) => {
    const providerId = c.req.param("id");

    const userDO = c.env.USER_DO.get(
      c.env.USER_DO.idFromString(
        (await c.env.KV.get(`user:${c.get("userId")}`))!
      )
    ) as DurableObjectStub<UserDO>;

    await userDO.deleteProviderCredential(providerId);
    return c.json({ success: true });
  });

  return router;
};
