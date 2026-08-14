/**
 * ============================================================================
 * Zero CLI — browser sign-in (OAuth 2.0 authorization code + PKCE)
 * ============================================================================
 *
 * `zero login` trades a browser approval for a token pair, so a developer's
 * machine holds a personal, org-scoped, individually revocable credential
 * instead of the org-wide `zv_` key that also runs CI.
 *
 * Shape forced by the identity provider (all measured against the live
 * instance, see docs/plans/cli-oidc-login.md):
 *
 * - Authorization code + PKCE S256 only; there is no device flow, so a headless
 *   box needs a forwarded port or an API key.
 * - The client is public: a client id ships in this file, and no secret does.
 * - `user:org:read` is what puts `org_id` in the token, and the API cannot route
 *   a request without it.
 * - The redirect must be `http://127.0.0.1:<any port>/callback`: the port is a
 *   wildcard, but the host spelling and the path are not (`localhost` fails).
 * - Access tokens last a day, refresh tokens do not expire but **rotate**, and
 *   replaying an old refresh token revokes the whole family. So a rotated pair
 *   is persisted before it is used.
 *
 * This module is transport and token handling only: no process exit, no stdout,
 * no browser launch. `commands/login.ts` owns those.
 */

import crypto from "node:crypto";

/** The Clerk instance that owns dashboard accounts and their organizations. */
export const DEFAULT_ISSUER = "https://clerk.zeroapps.dev";

/** Public client id for "Zero CLI". Not a secret: it ships in every install. */
export const DEFAULT_CLIENT_ID = "2kOnZBfUZx8kl0KL";

const SCOPES = ["openid", "profile", "email", "offline_access", "user:org:read"];

/** Refresh this long before expiry, so a slow request cannot outrun the token. */
const REFRESH_MARGIN_MS = 60_000;

/** A signed-in machine's credential for one API origin. */
export interface Login {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  userId: string;
  orgId: string | null;
  email?: string;
  /** Recorded so a re-login or logout talks to the instance that issued it. */
  issuer: string;
  clientId: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(40).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: SCOPES.join(" "),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  return `${input.issuer}/oauth/authorize?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
};

/** Reads claims out of an id token. The CLI displays them; it never trusts them. */
function readIdToken(idToken: string | undefined): {
  sub?: string;
  org_id?: string;
  email?: string;
} {
  if (!idToken) return {};
  const payload = idToken.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: string;
      org_id?: string;
      email?: string;
    };
  } catch {
    return {};
  }
}

async function postToken(
  issuer: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !data.access_token) {
    // Clerk's description says which of the many invalid_grant causes it was;
    // a generic "login failed" would hide "code is expired" from the user.
    throw new Error(data.error_description ?? data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

function toLogin(
  data: TokenResponse,
  previous: { issuer: string; clientId: string; refreshToken?: string },
): Login {
  const claims = readIdToken(data.id_token);
  return {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? previous.refreshToken!,
    expiresAt: Date.now() + (data.expires_in ?? 0) * 1000,
    userId: claims.sub ?? "",
    orgId: claims.org_id ?? null,
    email: claims.email,
    issuer: previous.issuer,
    clientId: previous.clientId,
  };
}

export async function exchangeCode(
  input: {
    issuer: string;
    clientId: string;
    code: string;
    verifier: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<Login> {
  const data = await postToken(
    input.issuer,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    }),
    fetchImpl,
  );
  return toLogin(data, { issuer: input.issuer, clientId: input.clientId });
}

export async function refreshLogin(
  login: Login,
  fetchImpl: typeof fetch = fetch,
): Promise<Login> {
  const data = await postToken(
    login.issuer,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: login.refreshToken,
      client_id: login.clientId,
    }),
    fetchImpl,
  );
  return toLogin(data, {
    issuer: login.issuer,
    clientId: login.clientId,
    refreshToken: login.refreshToken,
  });
}

/**
 * The login to use for a request: the stored one, or a refreshed one, or null
 * when the session is over and the user must sign in again.
 *
 * The refreshed pair is saved *before* it is handed out, because the provider
 * rotates refresh tokens and treats a replay as theft: losing the new token
 * after using it would lock the user out of their own session.
 */
export async function freshAccessToken(
  login: Login,
  deps: { save: (login: Login) => void; fetchImpl?: typeof fetch },
): Promise<Login | null> {
  if (login.expiresAt - REFRESH_MARGIN_MS > Date.now()) return login;

  try {
    const refreshed = await refreshLogin(login, deps.fetchImpl ?? fetch);
    deps.save(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

/**
 * Ends the session server-side. Never throws: `zero logout` must still be able
 * to drop the local credential when the network or the provider is down.
 */
export async function revokeLogin(
  login: Login,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(`${login.issuer}/oauth/token/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: login.refreshToken,
        client_id: login.clientId,
      }).toString(),
    });
  } catch {
    // Local state is cleared by the caller regardless.
  }
}
