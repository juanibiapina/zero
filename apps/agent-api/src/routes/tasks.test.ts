import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import type { Recurrence } from "@zeroapps/recurrence";

import type { Task } from "../TaskDO/domain";
import type { Env } from "../types";
import { taskDoEnv } from "./taskdo-test-stub";
import { createTasksRoutes } from "./tasks";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const recurrence: Recurrence = {
  version: 1,
  origin: "2026-10-01",
  anchor: "scheduled",
  weekStartsOn: "MO",
  pattern: { unit: "day", interval: 1 },
};

const task = (over: Partial<Task> = {}): Task => ({
  id: TASK_ID,
  text: "buy milk",
  showUpDate: null,
  recurrence: null,
  recurrenceDate: null,
  createdAt: "2026-09-26T10:00:00.000Z",
  completedAt: null,
  projectId: null,
  sourceCaptureId: null,
  sortKey: "a0",
  ...over,
});

function buildApp(methods: object) {
  const env = taskDoEnv(methods);
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (context, next) => {
    context.set("userId", "user-abc");
    await next();
  });
  app.route("/", createTasksRoutes());
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init), env);
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("task routes", () => {
  it("returns the TaskDO list without applying a server-side date filter", async () => {
    const future = task({ showUpDate: "2999-01-01" });
    const listTasks = vi.fn(() => [future]);
    const response = await buildApp({ listTasks })("/api/tasks");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: [future] });
    expect(listTasks).toHaveBeenCalledOnce();
  });

  it("delegates task creation with every optional contract field", async () => {
    const created = task({
      text: "Pay rent",
      showUpDate: recurrence.origin,
      recurrence,
      recurrenceDate: recurrence.origin,
      projectId: PROJECT_ID,
      sourceCaptureId: TASK_ID,
    });
    const addTask = vi.fn(() => created);
    const response = await buildApp({ addTask })("/api/tasks", json("POST", {
      id: TASK_ID,
      text: "Pay rent",
      recurrence,
      projectId: PROJECT_ID,
      sourceCaptureId: TASK_ID,
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ task: created });
    expect(addTask).toHaveBeenCalledWith(
      TASK_ID, "Pay rent", null, PROJECT_ID, TASK_ID, recurrence,
    );
  });

  it("maps a rejected task id or Project reference to Conflict", async () => {
    const response = await buildApp({ addTask: () => null })("/api/tasks", json("POST", {
      id: TASK_ID,
      text: "linked",
      projectId: PROJECT_ID,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "task id is in use or project not found" });
  });

  it.each([
    { id: TASK_ID, text: "" },
    { id: TASK_ID, text: "task", showUpDate: "26/09/2026" },
    { id: "not-a-uuid", text: "task" },
    { id: TASK_ID, text: "task", projectId: "not-a-uuid" },
  ])("rejects malformed create input %# without calling TaskDO", async (body) => {
    const response = await buildApp({})("/api/tasks", json("POST", body));
    expect(response.status).toBe(400);
  });

  it("delegates all supported patch fields", async () => {
    const updated = task({ text: "edited", showUpDate: "2026-10-02", sortKey: "a5", projectId: PROJECT_ID });
    const patchTask = vi.fn(() => updated);
    const fields = { text: "edited", showUpDate: "2026-10-02", sortKey: "a5", projectId: PROJECT_ID };
    const response = await buildApp({ patchTask })(`/api/tasks/${TASK_ID}`, json("PATCH", fields));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: updated });
    expect(patchTask).toHaveBeenCalledWith(TASK_ID, fields);
  });

  it("preserves null clears when delegating a patch", async () => {
    const patchTask = vi.fn(() => task());
    const fields = { showUpDate: null, projectId: null };
    const response = await buildApp({ patchTask })(`/api/tasks/${TASK_ID}`, json("PATCH", fields));
    expect(response.status).toBe(200);
    expect(patchTask).toHaveBeenCalledWith(TASK_ID, fields);
  });

  it("maps patch domain results to Conflict and Not Found", async () => {
    const missingProject = await buildApp({ patchTask: () => "missing-project" })(
      `/api/tasks/${TASK_ID}`,
      json("PATCH", { projectId: PROJECT_ID }),
    );
    expect(missingProject.status).toBe(409);
    expect(await missingProject.json()).toEqual({ error: "project not found" });

    const missingTask = await buildApp({ patchTask: () => null })(
      `/api/tasks/${TASK_ID}`,
      json("PATCH", { text: "edited" }),
    );
    expect(missingTask.status).toBe(404);
  });

  it.each([
    {},
    { text: "" },
    { showUpDate: "tomorrow" },
    { sortKey: "" },
    { projectId: "not-a-uuid" },
  ])("rejects malformed patch input %# without calling TaskDO", async (body) => {
    const response = await buildApp({})(`/api/tasks/${TASK_ID}`, json("PATCH", body));
    expect(response.status).toBe(400);
  });

  it.each([
    ["completeTask", "complete", task({ completedAt: "2026-09-26T11:00:00.000Z" })],
    ["reopenTask", "reopen", task()],
  ] as const)("delegates %s and returns the response contract", async (method, path, result) => {
    const rpc = vi.fn(() => result);
    const response = await buildApp({ [method]: rpc })(`/api/tasks/${TASK_ID}/${path}`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: result });
    expect(rpc).toHaveBeenCalledWith(TASK_ID);
  });

  it.each([
    ["completeTask", "complete"],
    ["reopenTask", "reopen"],
  ] as const)("maps a missing task from %s to Not Found", async (method, path) => {
    const response = await buildApp({ [method]: () => null })(`/api/tasks/${TASK_ID}/${path}`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("delegates recurrence replacement and validates its shape", async () => {
    const result = task({ recurrence, recurrenceDate: recurrence.origin, showUpDate: recurrence.origin });
    const setTaskRecurrence = vi.fn(() => result);
    const request = buildApp({ setTaskRecurrence });
    const response = await request(`/api/tasks/${TASK_ID}/recurrence`, json("PUT", { recurrence }));
    expect(response.status).toBe(200);
    expect(setTaskRecurrence).toHaveBeenCalledWith(TASK_ID, recurrence);

    const malformed = await buildApp({})(`/api/tasks/${TASK_ID}/recurrence`, json("PUT", {
      recurrence: { version: 1 },
    }));
    expect(malformed.status).toBe(400);
  });

  it("delegates recurring occurrence completion and undo arguments", async () => {
    const completeTaskOccurrence = vi.fn(() => task({ recurrence, recurrenceDate: "2026-10-02" }));
    const undoTaskOccurrence = vi.fn(() => task({ recurrence, recurrenceDate: "2026-10-01" }));
    const request = buildApp({ completeTaskOccurrence, undoTaskOccurrence });

    const completed = await request(`/api/tasks/${TASK_ID}/complete-occurrence`, json("POST", {
      scheduledOn: "2026-10-01",
      completedOn: "2026-10-01",
    }));
    expect(completed.status).toBe(200);
    expect(completeTaskOccurrence).toHaveBeenCalledWith(TASK_ID, "2026-10-01", "2026-10-01");

    const undone = await request(`/api/tasks/${TASK_ID}/undo-occurrence`, json("POST", {
      expectedRecurrenceDate: "2026-10-02",
      recurrenceDateBefore: "2026-10-01",
      showUpDateBefore: null,
    }));
    expect(undone.status).toBe(200);
    expect(undoTaskOccurrence).toHaveBeenCalledWith(
      TASK_ID, "2026-10-02", "2026-10-01", null,
    );
  });

  it.each(["complete-occurrence", "undo-occurrence"])(
    "maps invalid synchronized recurrence from %s to Conflict",
    async (path) => {
      const method = path === "complete-occurrence" ? "completeTaskOccurrence" : "undoTaskOccurrence";
      const body = path === "complete-occurrence"
        ? { scheduledOn: "2026-10-01", completedOn: "2026-10-01" }
        : { expectedRecurrenceDate: "2026-10-02", recurrenceDateBefore: "2026-10-01", showUpDateBefore: null };
      const response = await buildApp({ [method]: () => "invalid-recurrence" })(
        `/api/tasks/${TASK_ID}/${path}`,
        json("POST", body),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "invalid stored recurrence" });
    },
  );
});
