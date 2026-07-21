import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { UserDO } from "../UserDO/index";
import { createOnboardingRoutes } from "./onboarding";
import type { Env } from "../types";

// POST /api/onboarding/google queues a one-shot Gmail scan on the DO. Enqueue
// is idempotent (queueOnboarding no-ops once status leaves null).

type UserDOStub = Pick<UserDO, "queueOnboarding">;

// Fake DO that models the null -> queued idempotency guard.
const createFakeUserDO = () => {
  let status: string | null = null;
  return {
    get _status() {
      return status;
    },
    setStatus: (s: string | null) => void (status = s),
    queueOnboarding: async (force = false) => {
      if (!force && status !== null) return;
      status = "queued";
    },
  };
};

const fakeEnv = (userDO: UserDOStub): Env =>
  ({
    USER_DO: {
      idFromName: () => ({ toString: () => "fake-id" }),
      get: () => userDO,
    },
  }) as unknown as Env;

const buildApp = (env: Env, userId: string) => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createOnboardingRoutes());
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
};

describe("POST /api/onboarding/google", () => {
  it("queues onboarding and returns 202", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/onboarding/google", { method: "POST" });

    expect(res.status).toBe(202);
    expect(userDO._status).toBe("queued");
  });

  it("is idempotent: a second call does not re-queue", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    await app.request("/api/onboarding/google", { method: "POST" });
    const res = await app.request("/api/onboarding/google", { method: "POST" });

    expect(res.status).toBe(202);
    // Still "queued" (the guard prevented a second enqueue from changing it).
    expect(userDO._status).toBe("queued");
  });

  it("force=true re-queues an already-onboarded user", async () => {
    const userDO = createFakeUserDO();
    userDO.setStatus("done");
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/onboarding/google?force=true", {
      method: "POST",
    });

    expect(res.status).toBe(202);
    expect(userDO._status).toBe("queued");
  });
});
