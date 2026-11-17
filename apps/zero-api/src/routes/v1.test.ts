import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../types";
import { taskDoEnv } from "./taskdo-test-stub";
import { createV1Routes } from "./v1";

const TODAY = "2026-03-10";

type Outcome = { ok: true; changed: boolean; value: unknown } | { ok: false; error: string };
type Run = (name: string, input: unknown, today: string) => Promise<Outcome>;

function buildApp(runOperation: Run = vi.fn()) {
  const env = { ...taskDoEnv({ runOperation }), ENVIRONMENT: "test" } as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createV1Routes({ resolveToday: async () => TODAY }));
  return (path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}) => {
    const { json, token = "user-abc", ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (json !== undefined) headers.set("Content-Type", "application/json");
    return app.fetch(new Request(`http://localhost${path}`, {
      ...rest,
      headers,
      body: json === undefined ? rest.body : JSON.stringify(json),
    }), env);
  };
}

const ok = (value: unknown): Outcome => ({ ok: true, changed: true, value });
const conflict = (error: string): Outcome => ({ ok: false, error });

describe("/api/v1 tasks", () => {
  it("lists the Tasks on Home with the user's today", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ today: TODAY, tasks: [{ id: "t1" }] }));
    const response = await buildApp(runOperation)("/api/v1/tasks?view=home");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ today: TODAY, tasks: [{ id: "t1" }] });
    expect(runOperation).toHaveBeenCalledWith("tasks_list", { view: "home" }, TODAY);
  });

  it("filters the list by Project", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ today: TODAY, tasks: [] }));
    await buildApp(runOperation)("/api/v1/tasks?projectId=p1");
    expect(runOperation).toHaveBeenCalledWith("tasks_list", { parent: { kind: "project", projectId: "p1" } }, TODAY);
  });

  it("creates a Task and answers 201", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ id: "t1", text: "Buy milk" }));
    const response = await buildApp(runOperation)("/api/v1/tasks", {
      method: "POST",
      json: { text: "Buy milk", showUpDate: "2026-03-11", parent: { kind: "project", projectId: "p1" } },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ task: { id: "t1", text: "Buy milk" } });
    expect(runOperation).toHaveBeenCalledWith(
      "tasks_create",
      { text: "Buy milk", showUpDate: "2026-03-11", parent: { kind: "project", projectId: "p1" } },
      TODAY,
    );
  });

  it("rejects an invalid body with 400 before touching the workspace", async () => {
    const runOperation = vi.fn<Run>();
    const response = await buildApp(runOperation)("/api/v1/tasks", { method: "POST", json: { text: "" } });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid-request" });
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("updates a Task by id", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ id: "t1", text: "x" }));
    const response = await buildApp(runOperation)("/api/v1/tasks/t1", {
      method: "PATCH",
      json: { text: "x", showUpDate: null, parent: null },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: { id: "t1", text: "x" } });
    expect(runOperation).toHaveBeenCalledWith("tasks_update", { id: "t1", text: "x", showUpDate: null, parent: null }, TODAY);
  });

  it("completes and reopens a Task", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ id: "t1" }));
    const request = buildApp(runOperation);

    expect((await request("/api/v1/tasks/t1/complete", { method: "POST" })).status).toBe(200);
    expect((await request("/api/v1/tasks/t1/reopen", { method: "POST" })).status).toBe(200);
    expect(runOperation).toHaveBeenNthCalledWith(1, "tasks_complete", { id: "t1" }, TODAY);
    expect(runOperation).toHaveBeenNthCalledWith(2, "tasks_reopen", { id: "t1" }, TODAY);
  });

  it.each([
    ["missing-task", 404],
    ["missing-project", 409],
    ["missing-recording", 409],
    ["id-conflict", 409],
    ["invalid-recurrence", 409],
    ["nothing to update", 400],
  ])("answers %s with %i", async (error, status) => {
    const response = await buildApp(async () => conflict(error))("/api/v1/tasks/t1", { method: "PATCH", json: { text: "x" } });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("answers missing-project on create with 409", async () => {
    const response = await buildApp(async () => conflict("missing-project"))("/api/v1/tasks", {
      method: "POST",
      json: { text: "x", parent: { kind: "project", projectId: "gone" } },
    });
    expect(response.status).toBe(409);
  });
});

describe("/api/v1 projects", () => {
  it("lists Projects, done ones on request", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ today: TODAY, projects: [] }));
    const request = buildApp(runOperation);

    const response = await request("/api/v1/projects");
    await request("/api/v1/projects?includeDone=true");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ today: TODAY, projects: [] });
    expect(runOperation).toHaveBeenNthCalledWith(1, "projects_list", {}, TODAY);
    expect(runOperation).toHaveBeenNthCalledWith(2, "projects_list", { includeDone: true }, TODAY);
  });

  it("creates a Project and answers 201", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ id: "p1", title: "Trip" }));
    const response = await buildApp(runOperation)("/api/v1/projects", {
      method: "POST",
      json: { title: "Trip", icon: "✈️", state: "backlog" },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project: { id: "p1", title: "Trip" } });
    expect(runOperation).toHaveBeenCalledWith("projects_create", { title: "Trip", icon: "✈️", state: "backlog" }, TODAY);
  });

  it("answers id-conflict on create with 409", async () => {
    const response = await buildApp(async () => conflict("id-conflict"))("/api/v1/projects", {
      method: "POST",
      json: { title: "Trip" },
    });
    expect(response.status).toBe(409);
  });

  it("edits a Project's fields", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ id: "p1", title: "Trip" }));
    const response = await buildApp(runOperation)("/api/v1/projects/p1", {
      method: "PATCH",
      json: { title: "Trip", description: null },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: { id: "p1", title: "Trip" } });
    expect(runOperation).toHaveBeenCalledTimes(1);
    expect(runOperation).toHaveBeenCalledWith("projects_edit", { id: "p1", title: "Trip", description: null }, TODAY);
  });

  it("sets a Project's state after editing its fields", async () => {
    const runOperation = vi.fn<Run>(async (name) => ok({ id: "p1", via: name }));
    const response = await buildApp(runOperation)("/api/v1/projects/p1", {
      method: "PATCH",
      json: { title: "Trip", state: "done" },
    });

    expect(await response.json()).toEqual({ project: { id: "p1", via: "projects_set_state" } });
    expect(runOperation).toHaveBeenNthCalledWith(1, "projects_edit", { id: "p1", title: "Trip" }, TODAY);
    expect(runOperation).toHaveBeenNthCalledWith(2, "projects_set_state", { id: "p1", state: "done" }, TODAY);
  });

  it("sets only the state when no field changes", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ id: "p1" }));
    await buildApp(runOperation)("/api/v1/projects/p1", { method: "PATCH", json: { state: "backlog" } });

    expect(runOperation).toHaveBeenCalledTimes(1);
    expect(runOperation).toHaveBeenCalledWith("projects_set_state", { id: "p1", state: "backlog" }, TODAY);
  });

  it("answers an empty edit with 400", async () => {
    const runOperation = vi.fn<Run>();
    const response = await buildApp(runOperation)("/api/v1/projects/p1", { method: "PATCH", json: {} });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "nothing to update" });
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("answers missing-project on edit with 404", async () => {
    const response = await buildApp(async () => conflict("missing-project"))("/api/v1/projects/gone", {
      method: "PATCH",
      json: { state: "done" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "missing-project" });
  });

  it("deletes a Project and returns what was removed", async () => {
    const runOperation = vi.fn<Run>(async () => ok({ tasks: 2, conditions: 1, afters: 0 }));
    const response = await buildApp(runOperation)("/api/v1/projects/p1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: { tasks: 2, conditions: 1, afters: 0 } });
    expect(runOperation).toHaveBeenCalledWith("projects_delete", { id: "p1" }, TODAY);
  });
});

describe("/api/v1 access", () => {
  it("answers 401 without a bearer token", async () => {
    const runOperation = vi.fn<Run>();
    const response = await buildApp(runOperation)("/api/v1/tasks", { token: null });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown path", async () => {
    const response = await buildApp()("/api/v1/nope");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not-found" });
  });

  it("publishes an OpenAPI document with every route", async () => {
    const response = await buildApp()("/api/v1/openapi.json", { token: null });
    const document = await response.json<{ paths: Record<string, Record<string, unknown>> }>();

    const routes = Object.entries(document.paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();
    expect(routes).toEqual([
      "DELETE /api/v1/projects/{id}",
      "GET /api/v1/projects",
      "GET /api/v1/tasks",
      "PATCH /api/v1/projects/{id}",
      "PATCH /api/v1/tasks/{id}",
      "POST /api/v1/projects",
      "POST /api/v1/tasks",
      "POST /api/v1/tasks/{id}/complete",
      "POST /api/v1/tasks/{id}/reopen",
    ]);
  });
});
