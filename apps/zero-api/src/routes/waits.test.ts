import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import type { ProjectAfter, WaitingCondition } from "../TaskDO/domain";
import type { Env } from "../types";
import { taskDoEnv } from "./taskdo-test-stub";
import { createWaitsRoutes } from "./waits";

const CONDITION_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";

const manual: WaitingCondition = {
  id: CONDITION_ID,
  projectId: SOURCE_ID,
  kind: "free-text",
  text: "the letter arrives",
  refId: null,
  targetStatus: null,
  resolvedAt: null,
  createdAt: "2026-09-26T10:00:00.000Z",
};

const after: ProjectAfter = {
  id: CONDITION_ID,
  projectId: SOURCE_ID,
  kind: "project-status",
  text: null,
  refId: TARGET_ID,
  targetStatus: "done",
  resolvedAt: null,
  createdAt: "2026-09-26T10:00:00.000Z",
};

function buildApp(methods: object) {
  const env = taskDoEnv(methods);
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (context, next) => {
    context.set("userId", "user-abc");
    await next();
  });
  app.route("/", createWaitsRoutes());
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init), env);
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("waiting-condition routes", () => {
  it("returns the TaskDO list contract", async () => {
    const listWaitingConditions = vi.fn(() => [manual]);
    const response = await buildApp({ listWaitingConditions })("/api/waits");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conditions: [manual] });
  });

  it("trims and delegates a manual Waiting condition", async () => {
    const addWaitingCondition = vi.fn(() => manual);
    const response = await buildApp({ addWaitingCondition })("/api/waits", json({
      id: CONDITION_ID,
      projectId: SOURCE_ID,
      kind: "free-text",
      text: " the letter arrives ",
      refId: null,
      targetStatus: null,
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ condition: manual });
    expect(addWaitingCondition).toHaveBeenCalledWith(CONDITION_ID, SOURCE_ID, "the letter arrives");
  });

  it("maps a rejected manual condition to Conflict", async () => {
    const response = await buildApp({ addWaitingCondition: () => null })("/api/waits", json({
      id: CONDITION_ID,
      projectId: SOURCE_ID,
      kind: "free-text",
      text: "wait",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "project not found or condition id is in use" });
  });

  it("delegates a Project After relationship", async () => {
    const addProjectAfter = vi.fn(() => ({ relationship: after }));
    const response = await buildApp({ addProjectAfter })("/api/waits", json({
      id: CONDITION_ID,
      projectId: SOURCE_ID,
      kind: "project-status",
      text: null,
      refId: TARGET_ID,
      targetStatus: "done",
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ condition: after });
    expect(addProjectAfter).toHaveBeenCalledWith(CONDITION_ID, SOURCE_ID, TARGET_ID);
  });

  it.each([
    ["id-conflict", "A different relationship already uses this id."],
    ["missing-source", "This project no longer exists."],
    ["missing-target", "That project no longer exists."],
    ["target-done", "That project is already done."],
    ["self", "A project cannot be after itself."],
    ["duplicate", "This After relationship already exists."],
    ["cycle", "This After relationship would create a loop."],
  ] as const)("maps %s to its public Conflict message", async (conflict, message) => {
    const response = await buildApp({ addProjectAfter: () => ({ conflict }) })(
      "/api/waits",
      json({
        id: CONDITION_ID,
        projectId: SOURCE_ID,
        kind: "project-status",
        refId: TARGET_ID,
        targetStatus: "done",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: message });
  });

  it.each([
    { id: CONDITION_ID, projectId: SOURCE_ID, kind: "free-text", text: " " },
    { id: CONDITION_ID, projectId: SOURCE_ID, kind: "free-text", text: "wait", refId: TARGET_ID },
    { id: CONDITION_ID, projectId: SOURCE_ID, kind: "task-done", refId: TARGET_ID },
    { id: CONDITION_ID, projectId: SOURCE_ID, kind: "project-status", refId: TARGET_ID, targetStatus: "active" },
    { id: CONDITION_ID, projectId: SOURCE_ID, kind: "project-status", refId: "not-a-uuid", targetStatus: "done" },
  ])("rejects malformed condition input %# without calling TaskDO", async (body) => {
    const response = await buildApp({})("/api/waits", json(body));
    expect(response.status).toBe(400);
  });

  it("delegates resolution and returns the resolved schema", async () => {
    const resolved = { ...manual, resolvedAt: "2026-09-26T11:00:00.000Z" };
    const resolveWaitingCondition = vi.fn(() => resolved);
    const response = await buildApp({ resolveWaitingCondition })(
      `/api/waits/${CONDITION_ID}/resolve`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ condition: resolved });
    expect(resolveWaitingCondition).toHaveBeenCalledWith(CONDITION_ID);
  });

  it("maps a missing condition during resolution to Not Found", async () => {
    const response = await buildApp({ resolveWaitingCondition: () => null })(
      `/api/waits/${CONDITION_ID}/resolve`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  it("delegates deletion and preserves its idempotent 204 contract", async () => {
    const deleteWaitingCondition = vi.fn(async () => undefined);
    const response = await buildApp({ deleteWaitingCondition })(`/api/waits/${CONDITION_ID}`, { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(deleteWaitingCondition).toHaveBeenCalledWith(CONDITION_ID);
  });
});
