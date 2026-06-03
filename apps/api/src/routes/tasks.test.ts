import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { UserDO } from "../UserDO/index";
import type { AgentStub } from "../agent-client";
import { createTaskRoutes } from "./tasks";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type UserDOStub = Pick<UserDO, "recordTaskSession" | "getSettings" | "setGoogleOnboardingStatus">;

const createFakeUserDO = () => {
  let googleOnboardingStatus: string | null = null;
  const sessions = new Map<string, { name?: string }>();
  return {
    get _googleOnboardingStatus() { return googleOnboardingStatus; },
    _sessions: sessions,
    recordTaskSession: (sessionId: string, name?: string) => {
      sessions.set(sessionId, name ? { name } : {});
    },
    getSettings: () => ({ onboardingSeen: false, googleOnboardingStatus, createdAt: new Date().toISOString(), isNewUser: false }),
    setGoogleOnboardingStatus: (status: string) => { googleOnboardingStatus = status; },
  };
};

const fakeStub = (sessionId = "task-session-1"): AgentStub => {
  const live = new Set<string>();
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/sessions") {
        live.add(sessionId);
        return Response.json({ sessionId });
      }
      const m = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (req.method === "POST" && m) {
        if (!live.has(m[1])) return Response.json({ error: "not found" }, { status: 404 });
        return new Response(null, { status: 202 });
      }
      return new Response("bad route", { status: 500 });
    },
  };
};

const fakeEnv = (userDO: UserDOStub, stub?: AgentStub): Env =>
  ({
    AGENT_CONTAINER: {
      getByName: () => stub ?? fakeStub(),
    },
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
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, env),
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/tasks", () => {
  it("fires unnamed task (existing behavior)", async () => {
    const userDO = createFakeUserDO();
    const stub = fakeStub("sess-1");
    const app = buildApp(fakeEnv(userDO, stub), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "do something" }),
    });

    expect(res.status).toBe(202);
    expect(userDO._sessions.has("sess-1")).toBe(true);
  });

  it("fires named task and sets status to running", async () => {
    const userDO = createFakeUserDO();
    const stub = fakeStub("sess-1");
    const app = buildApp(fakeEnv(userDO, stub), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "onboard", name: "google-onboarding" }),
    });

    expect(res.status).toBe(202);
    expect(userDO._googleOnboardingStatus).toBe("running");
    expect(userDO._sessions.get("sess-1")).toEqual({ name: "google-onboarding" });
  });

  it("skips when google-onboarding is already running", async () => {
    const userDO = createFakeUserDO();
    userDO.setGoogleOnboardingStatus("running");
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "onboard", name: "google-onboarding" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "running" });
    expect(userDO._sessions.size).toBe(0);
  });

  it("skips when google-onboarding is done", async () => {
    const userDO = createFakeUserDO();
    userDO.setGoogleOnboardingStatus("done");
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "onboard", name: "google-onboarding" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "done" });
    expect(userDO._sessions.size).toBe(0);
  });
});
