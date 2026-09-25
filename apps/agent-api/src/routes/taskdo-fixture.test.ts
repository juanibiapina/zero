import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { Task } from "../store/tasks";
import type { Env } from "../types";
import { createTasksRoutes } from "./tasks";
import { createProjectsRoutes } from "./projects";
import { createWaitsRoutes } from "./waits";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const build = (environment: string, userId: string) => {
  const tasks = new Map<string, Task>();
  const calls: string[] = [];
  const taskDO = {
    listTasks: () => [...tasks.values()],
    addTask: (id: string, text: string, showUpDate: string | null) => {
      calls.push("taskdo:add");
      const existing = tasks.get(id);
      if (existing) return existing;
      const task: Task = {
        id, text, showUpDate, createdAt: "2026-09-25T00:00:00.000Z",
        completedAt: null, recurrence: null, recurrenceDate: null,
        projectId: null, sourceCaptureId: null, sortKey: null,
      };
      tasks.set(id, task);
      return task;
    },
    editTask: (id: string, text: string) => {
      calls.push("taskdo:edit");
      const task = tasks.get(id);
      if (!task) return null;
      task.text = text;
      return task;
    },
  };
  const userDO = {
    listTasks: () => { calls.push("user:list"); return []; },
    addTask: () => { calls.push("user:add"); return null; },
  };
  const env = {
    ENVIRONMENT: environment,
    TASK_DO: { idFromName: (id: string) => id, get: () => taskDO },
    USER_DO: { idFromName: (id: string) => id, get: () => userDO },
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (c, next) => { c.set("userId", userId); await next(); });
  app.route("/", createTasksRoutes());
  app.route("/", createProjectsRoutes());
  app.route("/", createWaitsRoutes());
  return {
    calls,
    request: (path: string, method = "GET", body?: object) => app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    }), env),
  };
};

describe("TaskDO fixture routes", () => {
  it("reads, creates, and edits a loose Task without consulting UserDO", async () => {
    const app = build("test", "taskdo-proof-a");
    expect(await (await app.request("/api/tasks")).json()).toEqual({ tasks: [] });
    const created = await app.request("/api/tasks", "POST", { id: TASK_ID, text: "phone" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ task: { text: "phone" } });
    const edited = await app.request(`/api/tasks/${TASK_ID}`, "PATCH", { text: "web" });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ task: { text: "web" } });
    expect(await (await app.request("/api/tasks")).json()).toMatchObject({ tasks: [{ text: "web" }] });
    expect(app.calls).toEqual(["taskdo:add", "taskdo:edit"]);
  });

  it("rejects every linked or unsupported write before touching UserDO", async () => {
    const app = build("test", "taskdo-proof-a");
    expect((await app.request("/api/tasks", "POST", { id: TASK_ID, text: "linked", projectId: PROJECT_ID })).status).toBe(400);
    expect((await app.request(`/api/tasks/${TASK_ID}/complete`, "POST")).status).toBe(409);
    expect((await app.request("/api/projects", "POST", { id: PROJECT_ID, title: "No" })).status).toBe(409);
    expect((await app.request("/api/waits", "POST", { id: TASK_ID, projectId: PROJECT_ID, kind: "free-text", text: "No" })).status).toBe(409);
    expect(await (await app.request("/api/projects")).json()).toEqual({ projects: [] });
    expect(await (await app.request("/api/waits")).json()).toEqual({ conditions: [] });
    expect(app.calls).toEqual([]);
  });

  it("does not use TaskDO outside the test environment", async () => {
    const app = build("production", "taskdo-proof-a");
    expect((await app.request("/api/tasks")).status).toBe(200);
    expect(app.calls).toEqual(["user:list"]);
  });
});
