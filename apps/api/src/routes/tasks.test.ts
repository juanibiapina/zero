import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { UserDO } from "../UserDO/index";
import { createTaskRoutes } from "./tasks";
import type { Env } from "../types";

// The container-backed task runner was removed; /api/tasks is a parked stub.
// It accepts the request, no-ops, and marks Google onboarding done so the web
// onboarding flow completes.

type UserDOStub = Pick<UserDO, "setGoogleOnboardingStatus">;

const createFakeUserDO = () => {
  let googleOnboardingStatus: string | null = null;
  return {
    get _googleOnboardingStatus() {
      return googleOnboardingStatus;
    },
    setGoogleOnboardingStatus: (status: string) => {
      googleOnboardingStatus = status;
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
  app.route("/", createTaskRoutes());
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
};

describe("POST /api/tasks (parked stub)", () => {
  it("accepts an unnamed task and no-ops with 202", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "do something" }),
    });

    expect(res.status).toBe(202);
    expect(userDO._googleOnboardingStatus).toBeNull();
  });

  it("marks google-onboarding done", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "onboard", name: "google-onboarding" }),
    });

    expect(res.status).toBe(202);
    expect(userDO._googleOnboardingStatus).toBe("done");
  });
});
