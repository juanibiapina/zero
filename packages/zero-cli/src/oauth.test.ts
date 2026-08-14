import { describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  createPkcePair,
  exchangeCode,
  freshAccessToken,
  refreshLogin,
  revokeLogin,
  type Login,
} from "./oauth.js";

const ISSUER = "https://clerk.example.dev";
const CLIENT_ID = "client_123";

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal unsigned JWT, which is all the CLI reads (it never verifies). */
function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
}

function login(overrides: Partial<Login> = {}): Login {
  return {
    accessToken: "at_1",
    refreshToken: "rt_1",
    expiresAt: Date.now() + 3_600_000,
    userId: "user_1",
    orgId: "org_1",
    email: "dev@example.com",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    ...overrides,
  };
}

describe("createPkcePair", () => {
  it("derives an S256 challenge that differs from the verifier", () => {
    const pair = createPkcePair();

    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).not.toBe(pair.verifier);
    expect(pair.challenge).not.toMatch(/[+/=]/);
  });

  it("never repeats a verifier", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe("authorizeUrl", () => {
  it("asks for an org-scoped, refreshable token with PKCE", () => {
    const url = new URL(
      authorizeUrl({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        redirectUri: "http://127.0.0.1:8976/callback",
        challenge: "chal",
        state: "st",
      }),
    );

    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8976/callback");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "offline_access",
      "openid",
      "profile",
      "user:org:read",
    ]);
  });
});

describe("exchangeCode", () => {
  it("sends the verifier and no client secret, and keeps the identity from the id token", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        tokenResponse({
          access_token: "at_new",
          refresh_token: "rt_new",
          expires_in: 86399,
          id_token: idToken({
            sub: "user_9",
            org_id: "org_9",
            email: "dev@example.com",
          }),
        }),
      ),
    );

    const result = await exchangeCode(
      {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        code: "code_1",
        verifier: "ver_1",
        redirectUri: "http://127.0.0.1:8976/callback",
      },
      fetchImpl,
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(url).toBe(`${ISSUER}/oauth/token`);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("ver_1");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBeNull();

    expect(result).toMatchObject({
      accessToken: "at_new",
      refreshToken: "rt_new",
      userId: "user_9",
      orgId: "org_9",
      email: "dev@example.com",
    });
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("fails with Clerk's own error text rather than a generic one", async () => {
    const fetchImpl = () =>
      Promise.resolve(
        tokenResponse({ error: "invalid_grant", error_description: "code is expired" }, 400),
      );

    await expect(
      exchangeCode(
        {
          issuer: ISSUER,
          clientId: CLIENT_ID,
          code: "old",
          verifier: "v",
          redirectUri: "http://127.0.0.1:8976/callback",
        },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/code is expired/);
  });
});

describe("refreshLogin", () => {
  it("keeps the rotated refresh token, since replaying the old one kills the session", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        tokenResponse({
          access_token: "at_2",
          refresh_token: "rt_2",
          expires_in: 86399,
          id_token: idToken({ sub: "user_1", org_id: "org_1", email: "dev@example.com" }),
        }),
      ),
    );

    const refreshed = await refreshLogin(login(), fetchImpl);

    const body = new URLSearchParams(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_1");
    expect(refreshed).toMatchObject({ accessToken: "at_2", refreshToken: "rt_2" });
  });
});

describe("freshAccessToken", () => {
  it("uses the stored token while it is still good, without a network call", async () => {
    const fetchImpl = vi.fn();
    const stored = login({ expiresAt: Date.now() + 600_000 });

    const result = await freshAccessToken(stored, {
      save: vi.fn(),
      fetchImpl: fetchImpl,
    });

    expect(result).toEqual(stored);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes a token about to expire and persists the new pair before returning it", async () => {
    const save = vi.fn();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        tokenResponse({
          access_token: "at_3",
          refresh_token: "rt_3",
          expires_in: 86399,
          id_token: idToken({ sub: "user_1", org_id: "org_1", email: "dev@example.com" }),
        }),
      ),
    );

    const result = await freshAccessToken(login({ expiresAt: Date.now() + 10_000 }), {
      save,
      fetchImpl: fetchImpl,
    });

    expect(result?.accessToken).toBe("at_3");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "rt_3" }));
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[0] + 2,
    );
  });

  it("returns null when the refresh token is gone, so the caller can ask for a new login", async () => {
    const save = vi.fn();
    const fetchImpl = () =>
      Promise.resolve(tokenResponse({ error: "invalid_grant" }, 400));

    const result = await freshAccessToken(login({ expiresAt: Date.now() - 1 }), {
      save,
      fetchImpl: fetchImpl,
    });

    expect(result).toBeNull();
  });
});

describe("revokeLogin", () => {
  it("revokes the refresh token server-side", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("", { status: 200 })));

    await revokeLogin(login(), fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(url).toBe(`${ISSUER}/oauth/token/revoke`);
    expect(body.get("token")).toBe("rt_1");
    expect(body.get("client_id")).toBe(CLIENT_ID);
  });

  it("does not throw when the server refuses, since logout must still clear local state", async () => {
    const fetchImpl = () => Promise.reject(new Error("offline"));

    await expect(revokeLogin(login(), fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
