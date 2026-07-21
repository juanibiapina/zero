/**
 * ============================================================================
 * ZeroVault API Tests
 * ============================================================================
 *
 * Integration tests for the full API via Cloudflare Workers test pool.
 *
 * Org-scoped keys are minted directly through OrgDO. CI uses the API-key path
 * (/v1) and the testUserId + X-Org-Id bypass for /api; a real Clerk session is
 * a true external dependency verified manually against a deployed build.
 */

import { env, exports as SELF } from "cloudflare:workers";
import type { Env } from "../types";
import { validateApiKey, hashApiKey } from "@zero/auth";
import { describe, it, expect, beforeAll } from "vitest";

const typedEnv = env as Env;

function authed(apiKey: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
}

/** Mint an org-scoped API key directly through the OrgDO for `orgId`. */
async function mintKey(orgId: string, userId: string, label?: string): Promise<string> {
  const org = typedEnv.ORGDO.get(typedEnv.ORGDO.idFromName(orgId));
  const result = await org.createApiKey({ orgId, userId }, label);
  return result.key;
}

describe("Health check", () => {
  it("returns ok", async () => {
    const res = await SELF.default.fetch("https://localhost/ping");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("API key auth", () => {
  it("returns 401 without API key", async () => {
    const res = await SELF.default.fetch("https://localhost/v1/projects");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid API key", async () => {
    const res = await SELF.default.fetch("https://localhost/v1/projects", {
      headers: { Authorization: "Bearer zv_invalid" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong prefix", async () => {
    const res = await SELF.default.fetch("https://localhost/v1/projects", {
      headers: { Authorization: "Bearer td_wrongprefix" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a legacy v1 key (401)", async () => {
    const key = "zv_legacyv1testkey000000000000000000000000000000000000000000000000";
    // Hand-write a legacy { v: 1, userId } KV entry (no orgId).
    const keyHash = await hashApiKey(key);
    await typedEnv.APIKEYS.put(keyHash, JSON.stringify({ v: 1, userId: "legacy_user" }));

    const res = await SELF.default.fetch("https://localhost/v1/whoami", authed(key));
    expect(res.status).toBe(401);
  });
});

describe("validateApiKey parsing", () => {
  it("returns { orgId, userId } for a valid v2 key", async () => {
    const key = await mintKey("org_parse", "user_parse", "Parse Key");
    const result = await validateApiKey(typedEnv.APIKEYS, `Bearer ${key}`);
    expect(result).toEqual({ orgId: "org_parse", userId: "user_parse" });
  });

  it("returns null for a legacy v1 value", async () => {
    const key = "zv_parsev1000000000000000000000000000000000000000000000000000000000";
    await typedEnv.APIKEYS.put(await hashApiKey(key), JSON.stringify({ v: 1, userId: "u" }));
    expect(await validateApiKey(typedEnv.APIKEYS, `Bearer ${key}`)).toBeNull();
  });

  it("returns null for garbage", async () => {
    const key = "zv_garbage00000000000000000000000000000000000000000000000000000000";
    await typedEnv.APIKEYS.put(await hashApiKey(key), "not json");
    expect(await validateApiKey(typedEnv.APIKEYS, `Bearer ${key}`)).toBeNull();
    const res = await SELF.default.fetch("https://localhost/v1/whoami", authed(key));
    expect(res.status).toBe(401);
  });
});

describe("whoami", () => {
  it("returns userId and orgId matching the key's org", async () => {
    const key = await mintKey("org_whoami", "user_whoami");
    const res = await SELF.default.fetch("https://localhost/v1/whoami", authed(key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; orgId: string };
    expect(body).toEqual({ userId: "user_whoami", orgId: "org_whoami" });
  });
});

describe("Project lifecycle", () => {
  let apiKey: string;

  beforeAll(async () => {
    apiKey = await mintKey("org_lifecycle", "user_lifecycle", "Lifecycle Key");
  });

  it("creates a project with default environments", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/projects",
      authed(apiKey, { method: "POST", body: JSON.stringify({ name: "myapp" }) }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; environments: { name: string }[] };
    expect(body.name).toBe("myapp");
    expect(body.environments.map((e) => e.name).sort()).toEqual([
      "development",
      "production",
    ]);
  });

  it("lists the project", async () => {
    const res = await SELF.default.fetch("https://localhost/v1/projects", authed(apiKey));
    const body = (await res.json()) as { projects: { name: string }[] };
    expect(body.projects.map((p) => p.name)).toContain("myapp");
  });

  it("rejects duplicate project names (409)", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/projects",
      authed(apiKey, { method: "POST", body: JSON.stringify({ name: "myapp" }) }),
    );
    expect(res.status).toBe(409);
  });

  it("lists default environments", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments",
      authed(apiKey),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { environments: { name: string }[] };
    expect(body.environments).toHaveLength(2);
  });

  it("creates a custom environment", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments",
      authed(apiKey, { method: "POST", body: JSON.stringify({ name: "staging" }) }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("staging");
  });

  it("sets and retrieves secrets", async () => {
    const putRes = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments/development/secrets",
      authed(apiKey, {
        method: "PUT",
        body: JSON.stringify({
          secrets: [
            { key: "DB_HOST", value: "localhost" },
            { key: "DB_PASSWORD", value: "s3cret" },
          ],
        }),
      }),
    );
    expect(putRes.status).toBe(200);

    const getRes = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments/development/secrets",
      authed(apiKey),
    );
    const body = (await getRes.json()) as { secrets: { key: string; value: string }[] };
    const sorted = body.secrets.sort((a, b) => a.key.localeCompare(b.key));
    expect(sorted).toEqual([
      { key: "DB_HOST", value: "localhost" },
      { key: "DB_PASSWORD", value: "s3cret" },
    ]);
  });

  it("patches secrets (add, update, delete)", async () => {
    const patchRes = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments/development/secrets",
      authed(apiKey, {
        method: "PATCH",
        body: JSON.stringify({
          secrets: [
            { key: "API_KEY", value: "abc123" },
            { key: "DB_HOST", value: "prod-db.example.com" },
            { key: "DB_PASSWORD", value: null },
          ],
        }),
      }),
    );
    expect(patchRes.status).toBe(200);

    const getRes = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments/development/secrets",
      authed(apiKey),
    );
    const body = (await getRes.json()) as { secrets: { key: string; value: string }[] };
    const sorted = body.secrets.sort((a, b) => a.key.localeCompare(b.key));
    expect(sorted).toEqual([
      { key: "API_KEY", value: "abc123" },
      { key: "DB_HOST", value: "prod-db.example.com" },
    ]);
  });

  it("returns 404 for nonexistent project secrets", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/projects/nope/environments/dev/secrets",
      authed(apiKey),
    );
    expect(res.status).toBe(404);
  });

  it("deletes an environment and cascades secrets", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments/staging",
      authed(apiKey, { method: "DELETE" }),
    );
    expect(res.status).toBe(204);

    const listRes = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments",
      authed(apiKey),
    );
    const body = (await listRes.json()) as { environments: { name: string }[] };
    expect(body.environments.find((e) => e.name === "staging")).toBeUndefined();
  });

  it("deletes the project (gone from listing, secrets 404)", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp",
      authed(apiKey, { method: "DELETE" }),
    );
    expect(res.status).toBe(204);

    const listRes = await SELF.default.fetch("https://localhost/v1/projects", authed(apiKey));
    const body = (await listRes.json()) as { projects: { name: string }[] };
    expect(body.projects.find((p) => p.name === "myapp")).toBeUndefined();

    const secretsRes = await SELF.default.fetch(
      "https://localhost/v1/projects/myapp/environments/development/secrets",
      authed(apiKey),
    );
    expect(secretsRes.status).toBe(404);
  });

  it("deleting a nonexistent project returns 404", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/projects/ghost",
      authed(apiKey, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("Crypto shred on delete", () => {
  it("recreating a deleted project yields an empty, freshly-keyed vault", async () => {
    const apiKey = await mintKey("org_shred", "user_shred");

    await SELF.default.fetch(
      "https://localhost/v1/projects",
      authed(apiKey, { method: "POST", body: JSON.stringify({ name: "shredme" }) }),
    );
    await SELF.default.fetch(
      "https://localhost/v1/projects/shredme/environments/development/secrets",
      authed(apiKey, {
        method: "PUT",
        body: JSON.stringify({ secrets: [{ key: "TOKEN", value: "topsecret" }] }),
      }),
    );

    await SELF.default.fetch(
      "https://localhost/v1/projects/shredme",
      authed(apiKey, { method: "DELETE" }),
    );

    // Recreate the same name — fresh DEK, default envs, no old secrets.
    await SELF.default.fetch(
      "https://localhost/v1/projects",
      authed(apiKey, { method: "POST", body: JSON.stringify({ name: "shredme" }) }),
    );

    const getRes = await SELF.default.fetch(
      "https://localhost/v1/projects/shredme/environments/development/secrets",
      authed(apiKey),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { secrets: unknown[] };
    expect(body.secrets).toHaveLength(0);
  });
});

describe("Cross-org isolation", () => {
  it("same project name under two orgs is independent", async () => {
    const keyA = await mintKey("org_A", "user_a");
    const keyB = await mintKey("org_B", "user_b");

    for (const key of [keyA, keyB]) {
      await SELF.default.fetch(
        "https://localhost/v1/projects",
        authed(key, { method: "POST", body: JSON.stringify({ name: "shared" }) }),
      );
    }

    await SELF.default.fetch(
      "https://localhost/v1/projects/shared/environments/development/secrets",
      authed(keyA, {
        method: "PUT",
        body: JSON.stringify({ secrets: [{ key: "WHO", value: "orgA" }] }),
      }),
    );
    await SELF.default.fetch(
      "https://localhost/v1/projects/shared/environments/development/secrets",
      authed(keyB, {
        method: "PUT",
        body: JSON.stringify({ secrets: [{ key: "WHO", value: "orgB" }] }),
      }),
    );

    const resA = await SELF.default.fetch(
      "https://localhost/v1/projects/shared/environments/development/secrets",
      authed(keyA),
    );
    const bodyA = (await resA.json()) as { secrets: { key: string; value: string }[] };
    expect(bodyA.secrets).toEqual([{ key: "WHO", value: "orgA" }]);
  });

  it("an org_A key cannot see org_B projects", async () => {
    const keyA = await mintKey("org_A2", "user_a2");
    const keyB = await mintKey("org_B2", "user_b2");

    await SELF.default.fetch(
      "https://localhost/v1/projects",
      authed(keyB, { method: "POST", body: JSON.stringify({ name: "onlyB" }) }),
    );

    const res = await SELF.default.fetch("https://localhost/v1/projects", authed(keyA));
    const body = (await res.json()) as { projects: { name: string }[] };
    expect(body.projects.find((p) => p.name === "onlyB")).toBeUndefined();
  });
});

describe("Per-project isolation", () => {
  it("two projects in one org hold independent secrets", async () => {
    const key = await mintKey("org_multi", "user_multi");

    for (const name of ["projx", "projy"]) {
      await SELF.default.fetch(
        "https://localhost/v1/projects",
        authed(key, { method: "POST", body: JSON.stringify({ name }) }),
      );
    }

    await SELF.default.fetch(
      "https://localhost/v1/projects/projx/environments/development/secrets",
      authed(key, {
        method: "PUT",
        body: JSON.stringify({ secrets: [{ key: "K", value: "x-value" }] }),
      }),
    );
    await SELF.default.fetch(
      "https://localhost/v1/projects/projy/environments/development/secrets",
      authed(key, {
        method: "PUT",
        body: JSON.stringify({ secrets: [{ key: "K", value: "y-value" }] }),
      }),
    );

    const resX = await SELF.default.fetch(
      "https://localhost/v1/projects/projx/environments/development/secrets",
      authed(key),
    );
    const bodyX = (await resX.json()) as { secrets: { key: string; value: string }[] };
    expect(bodyX.secrets).toEqual([{ key: "K", value: "x-value" }]);
  });
});

describe("Org-scoped key reaches all projects", () => {
  it("one org key reads/writes across multiple projects", async () => {
    const key = await mintKey("org_reach", "user_reach");

    for (const name of ["alpha", "beta"]) {
      await SELF.default.fetch(
        "https://localhost/v1/projects",
        authed(key, { method: "POST", body: JSON.stringify({ name }) }),
      );
      const putRes = await SELF.default.fetch(
        `https://localhost/v1/projects/${name}/environments/production/secrets`,
        authed(key, {
          method: "PUT",
          body: JSON.stringify({ secrets: [{ key: "NAME", value: name }] }),
        }),
      );
      expect(putRes.status).toBe(200);
    }

    for (const name of ["alpha", "beta"]) {
      const res = await SELF.default.fetch(
        `https://localhost/v1/projects/${name}/environments/production/secrets`,
        authed(key),
      );
      const body = (await res.json()) as { secrets: { key: string; value: string }[] };
      expect(body.secrets).toEqual([{ key: "NAME", value: name }]);
    }
  });
});

describe("API keys management (org-scoped)", () => {
  let apiKey: string;

  beforeAll(async () => {
    apiKey = await mintKey("org_keys", "user_keys", "Bootstrap Key");
  });

  it("creates a new API key", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/keys",
      authed(apiKey, { method: "POST", body: JSON.stringify({ label: "CI Key" }) }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; prefix: string; label: string };
    expect(body.key).toMatch(/^zv_/);
    expect(body.label).toBe("CI Key");
  });

  it("a key created in org_keys works and is org-scoped", async () => {
    const createRes = await SELF.default.fetch(
      "https://localhost/v1/keys",
      authed(apiKey, { method: "POST", body: JSON.stringify({ label: "Scoped" }) }),
    );
    const created = (await createRes.json()) as { key: string };

    const who = await SELF.default.fetch("https://localhost/v1/whoami", authed(created.key));
    const body = (await who.json()) as { orgId: string };
    expect(body.orgId).toBe("org_keys");
  });

  it("lists keys only for its own org", async () => {
    const otherKey = await mintKey("org_keys_other", "user_other", "Other Bootstrap");
    // Create an extra key in the other org.
    await SELF.default.fetch(
      "https://localhost/v1/keys",
      authed(otherKey, { method: "POST", body: JSON.stringify({ label: "Other Only" }) }),
    );

    const res = await SELF.default.fetch("https://localhost/v1/keys", authed(otherKey));
    const body = (await res.json()) as { keys: { label?: string }[] };
    expect(body.keys.every((k) => k.label !== "CI Key")).toBe(true);
    expect(body.keys.some((k) => k.label === "Other Only")).toBe(true);
  });

  it("revokes a key (no longer valid)", async () => {
    const createRes = await SELF.default.fetch(
      "https://localhost/v1/keys",
      authed(apiKey, { method: "POST", body: JSON.stringify({ label: "To Revoke" }) }),
    );
    const created = (await createRes.json()) as { key: string; id: number };

    const check = await SELF.default.fetch("https://localhost/v1/whoami", authed(created.key));
    expect(check.status).toBe(200);

    const revoke = await SELF.default.fetch(
      `https://localhost/v1/keys/${created.id}`,
      authed(apiKey, { method: "DELETE" }),
    );
    expect(revoke.status).toBe(204);

    const after = await SELF.default.fetch("https://localhost/v1/whoami", authed(created.key));
    expect(after.status).toBe(401);
  });
});

describe("Rate limit bucketing", () => {
  it("two orgs get independent limiter results", async () => {
    const keyA = await mintKey("org_rl_a", "user_rl_a");
    const keyB = await mintKey("org_rl_b", "user_rl_b");

    const resA = await SELF.default.fetch("https://localhost/v1/whoami", authed(keyA));
    const resB = await SELF.default.fetch("https://localhost/v1/whoami", authed(keyB));
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
  });
});
