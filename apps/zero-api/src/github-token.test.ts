import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";

// Mock Clerk so we control which GitHub identity a user has.
const getUserMock = vi.fn();
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ users: { getUser: getUserMock } }),
}));

import {
  getGithubInstallationToken,
  getGithubInstallationStatus,
} from "./github-token";
import type { Env } from "./types";

let pkcs8: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  pkcs8 = await exportPKCS8(privateKey);
});

const env = (): Env =>
  ({
    CLERK_SECRET_KEY: "sk_test",
    CLERK_PUBLISHABLE_KEY: "pk_test",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: pkcs8,
  }) as unknown as Env;

const withGithubUser = (username: string | null) => {
  getUserMock.mockResolvedValue({
    externalAccounts: username
      ? [{ provider: "oauth_github", username }]
      : [],
  });
};

// Route the two GitHub endpoints the module hits.
type Routes = {
  installation?: () => Response;
  accessTokens?: () => Response;
};

const stubFetch = (routes: Routes) => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/access_tokens") && init?.method === "POST") {
        return Promise.resolve(
          routes.accessTokens?.() ?? new Response(null, { status: 500 }),
        );
      }
      if (url.includes("/installation")) {
        return Promise.resolve(
          routes.installation?.() ?? new Response(null, { status: 500 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  getUserMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getGithubInstallationToken", () => {
  it("returns the installation token on the happy path", async () => {
    withGithubUser("octocat");
    stubFetch({
      installation: () => json({ id: 42 }),
      accessTokens: () =>
        json({ token: "ghs_realtoken", expires_at: "2026-06-05T13:00:00Z" }, 201),
    });

    const token = await getGithubInstallationToken(env(), "user_1");
    expect(token).toBe("ghs_realtoken");
  });

  it("returns null when the user has no GitHub external account", async () => {
    withGithubUser(null);
    stubFetch({});

    const token = await getGithubInstallationToken(env(), "user_1");
    expect(token).toBeNull();
  });

  it("returns null when the user has no installation", async () => {
    withGithubUser("octocat");
    stubFetch({ installation: () => new Response(null, { status: 404 }) });

    const token = await getGithubInstallationToken(env(), "user_1");
    expect(token).toBeNull();
  });

  it("returns null when minting the token fails", async () => {
    withGithubUser("octocat");
    stubFetch({
      installation: () => json({ id: 42 }),
      accessTokens: () => new Response(null, { status: 403 }),
    });

    const token = await getGithubInstallationToken(env(), "user_1");
    expect(token).toBeNull();
  });

  it("never throws when Clerk fails", async () => {
    getUserMock.mockRejectedValue(new Error("clerk down"));
    stubFetch({});

    await expect(
      getGithubInstallationToken(env(), "user_1"),
    ).resolves.toBeNull();
  });
});

describe("getGithubInstallationStatus", () => {
  it("reports a fully connected user without exposing the token", async () => {
    withGithubUser("octocat");
    stubFetch({
      installation: () => json({ id: 42 }),
      accessTokens: () =>
        json({ token: "ghs_realtoken", expires_at: "2026-06-05T13:00:00Z" }, 201),
    });

    const status = await getGithubInstallationStatus(env(), "user_1");
    expect(status).toEqual({
      githubConnected: true,
      githubUsername: "octocat",
      installationId: 42,
      tokenMinted: true,
      tokenPrefix: "ghs_",
      expiresAt: "2026-06-05T13:00:00Z",
    });
    // Sanity: full token must not appear anywhere in the diagnostics.
    expect(JSON.stringify(status)).not.toContain("ghs_realtoken");
  });

  it("reports disconnected when there is no GitHub account", async () => {
    withGithubUser(null);
    stubFetch({});

    const status = await getGithubInstallationStatus(env(), "user_1");
    expect(status).toMatchObject({
      githubConnected: false,
      githubUsername: null,
      installationId: null,
      tokenMinted: false,
    });
  });

  it("reports connected but not installed when no installation exists", async () => {
    withGithubUser("octocat");
    stubFetch({ installation: () => new Response(null, { status: 404 }) });

    const status = await getGithubInstallationStatus(env(), "user_1");
    expect(status).toMatchObject({
      githubConnected: true,
      githubUsername: "octocat",
      installationId: null,
      tokenMinted: false,
    });
  });
});
