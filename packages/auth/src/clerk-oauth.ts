/**
 * ============================================================================
 * Clerk OAuth token verification
 * ============================================================================
 *
 * Turns a Clerk OAuth access token (what `zero login` puts on a developer's
 * machine) into `{ userId, orgId }`, the same context a `zv_` API key yields.
 *
 * Verification is a call to Clerk's `/oauth/userinfo` rather than a local JWT
 * check, because the org matters and revocation matters:
 *
 * - `@clerk/backend`'s `oauth_token` auth object carries neither `claims` nor
 *   `orgId`, and ZeroVault routes every Durable Object by org.
 * - Access tokens live 1 day and cannot be shortened. A locally verified JWT
 *   keeps working for that day after a `zero logout` or a dashboard revoke;
 *   `userinfo` rejects it immediately (both measured against the live instance).
 *
 * The cost is one ~250ms round trip, cut to once per token per minute by the
 * KV cache below. `userinfo` needs no client secret, so the Worker holds no new
 * credential.
 *
 * This lives in `@zero/auth` rather than in the Worker because it depends on
 * nothing but `fetch` and a KV namespace: here its tests run anywhere, while in
 * `apps/vault-api` they would need workerd and so only ever run in CI.
 */

import { hashApiKey, type OAuthTokenVerifier } from "./index";

/** How long a verified token is trusted without asking Clerk again. */
const CACHE_TTL_SECONDS = 60;

type UserInfo = {
  user_id?: string;
  sub?: string;
  org_id?: string;
};

/** Reads the two fields we need out of an untrusted JSON body. */
function readUserInfo(body: unknown): UserInfo {
  if (typeof body !== "object" || body === null) return {};
  const record = body as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    user_id: str(record.user_id),
    sub: str(record.sub),
    org_id: str(record.org_id),
  };
}

/**
 * Clerk publishable keys are `pk_<env>_<base64 of "host$">`, so the instance's
 * Frontend API host travels with a secret the Worker already requires. Reading
 * it here means there is no second place to configure, and no way to point the
 * two at different instances.
 */
export function frontendApiUrl(publishableKey: string): string {
  const encoded = publishableKey.split("_").slice(2).join("_");
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  const host = atob(padded).replace(/\$$/, "");
  return `https://${host}`;
}

export function createClerkOAuthVerifier(deps: {
  publishableKey: string;
  cache: KVNamespace;
  fetchImpl?: typeof fetch;
}): OAuthTokenVerifier {
  const { publishableKey, cache, fetchImpl = fetch } = deps;
  const endpoint = `${frontendApiUrl(publishableKey)}/oauth/userinfo`;

  return async (token) => {
    // The token is a bearer credential; only its hash goes into KV, so a KV
    // dump never yields a usable credential.
    const cacheKey = `oauth:${await hashApiKey(token)}`;

    const cached = await cache.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as { userId: string; orgId: string | null };
    }

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Clerk unreachable. Refusing is the safe answer; API keys still work.
      return null;
    }

    if (!response.ok) return null;

    const info = readUserInfo(await response.json());
    const userId = info.user_id ?? info.sub;
    if (!userId) return null;

    const verified = { userId, orgId: info.org_id ?? null };

    // Only successes are cached: a failure is cheap to repeat, and caching one
    // would keep rejecting a token that has just become valid.
    await cache.put(cacheKey, JSON.stringify(verified), {
      expirationTtl: CACHE_TTL_SECONDS,
    });

    return verified;
  };
}
