import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { Env } from "../types";
import type {
  Project,
  ProjectDefaults,
  ProjectState,
} from "../store/projects";
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
        state: opts.state ?? "in-play",
        createdAt: new Date(1700000000000 + ++n).toISOString(),
        sourceCaptureId: opts.sourceCaptureId ?? null,
      };
      projects.push(project);
      return project;
    },
    listProjects(): Project[] {
      return projects.filter((p) => p.state !== "done");
    },
    setProjectState(id: string, state: ProjectState): Project | null {
      const project = projects.find((p) => p.id === id);
      if (!project) return null;
      project.state = state;
      return project;
    },
    editProject(
      id: string,
      fields: { title?: string; icon?: string; description?: string | null },
    ): Project | null {
      const project = projects.find((p) => p.id === id);
      if (!project) return null;
      if (fields.title !== undefined) project.title = fields.title;
      if (fields.icon !== undefined) project.icon = fields.icon;
      if (fields.description !== undefined)
        project.description = fields.description;
      return project;
    },
    // Mirrors UserDO.deleteProject's cascade shape. This fake holds only
    // projects (no tasks/conditions), so the cascade counts are always 0; the
    // cross-store cascade is proven in store/project-delete-cascade.test.ts.
    deleteProject(id: string): {
      existed: boolean;
      tasks: number;
      conditions: number;
    } {
      const i = projects.findIndex((p) => p.id === id);
      const existed = i >= 0;
      if (existed) projects.splice(i, 1);
      return { existed, tasks: 0, conditions: 0 };
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

const buildApp = (
  env: Env,
  userId: string,
  deps?: Parameters<typeof createProjectsRoutes>[0],
) => {
  const app = new OpenAPIHono<{
    Bindings: Env;
    Variables: { userId: string };
  }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createProjectsRoutes(deps));
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
        state: "in-play",
        createdAt: "2023-11-14T22:13:20.001Z",
        sourceCaptureId: null,
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
          state: "in-play",
          createdAt: "2023-11-14T22:13:20.001Z",
          sourceCaptureId: null,
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
    expect(body.project.state).toBe("in-play");
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

  it("rejects the retired status field", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request(
      "/api/projects",
      post({ id: UUID_1, title: "Run a 5K", status: "next" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown state", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request(
      "/api/projects",
      post({ id: UUID_1, title: "Run a 5K", state: "someday" }),
    );
    expect(res.status).toBe(400);
  });
});

const patch = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const seedProject = (over: Partial<Project> = {}): Project => ({
  id: "id-1",
  title: "Run a 5K",
  icon: "📁",
  description: null,
  state: "in-play",
  createdAt: "2023-11-14T22:13:20.001Z",
  sourceCaptureId: null,
  ...over,
});

describe("PATCH /api/projects/{id}", () => {
  it("changes a project's state", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/projects/id-1", patch({ state: "backlog" }));

    expect(res.status).toBe(200);
    const body: { project: Project } = await res.json();
    expect(body.project.state).toBe("backlog");
  });

  it("drops a project from the list once its state is done", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    await app.request("/api/projects/id-1", patch({ state: "done" }));
    const res = await app.request("/api/projects");

    expect(await res.json()).toEqual({ projects: [] });
  });

  it("rejects a body with no fields to update", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");
    const res = await app.request("/api/projects/id-1", patch({}));
    expect(res.status).toBe(400);
  });

  it("rejects the retired status field", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");
    const res = await app.request(
      "/api/projects/id-1",
      patch({ status: "next" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown state", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");
    const res = await app.request(
      "/api/projects/id-1",
      patch({ state: "someday" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request("/api/projects/nope", patch({ state: "backlog" }));
    expect(res.status).toBe(404);
  });

  it("edits the title", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request(
      "/api/projects/id-1",
      patch({ title: "Run a 5K under 30 min" }),
    );

    expect(res.status).toBe(200);
    const body: { project: Project } = await res.json();
    expect(body.project.title).toBe("Run a 5K under 30 min");
  });

  it("edits the icon", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/projects/id-1", patch({ icon: "🏃" }));

    expect(res.status).toBe(200);
    const body: { project: Project } = await res.json();
    expect(body.project.icon).toBe("🏃");
  });

  it("clears the description with null", async () => {
    const userDO = fakeUserDO([seedProject({ description: "old" })]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request(
      "/api/projects/id-1",
      patch({ description: null }),
    );

    expect(res.status).toBe(200);
    const body: { project: Project } = await res.json();
    expect(body.project.description).toBeNull();
  });

  it("rejects an empty title", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");
    const res = await app.request("/api/projects/id-1", patch({ title: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty icon", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");
    const res = await app.request("/api/projects/id-1", patch({ icon: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when editing an unknown id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request(
      "/api/projects/nope",
      patch({ title: "x" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/projects/icon-suggestions", () => {
  it("returns single-emoji suggestions for a title", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc", {
      suggestIcons: async () => ["🏃", "🎯"],
    });
    const res = await app.request(
      "/api/projects/icon-suggestions",
      post({ title: "Run a 5K" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ icons: ["🏃", "🎯"] });
  });

  it("passes the user id, title and description to the suggester", async () => {
    let seen: unknown;
    const app = buildApp(fakeEnv(fakeUserDO()), "user_xyz", {
      suggestIcons: async (_env, userId, input) => {
        seen = { userId, input };
        return [];
      },
    });
    await app.request(
      "/api/projects/icon-suggestions",
      post({ title: "Ship it", description: "to the store" }),
    );
    expect(seen).toEqual({
      userId: "user_xyz",
      input: { title: "Ship it", description: "to the store" },
    });
  });

  it("returns 200 with an empty list when the model yields nothing usable", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc", {
      suggestIcons: async () => [],
    });
    const res = await app.request(
      "/api/projects/icon-suggestions",
      post({ title: "Vague" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ icons: [] });
  });

  it("rejects an empty title", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc", {
      suggestIcons: async () => ["🏃"],
    });
    const res = await app.request(
      "/api/projects/icon-suggestions",
      post({ title: "" }),
    );
    expect(res.status).toBe(400);
  });
});

const del = (): RequestInit => ({ method: "DELETE" });

describe("DELETE /api/projects/{id}", () => {
  it("permanently removes the project", async () => {
    const userDO = fakeUserDO([seedProject()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/projects/id-1", del());
    expect(res.status).toBe(204);

    const list = await app.request("/api/projects");
    expect(await list.json()).toEqual({ projects: [] });
  });

  it("returns 204 for an unknown id (idempotent)", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request("/api/projects/nope", del());
    expect(res.status).toBe(204);
  });
});
