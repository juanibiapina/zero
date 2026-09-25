import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { Task } from "../store/tasks";
import type { Project } from "../store/projects";
import type { WaitingCondition } from "../store/waiting-conditions";
import type { Env } from "../types";
import { createTasksRoutes } from "./tasks";
import { createProjectsRoutes } from "./projects";
import { createWaitsRoutes } from "./waits";
import { createTaskSyncRoutes } from "./task-sync";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const build = (environment: string, userId: string) => {
  const tasks = new Map<string, Task>();
  const projects = new Map<string, Project>();
  const conditions = new Map<string, WaitingCondition>();
  const calls: string[] = [];
  const taskDO = {
    isErased: () => false,
    listRecoveries: () => [],
    listProjectRecoveries: () => [],
    listConditionRecoveries: () => [],
    listWaitingConditions: () => [...conditions.values()].filter((condition) => !condition.resolvedAt),
    addWaitingCondition: (id: string, projectId: string, text: string) => {
      calls.push("taskdo:wait-add");
      if (!projects.has(projectId)) return null;
      const condition: WaitingCondition = { id, projectId, kind: "free-text", text,
        refId: null, targetStatus: null, resolvedAt: null, createdAt: "2026-09-25T00:00:00.000Z" };
      conditions.set(id, condition);
      return condition;
    },
    resolveWaitingCondition: (id: string) => {
      calls.push("taskdo:wait-resolve");
      const condition = conditions.get(id);
      if (!condition) return null;
      condition.resolvedAt = "2026-09-25T00:00:01.000Z";
      return condition;
    },
    deleteWaitingCondition: (id: string) => { calls.push("taskdo:wait-delete"); conditions.delete(id); },
    listTasks: () => [...tasks.values()],
    addTask: (id: string, text: string, showUpDate: string | null, projectId: string | null = null) => {
      calls.push("taskdo:add");
      const existing = tasks.get(id);
      if (existing) return existing;
      if (projectId && !projects.has(projectId)) return null;
      const task: Task = {
        id, text, showUpDate, createdAt: "2026-09-25T00:00:00.000Z",
        completedAt: null, recurrence: null, recurrenceDate: null,
        projectId, sourceCaptureId: null, sortKey: null,
      };
      tasks.set(id, task);
      return task;
    },
    patchTask: (id: string, fields: Partial<Task>) => {
      calls.push("taskdo:edit");
      const task = tasks.get(id);
      if (!task) return null;
      Object.assign(task, fields);
      return task;
    },
    completeTask: (id: string) => {
      calls.push("taskdo:complete");
      const task = tasks.get(id);
      if (!task) return null;
      task.completedAt = "2026-09-25T00:00:01.000Z";
      return task;
    },
    reopenTask: (id: string) => {
      calls.push("taskdo:reopen");
      const task = tasks.get(id);
      if (!task) return null;
      task.completedAt = null;
      return task;
    },
    listProjects: () => { calls.push("taskdo:projects"); return [...projects.values()]; },
    addProject: (id: string, title: string) => {
      calls.push("taskdo:project-add");
      const existing = projects.get(id);
      if (existing) return existing;
      const project: Project = {
        id, title, icon: "📁", description: null, state: "in-play",
        createdAt: "2026-09-25T00:00:00.000Z", sourceCaptureId: null,
      };
      projects.set(id, project);
      return project;
    },
    editProject: (id: string, fields: Partial<Project>) => {
      calls.push("taskdo:project-edit");
      const project = projects.get(id);
      if (!project) return null;
      Object.assign(project, fields);
      return project;
    },
    setProjectState: (id: string, state: Project["state"]) => {
      calls.push("taskdo:project-state");
      const project = projects.get(id);
      if (!project) return null;
      project.state = state;
      return project;
    },
    deleteProject: (id: string) => {
      calls.push("taskdo:project-delete");
      projects.delete(id);
      let count = 0;
      for (const task of tasks.values()) {
        if (task.projectId === id) { tasks.delete(task.id); count++; }
      }
      return { tasks: count, conditions: 0, afters: 0 };
    },
  };
  const userDO = {
    getTodoAuthority: () => ({ authority: "legacy" as const, generation: null }),
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
  app.route("/", createTaskSyncRoutes());
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

  it("completes, reopens, and reorders a Task in TaskDO", async () => {
    const app = build("test", "taskdo-proof-a");
    expect((await app.request("/api/tasks", "POST", { id: TASK_ID, text: "Work" })).status).toBe(201);
    expect((await app.request(`/api/tasks/${TASK_ID}`, "PATCH", { sortKey: "a1", showUpDate: "2026-09-26" })).status).toBe(200);
    expect((await app.request(`/api/tasks/${TASK_ID}/complete`, "POST")).status).toBe(200);
    expect((await app.request(`/api/tasks/${TASK_ID}/reopen`, "POST")).status).toBe(200);
    expect(await (await app.request("/api/tasks")).json()).toMatchObject({ tasks: [{ sortKey: "a1", completedAt: null }] });
    expect(app.calls).toEqual(["taskdo:add", "taskdo:edit", "taskdo:complete", "taskdo:reopen"]);
  });

  it("creates a linked Task through TaskDO and deletes it with its Project", async () => {
    const app = build("test", "taskdo-proof-a");
    expect((await app.request("/api/tasks", "POST", { id: TASK_ID, text: "linked", projectId: PROJECT_ID })).status).toBe(409);
    expect((await app.request("/api/projects", "POST", { id: PROJECT_ID, title: "Project" })).status).toBe(201);
    expect((await app.request("/api/tasks", "POST", { id: TASK_ID, text: "linked", projectId: PROJECT_ID })).status).toBe(201);
    expect(await (await app.request("/api/projects")).json()).toMatchObject({ projects: [{ id: PROJECT_ID }] });
    expect(await (await app.request("/api/tasks")).json()).toMatchObject({ tasks: [{ projectId: PROJECT_ID }] });
    expect((await app.request(`/api/projects/${PROJECT_ID}`, "DELETE")).status).toBe(204);
    expect(await (await app.request("/api/tasks")).json()).toEqual({ tasks: [] });
    expect(app.calls).toEqual([
      "taskdo:add", "taskdo:project-add", "taskdo:add", "taskdo:projects",
      "taskdo:project-delete",
    ]);
  });

  it("edits a Project and resolves its Waiting condition without UserDO", async () => {
    const app = build("test", "taskdo-proof-a");
    expect((await app.request("/api/projects", "POST", { id: PROJECT_ID, title: "Project" })).status).toBe(201);
    expect((await app.request(`/api/projects/${PROJECT_ID}`, "PATCH", { title: "Edited", state: "backlog" })).status).toBe(200);
    const added = await app.request("/api/waits", "POST", {
      id: TASK_ID, projectId: PROJECT_ID, kind: "free-text", text: "Await reply",
    });
    expect(added.status).toBe(201);
    expect(await (await app.request("/api/waits")).json()).toMatchObject({ conditions: [{ text: "Await reply" }] });
    expect((await app.request(`/api/waits/${TASK_ID}/resolve`, "POST")).status).toBe(200);
    expect(await (await app.request("/api/waits")).json()).toEqual({ conditions: [] });
    expect((await app.request(`/api/waits/${TASK_ID}`, "DELETE")).status).toBe(204);
    expect(app.calls).toEqual([
      "taskdo:project-add", "taskdo:project-edit", "taskdo:project-state",
      "taskdo:wait-add", "taskdo:wait-resolve", "taskdo:wait-delete",
    ]);
  });

  it("does not expose unsupported fixture mutations", async () => {
    const app = build("test", "taskdo-proof-a");
    expect((await app.request(`/api/tasks/${TASK_ID}`, "DELETE")).status).toBe(404);
    expect((await app.request(`/api/tasks/${TASK_ID}/unknown`, "POST")).status).toBe(404);
    expect(await (await app.request("/api/waits")).json()).toEqual({ conditions: [] });
    expect(await (await app.request("/api/task-recoveries")).json()).toEqual({ tasks: [], projects: [], conditions: [] });
    expect(app.calls).toEqual([]);
  });

  it("does not use TaskDO outside the test environment", async () => {
    const app = build("production", "taskdo-proof-a");
    expect((await app.request("/api/tasks")).status).toBe(200);
    expect((await app.request("/api/task-recoveries")).status).toBe(404);
    expect(app.calls).toEqual(["user:list"]);
  });
});
