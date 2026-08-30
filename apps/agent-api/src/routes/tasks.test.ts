import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { Env } from "../types";
import type { Task } from "../store/tasks";
import { createTasksRoutes } from "./tasks";

// A well-formed UUID the client mints; the route body requires uuid shape.
const UUID_1 = "11111111-1111-4111-8111-111111111111";

// A stand-in UserDO exposing just the task RPC surface, backed by an array.
const fakeUserDO = (seed: Task[] = []) => {
  const tasks = [...seed];
  let n = seed.length;
  return {
    addTask(id: string, text: string, showUpDate: string): Task {
      const existingById = tasks.find((t) => t.id === id);
      if (existingById) return existingById;
      const task: Task = {
        id,
        text,
        showUpDate,
        createdAt: new Date(1700000000000 + ++n).toISOString(),
        completedAt: null,
      };
      tasks.push(task);
      return task;
    },
    listTasks(): Task[] {
      return tasks.filter((t) => t.completedAt === null);
    },
    completeTask(id: string): Task | null {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;
      task.completedAt = new Date(1700000000000).toISOString();
      return task;
    },
    _tasks: tasks,
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
  app.route("/", createTasksRoutes());
  return {
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://localhost${path}`, init), env),
  };
};

const task = (over: Partial<Task> = {}): Task => ({
  id: "id-1",
  text: "buy milk",
  showUpDate: "2023-11-14",
  createdAt: "2023-11-14T22:13:20.001Z",
  completedAt: null,
  ...over,
});

describe("GET /api/tasks", () => {
  it("returns the user's open tasks", async () => {
    const userDO = fakeUserDO([task()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tasks: [task()] });
  });

  it("returns future-dated tasks too (the date filter is client-side)", async () => {
    const userDO = fakeUserDO([task({ id: "id-2", showUpDate: "2999-01-01" })]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks");

    expect(res.status).toBe(200);
    const body: { tasks: Task[] } = await res.json();
    expect(body.tasks.map((t) => t.id)).toEqual(["id-2"]);
  });

  it("returns an empty list when there are none", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tasks: [] });
  });
});

describe("POST /api/tasks", () => {
  it("adds a task and returns it", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: UUID_1, text: "call mom", showUpDate: "2023-11-14" }),
    });

    expect(res.status).toBe(201);
    const body: { task: Task } = await res.json();
    expect(body.task.text).toBe("call mom");
    expect(body.task.id).toBe(UUID_1);
    expect(body.task.showUpDate).toBe("2023-11-14");
    expect(userDO._tasks.map((t) => t.text)).toEqual(["call mom"]);
  });

  it("dedupes a replayed POST that re-sends the same id", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const send = () =>
      app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: UUID_1, text: "call mom", showUpDate: "2023-11-14" }),
      });

    const first: { task: Task } = await (await send()).json();
    const replay: { task: Task } = await (await send()).json();

    expect(replay.task.id).toBe(first.task.id);
    expect(userDO._tasks).toHaveLength(1);
  });

  it("rejects an empty text with 400", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: UUID_1, text: "", showUpDate: "2023-11-14" }),
    });

    expect(res.status).toBe(400);
    expect(userDO._tasks).toEqual([]);
  });

  it("rejects a malformed showUpDate with 400", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: UUID_1, text: "call mom", showUpDate: "14/11/2023" }),
    });

    expect(res.status).toBe(400);
    expect(userDO._tasks).toEqual([]);
  });
});

describe("POST /api/tasks/{id}/complete", () => {
  it("completes a task and returns it", async () => {
    const userDO = fakeUserDO([task()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/tasks/id-1/complete", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body: { task: Task } = await res.json();
    expect(body.task.id).toBe("id-1");
    expect(body.task.completedAt).toBeTruthy();
  });

  it("removes the completed task from a following list", async () => {
    const userDO = fakeUserDO([task()]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    await app.request("/api/tasks/id-1/complete", { method: "POST" });
    const res = await app.request("/api/tasks");

    expect(await res.json()).toEqual({ tasks: [] });
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");

    const res = await app.request("/api/tasks/nope/complete", {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });
});
