/**
 * ============================================================================
 * Zero Auth — Shared API Key Authentication
 * ============================================================================
 *
 * The suite's shared front door. A `zv_` key created in ZeroVault authorizes
 * every product (ZeroVault, ZeroErrors, ...). Keys are opaque tokens
 * (zv_<random>) validated via a KV lookup keyed by SHA-256 of the token.
 *
 * Key lifecycle (create, revoke) lives entirely in ZeroVault; other products
 * only read. This package owns the read path: hashing and validation.
 */

/**
 * Versioned JSON value stored in KV for each API key.
 *
 * v2 keys are org-scoped: `orgId` routes the DOs, `userId` is the creator
 * (kept for attribution/logging). Legacy v1 keys ({ v: 1, userId }) are invalid
 * under the org model and rejected.
 */
export type ApiKeyKVValue = {
  v: 2;
  orgId: string;
  userId: string;
};

/**
 * Hashes an API key using SHA-256 for KV and DO storage.
 */
export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Who a request is acting as, and which credential answered.
 *
 * `via` exists for logging and for the CLI's `whoami`; nothing downstream
 * (DO routing, rate limiting) branches on it, and nothing should.
 */
export type AuthContext = {
  orgId: string;
  userId: string;
  via: "api_key" | "oauth";
};

/**
 * Verifies a Clerk OAuth access token. Returns the user and the org the token
 * was issued for, `orgId: null` when the token is valid but carries no org, or
 * null when it is invalid, expired or revoked.
 *
 * A port, not an implementation: the Clerk call lives in the Worker that owns
 * the network and the KV cache, so this package stays dependency-free and its
 * tests need neither.
 */
export type OAuthTokenVerifier = (
  token: string,
) => Promise<{ userId: string; orgId: string | null } | null>;

/**
 * Why a request was refused. `no_org` is separate on purpose: it is the one
 * failure a correct client hits (the user skipped the consent screen's org
 * selector), and it needs a message naming the fix rather than "invalid token".
 */
export type AuthFailure = "missing" | "invalid" | "no_org";

export type AuthOutcome =
  | { ok: true; auth: AuthContext }
  | { ok: false; reason: AuthFailure };

/**
 * The suite's front door for `/{product}/v1`: one header, two credential types.
 *
 * Routing is by prefix, not by trial: a `zv_` token is only ever a vault API
 * key and never reaches Clerk, so an unknown key cannot leak to a third party
 * and cannot cost a network round trip.
 */
export async function authenticate(
  deps: { apikeys: KVNamespace; verifyOAuthToken: OAuthTokenVerifier },
  authHeader: string | undefined,
): Promise<AuthOutcome> {
  const token = authHeader?.replace("Bearer ", "").trim();
  if (!token) return { ok: false, reason: "missing" };

  if (token.startsWith("zv_")) {
    const auth = await validateApiKey(deps.apikeys, token);
    return auth ? { ok: true, auth: { ...auth, via: "api_key" } } : { ok: false, reason: "invalid" };
  }

  const verified = await deps.verifyOAuthToken(token);
  if (!verified) return { ok: false, reason: "invalid" };
  if (!verified.orgId) return { ok: false, reason: "no_org" };

  return {
    ok: true,
    auth: { orgId: verified.orgId, userId: verified.userId, via: "oauth" },
  };
}

/**
 * Validates an API key and returns its org context, or null if invalid.
 * Rejects legacy v1 keys (returns null → 401).
 *
 * Takes the `APIKEYS` KVNamespace directly rather than a whole `Env`, so it
 * depends only on the binding it needs and is reusable across products.
 */
export async function validateApiKey(
  apikeys: KVNamespace,
  authHeader: string | undefined,
): Promise<{ orgId: string; userId: string } | null> {
  if (!authHeader) return null;

  const key = authHeader.replace("Bearer ", "");

  if (!key.startsWith("zv_")) return null;

  const keyHash = await hashApiKey(key);
  const raw = await apikeys.get(keyHash);

  if (!raw) return null;

  let data: { v?: number; orgId?: string; userId?: string };
  try {
    data = JSON.parse(raw) as { v?: number; orgId?: string; userId?: string };
  } catch {
    return null;
  }
  if (data.v !== 2 || !data.orgId || !data.userId) return null;

  return { orgId: data.orgId, userId: data.userId };
}

export { createClerkOAuthVerifier, frontendApiUrl } from "./clerk-oauth";
