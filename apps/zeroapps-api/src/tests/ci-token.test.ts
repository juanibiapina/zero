/**
 * The CI token exchange: a GitHub Actions workflow trades its OIDC token for a
 * short-lived Zero credential, with no API key stored anywhere.
 *
 * The GitHub verifier is injected, so these tests need neither GitHub nor a
 * real workflow. What is under test here is the wiring: that the endpoint is
 * reachable without a credential, that it finds the org from the trust index,
 * that it refuses what the trust record does not cover, and that the token it
 * mints actually opens the vault.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import { createDashboardApp } from "../dashboard-app";
import { ciTrustIndexKey } from "../OrgDO";
import type { Env } from "../types";
import type { GithubActionsClaims } from "@zero/auth";

const typedEnv = env as Env;

const ORG = "org_ci_test";
const OWNER_ID = "42";
const REPO_ID = "777";

const claims: GithubActionsClaims = {
  repositoryId: REPO_ID,
  repositoryOwnerId: OWNER_ID,
  repository: "acme/app",
  ref: "refs/heads/main",
  eventName: "push",
};

function appWith(verify: (token: string) => Promise<GithubActionsClaims | null>) {
  return createDashboardApp(typedEnv, { verifyGithubToken: verify });
}

function exchange(
  app: ReturnType<typeof createDashboardApp>,
  body: Record<string, unknown> = { token: "github.oidc.token" },
) {
  return app.fetch(
    new Request("https://localhost/vault/v1/ci/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    typedEnv,
  );
}

/** Mint an org-scoped API key directly through the OrgDO, as vault.test.ts does. */
async function mintKey(orgId: string): Promise<string> {
  const org = typedEnv.ORGDO.get(typedEnv.ORGDO.idFromName(orgId));
  const result = await org.createApiKey({ orgId, userId: "user_test" }, "ci-tests");
  return result.key;
}

async function trustRepo(orgId: string, overrides: Record<string, unknown> = {}) {
  const org = typedEnv.ORGDO.get(typedEnv.ORGDO.idFromName(orgId));
  await org.addCiTrust({
    orgId,
    ownerId: OWNER_ID,
    repoId: REPO_ID,
    repository: "acme/app",
    ...overrides,
  });
}

/** Durable Objects outlive a test, so each one starts from no trust at all. */
beforeEach(async () => {
  await typedEnv.APIKEYS.delete(ciTrustIndexKey(OWNER_ID, REPO_ID));
  for (const orgId of [ORG, "org_ci_other", "org_not_trusting"]) {
    const org = typedEnv.ORGDO.get(typedEnv.ORGDO.idFromName(orgId));
    for (const trust of await org.listCiTrusts()) {
      await org.removeCiTrust(trust.id, orgId);
    }
  }
});

describe("POST /vault/v1/ci/token", () => {
  it("needs no credential of its own, since the OIDC token is the credential", async () => {
    const app = appWith(() => Promise.resolve(claims));
    await trustRepo(ORG);

    const response = await exchange(app);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { accessToken: string; orgId: string };
    expect(body.accessToken).toMatch(/^zci_/);
    // Signed, so it carries its own proof: nothing was written to KV for it.
    expect(body.orgId).toBe(ORG);
  });

  it("mints a token that opens the vault it was issued for", async () => {
    const app = appWith(() => Promise.resolve(claims));
    await trustRepo(ORG);

    const { accessToken } = (await (await exchange(app)).json()) as { accessToken: string };

    const whoami = await app.fetch(
      new Request("https://localhost/vault/v1/whoami", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      typedEnv,
    );

    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toEqual({ orgId: ORG, userId: `ci:github:${REPO_ID}` });
  });

  it("refuses a repository nobody trusts, without saying whether it exists", async () => {
    const app = appWith(() => Promise.resolve(claims));

    const response = await exchange(app);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("not trusted") as unknown as string,
    });
  });

  it("tells an untrusted workflow which ids to trust, so the fix is copy-paste", async () => {
    const app = appWith(() => Promise.resolve(claims));

    const body = (await (await exchange(app)).json()) as { ownerId?: string; repoId?: string };

    expect(body).toMatchObject({ ownerId: OWNER_ID, repoId: REPO_ID });
  });

  it("refuses an invalid token", async () => {
    const app = appWith(() => Promise.resolve(null));
    await trustRepo(ORG);

    const response = await exchange(app);

    expect(response.status).toBe(401);
  });

  it("refuses an event the trust record did not opt into", async () => {
    const app = appWith(() =>
      Promise.resolve({ ...claims, eventName: "pull_request_target" }),
    );
    await trustRepo(ORG);

    const response = await exchange(app);

    expect(response.status).toBe(403);
  });

  it("honours an opt-in for that event", async () => {
    const app = appWith(() =>
      Promise.resolve({ ...claims, eventName: "pull_request_target" }),
    );
    await trustRepo(ORG, { allowedEvents: ["pull_request_target"] });

    expect((await exchange(app)).status).toBe(200);
  });

  it("requires the caller to name the org when two orgs trust the same repo", async () => {
    const app = appWith(() => Promise.resolve(claims));
    await trustRepo(ORG);
    await trustRepo("org_ci_other");

    const ambiguous = await exchange(app);
    expect(ambiguous.status).toBe(400);

    const chosen = await exchange(app, { token: "github.oidc.token", orgId: "org_ci_other" });
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toMatchObject({ orgId: "org_ci_other" });
  });

  it("refuses an org that does not trust the repo, even when another one does", async () => {
    const app = appWith(() => Promise.resolve(claims));
    await trustRepo(ORG);

    const response = await exchange(app, { token: "t", orgId: "org_not_trusting" });

    expect(response.status).toBe(403);
  });

  it("rejects a request with no token at all", async () => {
    const app = appWith(() => Promise.resolve(claims));

    const response = await exchange(app, {});

    expect(response.status).toBe(400);
  });
});

describe("trust management", () => {
  it("round-trips a trust through the API-key surface", async () => {
    const app = appWith(() => Promise.resolve(claims));
    const key = await mintKey(ORG);

    const created = await app.fetch(
      new Request("https://localhost/vault/v1/ci/trusts", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerId: OWNER_ID,
          repoId: REPO_ID,
          repository: "acme/app",
          label: "ci",
        }),
      }),
      typedEnv,
    );
    expect(created.status).toBe(201);

    const listed = await app.fetch(
      new Request("https://localhost/vault/v1/ci/trusts", {
        headers: { Authorization: `Bearer ${key}` },
      }),
      typedEnv,
    );
    const body = (await listed.json()) as { trusts: { repository: string; repoId: string }[] };
    expect(body.trusts).toContainEqual(
      expect.objectContaining({ repository: "acme/app", repoId: REPO_ID }),
    );

    // And the workflow can now exchange, which is the point of the record.
    expect((await exchange(app)).status).toBe(200);
  });

  it("refuses an unknown event name rather than pretending to allow it", async () => {
    const app = appWith(() => Promise.resolve(claims));
    const key = await mintKey(ORG);

    const response = await app.fetch(
      new Request("https://localhost/vault/v1/ci/trusts", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerId: OWNER_ID,
          repoId: REPO_ID,
          repository: "acme/app",
          allowedEvents: ["push"],
        }),
      }),
      typedEnv,
    );

    expect(response.status).toBe(400);
  });

  it("stops the exchange once the trust is removed", async () => {
    const app = appWith(() => Promise.resolve(claims));
    const key = await mintKey(ORG);
    await trustRepo(ORG);

    const { trusts } = (await (
      await app.fetch(
        new Request("https://localhost/vault/v1/ci/trusts", {
          headers: { Authorization: `Bearer ${key}` },
        }),
        typedEnv,
      )
    ).json()) as { trusts: { id: number }[] };

    await app.fetch(
      new Request(`https://localhost/vault/v1/ci/trusts/${trusts[0]!.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      }),
      typedEnv,
    );

    expect((await exchange(app)).status).toBe(403);
  });
});

describe("trusting a repository twice", () => {
  it("updates the record instead of failing", async () => {
    const app = appWith(() => Promise.resolve({ ...claims, eventName: "pull_request" }));
    await trustRepo(ORG);
    expect((await exchange(app)).status).toBe(403);

    await trustRepo(ORG, { allowedEvents: ["pull_request"] });

    expect((await exchange(app)).status).toBe(200);
  });
});
