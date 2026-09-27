import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "../TaskDO/domain";
import type { Env } from "../types";
import { taskDoEnv } from "./taskdo-test-stub";
import { createProjectsRoutes, type SuggestIcons } from "./projects";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const project = (over: Partial<Project> = {}): Project => ({
  id: PROJECT_ID,
  title: "Run a 5K",
  icon: "🏃",
  description: null,
  state: "in-play",
  createdAt: "2026-09-26T10:00:00.000Z",
  ...over,
});

function buildApp(methods: object, suggestIcons?: SuggestIcons) {
  const env = taskDoEnv(methods);
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (context, next) => {
    context.set("userId", "user-abc");
    await next();
  });
  app.route("/", createProjectsRoutes({ suggestIcons }));
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init), env);
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("project routes", () => {
  it("returns the TaskDO project list contract", async () => {
    const projects = [project()];
    const listProjects = vi.fn(() => projects);
    const response = await buildApp({ listProjects })("/api/projects");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects });
    expect(listProjects).toHaveBeenCalledOnce();
  });

  it("delegates creation with defaults and optional fields intact", async () => {
    const created = project({ description: "race", state: "backlog" });
    const addProject = vi.fn(() => created);
    const response = await buildApp({ addProject })("/api/projects", json("POST", {
      id: PROJECT_ID,
      title: "Run a 5K",
      icon: "🏃",
      description: "race",
      state: "backlog",
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project: created });
    expect(addProject).toHaveBeenCalledWith(PROJECT_ID, "Run a 5K", {
      icon: "🏃",
      description: "race",
      state: "backlog",
    });
  });

  it("maps an occupied or deleted Project id to Conflict", async () => {
    const response = await buildApp({ addProject: () => null })("/api/projects", json("POST", {
      id: PROJECT_ID,
      title: "Run a 5K",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "project id is in use or was deleted" });
  });

  it.each([
    { id: PROJECT_ID, title: "" },
    { id: "not-a-uuid", title: "Project" },
    { id: PROJECT_ID, title: "Project", state: "someday" },
    { id: PROJECT_ID, title: "Project", status: "next" },
  ])("rejects malformed create input %# without calling TaskDO", async (body) => {
    const response = await buildApp({})("/api/projects", json("POST", body));
    expect(response.status).toBe(400);
  });

  it("delegates edits before state changes and returns the final Project", async () => {
    const edited = project({
      title: "Under 30", icon: "⏱️", description: "plan",
    });
    const final = project({ ...edited, state: "backlog" });
    const editProject = vi.fn(() => edited);
    const setProjectState = vi.fn(() => final);
    const response = await buildApp({ editProject, setProjectState })(
      `/api/projects/${PROJECT_ID}`,
      json("PATCH", { title: "Under 30", icon: "⏱️", description: "plan", state: "backlog" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: final });
    expect(editProject).toHaveBeenCalledWith(PROJECT_ID, {
      title: "Under 30",
      icon: "⏱️",
      description: "plan",
    });
    expect(setProjectState).toHaveBeenCalledWith(PROJECT_ID, "backlog");
    expect(editProject.mock.invocationCallOrder[0]).toBeLessThan(setProjectState.mock.invocationCallOrder[0]);
  });

  it("preserves a null description clear", async () => {
    const editProject = vi.fn(() => project());
    const response = await buildApp({ editProject })(
      `/api/projects/${PROJECT_ID}`,
      json("PATCH", { description: null }),
    );
    expect(response.status).toBe(200);
    expect(editProject).toHaveBeenCalledWith(PROJECT_ID, { description: null });
  });

  it("maps missing Projects from either patch delegation to Not Found", async () => {
    const missingEdit = await buildApp({ editProject: () => null })(
      `/api/projects/${PROJECT_ID}`,
      json("PATCH", { title: "Edited" }),
    );
    expect(missingEdit.status).toBe(404);

    const missingState = await buildApp({ setProjectState: () => null })(
      `/api/projects/${PROJECT_ID}`,
      json("PATCH", { state: "done" }),
    );
    expect(missingState.status).toBe(404);
  });

  it.each([
    {},
    { title: "" },
    { icon: "" },
    { state: "someday" },
    { status: "next" },
  ])("rejects malformed patch input %# without calling TaskDO", async (body) => {
    const response = await buildApp({})(`/api/projects/${PROJECT_ID}`, json("PATCH", body));
    expect(response.status).toBe(400);
  });

  it("delegates deletion and keeps its idempotent 204 contract", async () => {
    const deleteProject = vi.fn(() => ({ tasks: 2, conditions: 1, afters: 3 }));
    const response = await buildApp({ deleteProject })(`/api/projects/${PROJECT_ID}`, { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(deleteProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("passes icon suggestion context through its separate model seam", async () => {
    const suggestIcons = vi.fn(async () => ["🏃", "🎯"]);
    const response = await buildApp({}, suggestIcons)("/api/projects/icon-suggestions", json("POST", {
      title: "Run a 5K",
      description: "race",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ icons: ["🏃", "🎯"] });
    expect(suggestIcons).toHaveBeenCalledWith(expect.anything(), "user-abc", {
      title: "Run a 5K",
      description: "race",
    });
  });

  it("rejects an empty icon-suggestion title before calling the model", async () => {
    const response = await buildApp({}, async () => ["🏃"])(
      "/api/projects/icon-suggestions",
      json("POST", { title: "" }),
    );
    expect(response.status).toBe(400);
  });
});
