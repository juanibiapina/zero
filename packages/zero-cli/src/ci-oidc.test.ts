import { describe, expect, it, vi } from "vitest";
import { actionsEnvironment, exchangeCiToken, requestOidcToken } from "./ci-oidc.js";

const ACTIONS_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/req?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-bearer",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("actionsEnvironment", () => {
  it("recognises a job that can mint an OIDC token", () => {
    expect(actionsEnvironment(ACTIONS_ENV)).toEqual({
      requestUrl: ACTIONS_ENV.ACTIONS_ID_TOKEN_REQUEST_URL,
      requestToken: "runner-bearer",
    });
  });

  it("is absent outside Actions, and on a job that forgot id-token: write", () => {
    // The two variables only appear when the job has the permission, so their
    // absence is exactly the case where the CLI must not pretend to have CI auth.
    expect(actionsEnvironment({})).toBeNull();
    expect(actionsEnvironment({ ACTIONS_ID_TOKEN_REQUEST_URL: ACTIONS_ENV.ACTIONS_ID_TOKEN_REQUEST_URL })).toBeNull();
    expect(actionsEnvironment({ GITHUB_ACTIONS: "true" })).toBeNull();
  });
});

describe("requestOidcToken", () => {
  it("asks GitHub for a token bound to the Zero API audience", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ value: "oidc.jwt" })));

    const token = await requestOidcToken(
      actionsEnvironment(ACTIONS_ENV)!,
      "https://api.zeroapps.dev",
      fetchImpl,
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get("audience")).toBe("https://api.zeroapps.dev");
    // The existing api-version query parameter must survive.
    expect(new URL(url).searchParams.get("api-version")).toBe("2.0");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer runner-bearer");
    expect(token).toBe("oidc.jwt");
  });

  it("fails loudly when the runner refuses", async () => {
    const fetchImpl = () => Promise.resolve(jsonResponse({ message: "no" }, 403));

    await expect(
      requestOidcToken(
        actionsEnvironment(ACTIONS_ENV)!,
        "https://api.zeroapps.dev",
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/id-token: write|403/);
  });
});

describe("exchangeCiToken", () => {
  it("trades the OIDC token for a Zero credential", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ accessToken: "zci_abc", expiresIn: 900, orgId: "org_1" })),
    );

    const result = await exchangeCiToken(
      { baseUrl: "https://api.zeroapps.dev", oidcToken: "oidc.jwt" },
      fetchImpl,
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.zeroapps.dev/vault/v1/ci/token");
    expect(JSON.parse(init.body as string)).toEqual({ token: "oidc.jwt" });
    expect(result).toEqual({ accessToken: "zci_abc", orgId: "org_1" });
  });

  it("passes the org through when one is named, for a repo two orgs trust", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ accessToken: "zci_abc", expiresIn: 900, orgId: "org_2" })),
    );

    await exchangeCiToken(
      { baseUrl: "https://api.zeroapps.dev", oidcToken: "oidc.jwt", orgId: "org_2" },
      fetchImpl,
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ token: "oidc.jwt", orgId: "org_2" });
  });

  it("surfaces the server's own explanation, which names the fix", async () => {
    const fetchImpl = () =>
      Promise.resolve(
        jsonResponse(
          {
            error: "Repository acme/app is not trusted. Run: zero ci trust add --repo acme/app",
            ownerId: "42",
            repoId: "777",
          },
          403,
        ),
      );

    await expect(
      exchangeCiToken(
        { baseUrl: "https://api.zeroapps.dev", oidcToken: "oidc.jwt" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/not trusted.*zero ci trust add/);
  });

  it("includes the repository ids in the error, so a private repo can be trusted by hand", async () => {
    const fetchImpl = () =>
      Promise.resolve(jsonResponse({ error: "not trusted", ownerId: "42", repoId: "777" }, 403));

    await expect(
      exchangeCiToken(
        { baseUrl: "https://api.zeroapps.dev", oidcToken: "oidc.jwt" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/--owner-id 42 --repo-id 777/);
  });
});
