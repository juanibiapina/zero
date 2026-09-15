import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { Env } from "../types";
import type { AddProjectDependencyResult } from "../store/project-dependencies";
import type { WaitingCondition } from "../store/waiting-conditions";
import { createWaitsRoutes } from "./waits";

const DEPENDENCY_ID = "11111111-1111-4111-8111-111111111111";
const DEPENDENT_ID = "22222222-2222-4222-8222-222222222222";
const PREREQUISITE_ID = "33333333-3333-4333-8333-333333333333";

const dependency: WaitingCondition = {
  id: DEPENDENCY_ID,
  projectId: DEPENDENT_ID,
  kind: "project-status",
  text: null,
  refId: PREREQUISITE_ID,
  targetStatus: "done",
  resolvedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function fakeUserDO(
  dependencyResult: AddProjectDependencyResult = { condition: dependency },
) {
  const calls: string[] = [];
  return {
    listWaitingConditions: () => [],
    addWaitingCondition: () => {
      calls.push("generic");
      return dependency;
    },
    addProjectDependency: () => {
      calls.push("dependency");
      return dependencyResult;
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
  it("routes a project-completion shape through validated dependency creation", async () => {
    const userDO = fakeUserDO();
    const request = buildApp(userDO);

    const response = await request(
      "/api/waits",
      post({
        id: DEPENDENCY_ID,
        projectId: DEPENDENT_ID,
        kind: "project-status",
        text: null,
        refId: PREREQUISITE_ID,
        targetStatus: "done",
      }),
    );

    expect(response.status).toBe(201);
    expect(userDO.calls).toEqual(["dependency"]);
    expect(await response.json()).toEqual({ condition: dependency });
  });

  it("returns Conflict when the dependency would create a cycle", async () => {
    const userDO = fakeUserDO({ conflict: "cycle" });
    const response = await buildApp(userDO)(
      "/api/waits",
      post({
        id: DEPENDENCY_ID,
        projectId: DEPENDENT_ID,
        kind: "project-status",
        refId: PREREQUISITE_ID,
        targetStatus: "done",
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This dependency would create a loop.",
    });
  });

  it("rejects a malformed completion dependency", async () => {
    const userDO = fakeUserDO();
    const response = await buildApp(userDO)(
      "/api/waits",
      post({
        id: DEPENDENCY_ID,
        projectId: DEPENDENT_ID,
        kind: "project-status",
        targetStatus: "done",
      }),
    );

    expect(response.status).toBe(400);
    expect(userDO.calls).toEqual([]);
  });

  it("keeps ordinary waiting conditions on the generic path", async () => {
    const userDO = fakeUserDO();
    const response = await buildApp(userDO)(
      "/api/waits",
      post({
        id: DEPENDENCY_ID,
        projectId: DEPENDENT_ID,
        kind: "free-text",
        text: "the letter arrives",
      }),
    );

    expect(response.status).toBe(201);
    expect(userDO.calls).toEqual(["generic"]);
  });
});
