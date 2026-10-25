import { describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { UserSettings } from "../UserDO/index";
import type { Env } from "../types";
import { createUserSettingsRoutes } from "./user-settings";

const fakeTaskNamespace = () => {
  const calls: string[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      purge: async () => { calls.push(name); },
      reset: () => { throw new Error("task data deleted"); },
    }),
  };
  return { namespace, calls };
};

const createFakeUserDO = () => {
  let row: { createdAt: string; timezone: string | null } | null = null;
  let deletions = 0;
  return {
    get deletions() {
      return deletions;
    },
    get timezone() {
      return row?.timezone ?? null;
    },
    getSettings: (): UserSettings => {
      if (row) return { ...row, isNewUser: false };
      row = { createdAt: new Date().toISOString(), timezone: null };
      return { ...row, isNewUser: true };
    },
    updateSettings: (patch: { timezone?: string }) => {
      row ??= { createdAt: new Date().toISOString(), timezone: null };
      if (patch.timezone !== undefined) row.timezone = patch.timezone;
    },
    deleteAllData: async () => {
      deletions += 1;
      row = null;
    },
    reset: () => {
      // The real one aborts the object, which the caller sees as a rejected RPC.
      throw new Error("user data deleted");
    },
  };
};

const fakeAnalytics = () => ({ writeDataPoint: vi.fn() });

const buildApp = (
  userDO = createFakeUserDO(),
  analytics = fakeAnalytics(),
  tasks = fakeTaskNamespace(),
) => {
  const env = {
    ANALYTICS: analytics,
    USER_DO: { idFromName: () => "fake-id", get: () => userDO },
    TASK_DO: tasks.namespace,
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", "user_abc");
    await next();
  });
  app.route("/", createUserSettingsRoutes());
  return (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init), env);
};

const patch = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("DELETE /api/user-data", () => {
  it("erases the user's tasks and settings", async () => {
    const userDO = createFakeUserDO();
    const tasks = fakeTaskNamespace();
    const request = buildApp(userDO, undefined, tasks);

    const res = await request("/api/user-data", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(tasks.calls).toEqual(["user_abc"]);
    expect(userDO.deletions).toBe(1);
  });

  it("reports failure instead of claiming the data is gone", async () => {
    const userDO = createFakeUserDO();
    userDO.deleteAllData = () => Promise.reject(new Error("storage unavailable"));
    const request = buildApp(userDO);

    const res = await request("/api/user-data", { method: "DELETE" });

    expect(res.status).toBe(500);
  });
});

describe("GET /api/user-settings", () => {
  it("returns createdAt and a null timezone on first access", async () => {
    const res = await buildApp()("/api/user-settings");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ createdAt: expect.any(String) as string, timezone: null });
  });

  it("writes the signup analytics event only on first access", async () => {
    const analytics = fakeAnalytics();
    const request = buildApp(undefined, analytics);

    await request("/api/user-settings");
    await request("/api/user-settings");

    expect(analytics.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(analytics.writeDataPoint).toHaveBeenCalledWith({ blobs: ["signup"], indexes: ["user_abc"] });
  });
});

describe("PATCH /api/user-settings", () => {
  it("stores a valid IANA timezone and returns it", async () => {
    const userDO = createFakeUserDO();

    const res = await buildApp(userDO)("/api/user-settings", patch({ timezone: "America/Sao_Paulo" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ timezone: "America/Sao_Paulo" });
    expect(userDO.timezone).toBe("America/Sao_Paulo");
  });

  it("rejects a non-IANA timezone with 400 and does not store it", async () => {
    const userDO = createFakeUserDO();

    const res = await buildApp(userDO)("/api/user-settings", patch({ timezone: "Mars/Phobos" }));

    expect(res.status).toBe(400);
    expect(userDO.timezone).toBeNull();
  });
});
