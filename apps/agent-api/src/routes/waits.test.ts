import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { Env } from "../types";
import type { AddProjectAfterResult } from "../store/project-afters";
import type { ProjectAfter } from "../store/waiting-conditions";
import { createWaitsRoutes } from "./waits";

const RELATIONSHIP_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";

const relationship: ProjectAfter = {
  id: RELATIONSHIP_ID,
  projectId: SOURCE_ID,
  kind: "project-status",
  text: null,
  refId: TARGET_ID,
  targetStatus: "done",
  resolvedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function fakeUserDO(
  afterResult: AddProjectAfterResult = { relationship },
) {
  const calls: string[] = [];
  return {
    listWaitingConditions: () => [],
    addWaitingCondition: (
      id: string,
      projectId: string,
      text: string,
    ) => {
      calls.push(`waiting:${text}`);
      return {
        id,
        projectId,
        kind: "free-text" as const,
        text,
        refId: null,
        targetStatus: null,
        resolvedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
    addProjectAfter: () => {
      calls.push("after");
      return afterResult;
    },
    resolveWaitingCondition: () => null,
    deleteWaitingCondition: () => false,
    calls,
  };
}

function buildApp(userDO: ReturnType<typeof fakeUserDO>) {
  const env = {
    USER_DO: {
      idFromName: () => ({ toString: () => "fake-id" }),
      get: () => userDO,
    },
  } as unknown as Env;
  const app = new OpenAPIHono<{
    Bindings: Env;
    Variables: { userId: string };
  }>();
  app.use("/api/*", async (context, next) => {
    context.set("userId", "user");
    await next();
  });
  app.route("/", createWaitsRoutes());
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init), env);
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /api/waits", () => {
  it("adds a complete manual Waiting condition", async () => {
    const userDO = fakeUserDO();
    const response = await buildApp(userDO)(
      "/api/waits",
      post({
        id: RELATIONSHIP_ID,
        projectId: SOURCE_ID,
        kind: "free-text",
        text: " the letter arrives ",
        refId: null,
        targetStatus: null,
      }),
    );

    expect(response.status).toBe(201);
    expect(userDO.calls).toEqual(["waiting:the letter arrives"]);
  });

  it("routes Project-completion rows through After validation", async () => {
    const userDO = fakeUserDO();
    const response = await buildApp(userDO)(
      "/api/waits",
      post({
        id: RELATIONSHIP_ID,
        projectId: SOURCE_ID,
        kind: "project-status",
        text: null,
        refId: TARGET_ID,
        targetStatus: "done",
      }),
    );

    expect(response.status).toBe(201);
    expect(userDO.calls).toEqual(["after"]);
    expect(await response.json()).toEqual({ condition: relationship });
  });

  it("returns Conflict when After would create a cycle", async () => {
    const response = await buildApp(fakeUserDO({ conflict: "cycle" }))(
      "/api/waits",
      post({
        id: RELATIONSHIP_ID,
        projectId: SOURCE_ID,
        kind: "project-status",
        refId: TARGET_ID,
        targetStatus: "done",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This After relationship would create a loop.",
    });
  });

  it("rejects Task relationships and arbitrary Project statuses", async () => {
    const request = buildApp(fakeUserDO());
    const task = await request(
      "/api/waits",
      post({
        id: RELATIONSHIP_ID,
        projectId: SOURCE_ID,
        kind: "task-done",
        refId: TARGET_ID,
      }),
    );
    expect(task.status).toBe(400);

    const status = await request(
      "/api/waits",
      post({
        id: RELATIONSHIP_ID,
        projectId: SOURCE_ID,
        kind: "project-status",
        refId: TARGET_ID,
        targetStatus: "active",
      }),
    );
    expect(status.status).toBe(400);
  });
});
