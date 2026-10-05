/**
 * The `/{product}/v1` surface accepts a Clerk OAuth token (what `zero login`
 * stores) exactly where it accepts a `zv_` key.
 *
 * The verifier is injected, so these tests never talk to Clerk and never need a
 * real login: what is under test is the routing and the failure messages, not
 * Clerk's token format.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDashboardApp } from "../dashboard-app";
import type { Env } from "../types";

const typedEnv = env as Env;

function appWith(verify: (token: string) => Promise<{ userId: string; orgId: string | null } | null>) {
  return createDashboardApp(typedEnv, { verifyOAuthToken: verify });
}

function whoami(app: ReturnType<typeof createDashboardApp>, token: string, product = "vault") {
  return app.fetch(
    new Request(`https://localhost/${product}/v1/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    typedEnv,
  );
}

describe("OAuth tokens on the /v1 surface", () => {
  it("authorizes a vault request as the token's user and org", async () => {
    const app = appWith(() => Promise.resolve({ userId: "user_oauth", orgId: "org_oauth" }));

    const response = await whoami(app, "oauth_token_value");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "user_oauth", orgId: "org_oauth" });
  });

  it("authorizes errors with the same credential, so one login covers both products", async () => {
    const app = appWith(() => Promise.resolve({ userId: "user_oauth", orgId: "org_oauth" }));

    const response = await whoami(app, "oauth_token_value", "errors");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "user_oauth", orgId: "org_oauth" });
  });

  it("tells a user with no organization what to do about it", async () => {
    const app = appWith(() => Promise.resolve({ userId: "user_oauth", orgId: null }));

    const response = await whoami(app, "oauth_token_value");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error:
        "Token has no organization. Run `zero login` again and select an organization.",
    });
  });

  it("rejects a revoked or expired token", async () => {
    const app = appWith(() => Promise.resolve(null));

    const response = await whoami(app, "revoked_token");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid API key" });
  });

  it("never hands a zv_ key to Clerk", async () => {
    let called = false;
    const app = appWith(() => {
      called = true;
      return Promise.resolve(null);
    });

    const response = await whoami(app, "zv_not_a_real_key");

    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });
});
