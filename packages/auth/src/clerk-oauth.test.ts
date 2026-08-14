import { describe, expect, it, vi } from "vitest";
import { createClerkOAuthVerifier, frontendApiUrl } from "./clerk-oauth";

const PUBLISHABLE_KEY = "pk_live_Y2xlcmsuemVyb2FwcHMuZGV2JA";

function memoryCache() {
  const store = new Map<string, string>();
  return {
    kv: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      put: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
    } as unknown as KVNamespace,
    store,
  };
}

function userinfoResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("frontendApiUrl", () => {
  it("derives the instance host from the publishable key, so it cannot drift", () => {
    expect(frontendApiUrl(PUBLISHABLE_KEY)).toBe("https://clerk.zeroapps.dev");
  });
});

describe("createClerkOAuthVerifier", () => {
  it("returns the user and org from userinfo", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        userinfoResponse({ user_id: "user_1", org_id: "org_1", email: "a@b.c" }),
      ),
    );
    const verify = createClerkOAuthVerifier({
      publishableKey: PUBLISHABLE_KEY,
      cache: memoryCache().kv,
      fetchImpl: fetchImpl,
    });

    await expect(verify("token_a")).resolves.toEqual({
      userId: "user_1",
      orgId: "org_1",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://clerk.zeroapps.dev/oauth/userinfo");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token_a");
  });

  it("reports a token with no org as valid but org-less, not invalid", async () => {
    const verify = createClerkOAuthVerifier({
      publishableKey: PUBLISHABLE_KEY,
      cache: memoryCache().kv,
      fetchImpl: () =>
        Promise.resolve(userinfoResponse({ user_id: "user_2" })),
    });

    await expect(verify("token_b")).resolves.toEqual({ userId: "user_2", orgId: null });
  });

  it("returns null for a revoked or expired token", async () => {
    const verify = createClerkOAuthVerifier({
      publishableKey: PUBLISHABLE_KEY,
      cache: memoryCache().kv,
      fetchImpl: () =>
        Promise.resolve(userinfoResponse({ errors: [] }, 401)),
    });

    await expect(verify("token_c")).resolves.toBeNull();
  });

  it("returns null when Clerk is down, rather than throwing into the request", async () => {
    const verify = createClerkOAuthVerifier({
      publishableKey: PUBLISHABLE_KEY,
      cache: memoryCache().kv,
      fetchImpl: () => Promise.reject(new Error("network")),
    });

    await expect(verify("token_d")).resolves.toBeNull();
  });

  it("serves a repeat request from the cache instead of calling Clerk again", async () => {
    const cache = memoryCache();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(userinfoResponse({ user_id: "user_5", org_id: "org_5" })),
    );
    const verify = createClerkOAuthVerifier({
      publishableKey: PUBLISHABLE_KEY,
      cache: cache.kv,
      fetchImpl: fetchImpl,
    });

    await verify("token_e");
    await expect(verify("token_e")).resolves.toEqual({ userId: "user_5", orgId: "org_5" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never stores the raw token as a cache key", async () => {
    const cache = memoryCache();
    const verify = createClerkOAuthVerifier({
      publishableKey: PUBLISHABLE_KEY,
      cache: cache.kv,
      fetchImpl: () =>
        Promise.resolve(
          userinfoResponse({ user_id: "user_6", org_id: "org_6" }),
        ),
    });

    await verify("secret_token_value");

    for (const key of cache.store.keys()) {
      expect(key).not.toContain("secret_token_value");
    }
  });

  it("does not cache a rejection, so a fresh login is not shadowed by a stale failure", async () => {
    const cache = memoryCache();
    let status = 401;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        status === 401
          ? userinfoResponse({ errors: [] }, 401)
          : userinfoResponse({ user_id: "user_7", org_id: "org_7" }),
      ),
    );
    const verify = createClerkOAuthVerifier({
      publishableKey: PUBLISHABLE_KEY,
      cache: cache.kv,
      fetchImpl: fetchImpl,
    });

    await expect(verify("token_f")).resolves.toBeNull();
    status = 200;

    await expect(verify("token_f")).resolves.toEqual({ userId: "user_7", orgId: "org_7" });
  });
});
