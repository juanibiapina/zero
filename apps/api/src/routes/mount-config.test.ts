import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { UserDO, S3MountConfig } from "../UserDO/index";
import { createMountConfigRoutes } from "./mount-config";
import type { Env } from "../types";
import type { ValidateResult } from "../s3-validate";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type UserDOStub = Pick<
  UserDO,
  "getMountConfig" | "setMountConfig" | "deleteMountConfig"
>;

const createFakeUserDO = (): UserDOStub & {
  _configs: Map<string, S3MountConfig>;
} => {
  const configs = new Map<string, S3MountConfig>();
  return {
    _configs: configs,
    getMountConfig: (scope: string) => configs.get(scope) ?? null,
    setMountConfig: (scope: string, config: S3MountConfig) => {
      configs.set(scope, config);
    },
    deleteMountConfig: (scope: string) => {
      configs.delete(scope);
    },
  };
};

const fakeEnv = (userDO?: UserDOStub) =>
  ({
    USER_DO: {
      idFromName: (_name: string) => ({ toString: () => "fake-id" }),
      get: () => userDO ?? createFakeUserDO(),
    },
  }) as unknown as Env;

const alwaysOk = async (): Promise<ValidateResult> => ({ ok: true });
const alwaysFail = async (): Promise<ValidateResult> => ({
  ok: false,
  error: "NoSuchBucket",
});

const buildApp = (
  env: Env,
  userId: string,
  validator = alwaysOk,
) => {
  const app = new OpenAPIHono<{
    Bindings: Env;
    Variables: { userId: string };
  }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createMountConfigRoutes(validator));
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, env),
  };
};

const validConfig = {
  endpoint: "https://s3.example.com",
  bucket: "my-notes",
  prefix: "",
  accessKeyId: "AKIA...",
  secretAccessKey: "super-secret",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/mount-config/notes", () => {
  it("returns null when no config exists", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/mount-config/notes");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("returns config with secret key redacted", async () => {
    const userDO = createFakeUserDO();
    userDO._configs.set("notes", validConfig);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/mount-config/notes");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      endpoint: "https://s3.example.com",
      bucket: "my-notes",
      prefix: "",
      accessKeyId: "AKIA...",
    });
    expect(body).not.toHaveProperty("secretAccessKey");
  });
});

describe("PUT /api/mount-config/notes", () => {
  it("validates then saves config on success", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc", alwaysOk);

    const res = await app.request("/api/mount-config/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validConfig),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      endpoint: "https://s3.example.com",
      bucket: "my-notes",
      prefix: "",
      accessKeyId: "AKIA...",
    });
    expect(body).not.toHaveProperty("secretAccessKey");
    expect(userDO._configs.get("notes")).toEqual(validConfig);
  });

  it("rejects with 422 when validation fails", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc", alwaysFail);

    const res = await app.request("/api/mount-config/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validConfig),
    });

    expect(res.status).toBe(422);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("NoSuchBucket");
    expect(userDO._configs.has("notes")).toBe(false);
  });

  it("rejects invalid payload with 400", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/mount-config/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "not-a-url", bucket: "" }),
    });

    expect(res.status).toBe(400);
    expect(userDO._configs.has("notes")).toBe(false);
  });
});

describe("POST /api/mount-config/notes/validate", () => {
  it("returns ok:true when saved config is valid", async () => {
    const userDO = createFakeUserDO();
    userDO._configs.set("notes", validConfig);
    const app = buildApp(fakeEnv(userDO), "user_abc", alwaysOk);

    const res = await app.request("/api/mount-config/notes/validate", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns ok:false with error when saved config fails validation", async () => {
    const userDO = createFakeUserDO();
    userDO._configs.set("notes", validConfig);
    const app = buildApp(fakeEnv(userDO), "user_abc", alwaysFail);

    const res = await app.request("/api/mount-config/notes/validate", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "NoSuchBucket" });
  });

  it("returns 404 when no config is saved", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/mount-config/notes/validate", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("no config saved");
  });
});

describe("DELETE /api/mount-config/notes", () => {
  it("removes config and returns null", async () => {
    const userDO = createFakeUserDO();
    userDO._configs.set("notes", validConfig);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/mount-config/notes", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(userDO._configs.has("notes")).toBe(false);
  });

  it("returns null even when no config existed", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/mount-config/notes", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});
