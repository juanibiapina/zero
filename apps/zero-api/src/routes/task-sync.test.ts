import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import { taskSyncPath } from "@zero/agent-core";

import type { Env } from "../types";
import { createTaskSyncRoutes } from "./task-sync";
import { taskDoEnv } from "./taskdo-test-stub";

function buildApp(methods: object) {
  const env = taskDoEnv(methods);
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (context, next) => {
    context.set("userId", "user-abc");
    await next();
  });
  app.route("/", createTaskSyncRoutes());
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init), env);
}

describe("TaskDO synchronization routes", () => {
  it("returns every recovery projection", async () => {
    const recoveries = {
      tasks: [{ taskId: "task", projectId: null, reason: "invalid-task" }],
      projects: [{ projectId: "project", reason: "invalid-project" }],
      conditions: [{ conditionId: "condition", projectId: null, refId: null, reason: "invalid-row" }],
    };
    const response = await buildApp({
      isErased: () => false,
      listRecoveries: () => recoveries.tasks,
      listProjectRecoveries: () => recoveries.projects,
      listConditionRecoveries: () => recoveries.conditions,
    })("/api/task-recoveries");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(recoveries);
  });

  it.each(["/api/task-recoveries", "/api/task-sync"])("rejects erased accounts at %s", async (path) => {
    const response = await buildApp({ isErased: () => true })(path);
    expect(response.status).toBe(410);
    expect(await response.text()).toBe("Account erased");
  });

  it("requires a WebSocket upgrade before delegating synchronization", async () => {
    const response = await buildApp({ isErased: () => false })("/api/task-sync");
    expect(response.status).toBe(426);
    expect(await response.text()).toBe("Upgrade required");
  });

  it.each(["/api/task-sync", "/api/task-sync?schema=1"])("refuses an app that syncs an older store format at %s", async (path) => {
    const fetch = vi.fn();
    const response = await buildApp({ isErased: () => false, fetch })(path, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(426);
    expect(await response.text()).toBe("Update the app to sync");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rewrites the synchronization path before delegating to TaskDO", async () => {
    const fetch = vi.fn((request: Request) => new Response(new URL(request.url).pathname));
    const response = await buildApp({ isErased: () => false, fetch })(taskSyncPath, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/sync");
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0][0].url).search).toBe("");
  });
});
