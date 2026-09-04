import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { Env } from "../types";
import type { Project, ProjectDefaults } from "../store/projects";
import { createProjectsRoutes } from "./projects";

// A well-formed UUID the client mints; the route body requires uuid shape.
const UUID_1 = "11111111-1111-4111-8111-111111111111";

// A stand-in UserDO exposing just the project RPC surface, backed by an array.
const fakeUserDO = (seed: Project[] = []) => {
  const projects = [...seed];
  let n = seed.length;
  return {
    addProject(id: string, title: string, opts: ProjectDefaults = {}): Project {
      const existingById = projects.find((p) => p.id === id);
      if (existingById) return existingById;
      const project: Project = {
        id,
        title,
        icon: opts.icon ?? "📁",
        description: opts.description ?? null,
        status: opts.status ?? "next",
        createdAt: new Date(1700000000000 + ++n).toISOString(),
      };
      projects.push(project);
      return project;
    },
    listProjects(): Project[] {
      return projects;
    },
    _projects: projects,
  };
};

const fakeEnv = (userDO: ReturnType<typeof fakeUserDO>) =>
  ({
    USER_DO: {
      idFromName: (_name: string) => ({ toString: () => "fake-id" }),
      get: () => userDO,
    },
  }) as unknown as Env;

const buildApp = (env: Env, userId: string) => {
  const app = new OpenAPIHono<{
    Bindings: Env;
    Variables: { userId: string };
  }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createProjectsRoutes());
  return {
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://localhost${path}`, init), env),
  };
};

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("GET /api/projects", () => {
  it("returns the user's projects", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        title: "Run a 5K",
        icon: "🏃",
        description: null,
        status: "next",
        createdAt: "2023-11-14T22:13:20.001Z",
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/projects");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projects: [
        {
          id: "id-1",
          title: "Run a 5K",
          icon: "🏃",
          description: null,
          status: "next",
          createdAt: "2023-11-14T22:13:20.001Z",
        },
      ],
    });
  });

  it("returns an empty list when there are none", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [] });
  });
});

describe("POST /api/projects", () => {
  it("creates a project from id + title with defaults", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request(
      "/api/projects",
      post({ id: UUID_1, title: "Have a baby" }),
    );

    expect(res.status).toBe(201);
    const body: { project: Project } = await res.json();
    expect(body.project.id).toBe(UUID_1);
    expect(body.project.title).toBe("Have a baby");
    expect(body.project.icon).toBe("📁");
    expect(body.project.description).toBeNull();
    expect(body.project.status).toBe("next");
  });

  it("rejects an empty title", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request(
      "/api/projects",
      post({ id: UUID_1, title: "" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-UUID id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request(
      "/api/projects",
      post({ id: "not-a-uuid", title: "Run a 5K" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown status", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request(
      "/api/projects",
      post({ id: UUID_1, title: "Run a 5K", status: "someday" }),
    );
    expect(res.status).toBe(400);
  });
});
