import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { trustAllows, verifyGithubOidcToken, type CiTrust } from "./github-oidc";

const AUDIENCE = "https://api.zeroapps.dev";
const ISSUER = "https://token.actions.githubusercontent.com";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key";

function jwks(overrides: Record<string, unknown> = {}) {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig", ...overrides }] };
}

/** Mints a token the way GitHub does: RS256, kid in the header. */
function githubToken(claims: Record<string, unknown> = {}, kid = KID): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "repo:acme@42/app@777:ref:refs/heads/main",
    iat: now,
    nbf: now - 300,
    exp: now + 300,
    repository: "acme/app",
    repository_id: "777",
    repository_owner: "acme",
    repository_owner_id: "42",
    ref: "refs/heads/main",
    event_name: "push",
    ...claims,
  };
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${part(header)}.${part(payload)}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function fetchJwks(body: unknown = jwks()) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function memoryCache() {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
}

function verify(token: string, deps: Partial<Parameters<typeof verifyGithubOidcToken>[1]> = {}) {
  return verifyGithubOidcToken(token, {
    audience: AUDIENCE,
    cache: memoryCache(),
    fetchImpl: fetchJwks(),
    ...deps,
  });
}

describe("verifyGithubOidcToken", () => {
  it("returns the claims a trust decision needs", async () => {
    const result = await verify(githubToken());

    expect(result).toMatchObject({
      repositoryId: "777",
      repositoryOwnerId: "42",
      repository: "acme/app",
      ref: "refs/heads/main",
      eventName: "push",
    });
  });

  it("rejects a token signed by someone else", async () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = other.publicKey.export({ format: "jwk" }) as Record<string, unknown>;

    const result = await verify(githubToken(), {
      fetchImpl: fetchJwks({ keys: [{ ...jwk, kid: KID, alg: "RS256" }] }) as unknown as typeof fetch,
    });

    expect(result).toBeNull();
  });

  it("rejects a token whose audience is for another provider", async () => {
    // GitHub's default audience is the owner URL; a token minted for AWS must
    // not be replayable here.
    expect(await verify(githubToken({ aud: "https://github.com/acme" }))).toBeNull();
  });

  it("rejects a token from another issuer", async () => {
    expect(await verify(githubToken({ iss: "https://evil.example" }))).toBeNull();
  });

  it("rejects an expired token, allowing only a minute of skew", async () => {
    const now = Math.floor(Date.now() / 1000);

    expect(await verify(githubToken({ exp: now - 30 }))).not.toBeNull();
    expect(await verify(githubToken({ exp: now - 120 }))).toBeNull();
  });

  it("accepts GitHub's backdated nbf, which is five minutes before iat", async () => {
    const now = Math.floor(Date.now() / 1000);

    expect(await verify(githubToken({ nbf: now - 300, iat: now }))).not.toBeNull();
  });

  it("rejects a token that is not valid yet", async () => {
    const now = Math.floor(Date.now() / 1000);

    expect(await verify(githubToken({ nbf: now + 600, exp: now + 900 }))).toBeNull();
  });

  it("refuses a token with none as its algorithm", async () => {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${part({ alg: "none", typ: "JWT", kid: KID })}.${part({
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 300,
      repository_id: "777",
      repository_owner_id: "42",
    })}.`;

    expect(await verify(unsigned)).toBeNull();
  });

  it("rejects a token with no repository ids, which nothing could be matched on", async () => {
    expect(await verify(githubToken({ repository_id: undefined, repository_owner_id: undefined }))).toBeNull();
  });

  it("caches the key set instead of fetching it per request", async () => {
    const fetchImpl = fetchJwks();
    const cache = memoryCache();

    await verify(githubToken(), { cache, fetchImpl: fetchImpl as unknown as typeof fetch });
    await verify(githubToken(), { cache, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when the token names a key the cache has never seen", async () => {
    const fetchImpl = fetchJwks();
    const cache = memoryCache();

    await verify(githubToken(), { cache, fetchImpl: fetchImpl as unknown as typeof fetch });
    // GitHub rotates keys; a cached set that lacks the kid is stale, not wrong.
    await verify(githubToken({}, "rotated-key"), {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null when GitHub cannot be reached", async () => {
    const result = await verify(githubToken(), {
      fetchImpl: (() => Promise.reject(new Error("network"))) as unknown as typeof fetch,
    });

    expect(result).toBeNull();
  });
});

const claims = {
  repositoryId: "777",
  repositoryOwnerId: "42",
  repository: "acme/app",
  ref: "refs/heads/main",
  eventName: "push",
  environment: undefined,
};

function trust(overrides: Partial<CiTrust> = {}): CiTrust {
  return {
    ownerId: "42",
    repoId: "777",
    ref: null,
    environment: null,
    allowedEvents: [],
    ...overrides,
  };
}

describe("trustAllows", () => {
  it("allows a push from the trusted repository", () => {
    expect(trustAllows(trust(), claims)).toEqual({ ok: true });
  });

  it("matches on ids, so a repository renamed to the trusted name is not trusted", () => {
    const impostor = { ...claims, repositoryId: "999", repository: "acme/app" };

    expect(trustAllows(trust(), impostor)).toEqual({ ok: false, reason: "repository" });
  });

  it("keeps trusting a repository that changed its name", () => {
    const renamed = { ...claims, repository: "acme/app-renamed" };

    expect(trustAllows(trust(), renamed)).toEqual({ ok: true });
  });

  it("enforces a ref constraint", () => {
    expect(trustAllows(trust({ ref: "refs/heads/main" }), claims)).toEqual({ ok: true });
    expect(
      trustAllows(trust({ ref: "refs/heads/release" }), claims),
    ).toEqual({ ok: false, reason: "ref" });
  });

  it("enforces an environment constraint, including its absence", () => {
    const deployed = { ...claims, environment: "production" };

    expect(trustAllows(trust({ environment: "production" }), deployed)).toEqual({ ok: true });
    expect(trustAllows(trust({ environment: "production" }), claims)).toEqual({
      ok: false,
      reason: "environment",
    });
  });

  it("refuses pull_request_target by default, which a ref constraint would not catch", () => {
    // Measured: a fork's pull_request_target run carries the base repo's ids
    // and ref refs/heads/main, so only the event check stops it.
    const forkTarget = { ...claims, eventName: "pull_request_target" };

    expect(trustAllows(trust({ ref: "refs/heads/main" }), forkTarget)).toEqual({
      ok: false,
      reason: "event",
    });
  });

  it("refuses pull_request and workflow_run by default", () => {
    expect(trustAllows(trust(), { ...claims, eventName: "pull_request" })).toEqual({
      ok: false,
      reason: "event",
    });
    expect(trustAllows(trust(), { ...claims, eventName: "workflow_run" })).toEqual({
      ok: false,
      reason: "event",
    });
  });

  it("opts into one risky event without opening the others", () => {
    const allowed = trust({ allowedEvents: ["pull_request"] });

    expect(trustAllows(allowed, { ...claims, eventName: "pull_request" })).toEqual({ ok: true });
    expect(trustAllows(allowed, { ...claims, eventName: "pull_request_target" })).toEqual({
      ok: false,
      reason: "event",
    });
  });

  it("allows ordinary events nobody had to opt into", () => {
    for (const eventName of ["push", "schedule", "workflow_dispatch", "release"]) {
      expect(trustAllows(trust(), { ...claims, eventName })).toEqual({ ok: true });
    }
  });
});
