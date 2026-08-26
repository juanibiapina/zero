import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { Env } from "../types";
import type { Todo } from "../store/todos";
import { createTodosRoutes } from "./todos";

// A stand-in UserDO exposing just the todo RPC surface, backed by an array.
const fakeUserDO = (seed: Todo[] = []) => {
  const todos = [...seed];
  let n = seed.length;
  return {
    addTodo(text: string): Todo {
      const todo: Todo = {
        id: `id-${++n}`,
        text,
        createdAt: new Date(1700000000000 + n).toISOString(),
        doneAt: null,
      };
      todos.push(todo);
      return todo;
    },
    listTodos(): Todo[] {
      return todos.filter((t) => t.doneAt === null);
    },
    markTodoDone(id: string): Todo | null {
      const todo = todos.find((t) => t.id === id);
      if (!todo) return null;
      todo.doneAt = new Date(1700000000000).toISOString();
      return todo;
    },
    _todos: todos,
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
  app.route("/", createTodosRoutes());
  return {
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://localhost${path}`, init), env),
  };
};

describe("GET /api/todos", () => {
  it("returns the user's todos", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        doneAt: null,
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/todos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      todos: [
        {
          id: "id-1",
          text: "buy milk",
          createdAt: "2023-11-14T22:13:20.001Z",
          doneAt: null,
        },
      ],
    });
  });

  it("returns an empty list when there are none", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");
    const res = await app.request("/api/todos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ todos: [] });
  });
});

describe("POST /api/todos", () => {
  it("adds a todo and returns it", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "call mom" }),
    });

    expect(res.status).toBe(201);
    const body: { todo: Todo } = await res.json();
    expect(body.todo.text).toBe("call mom");
    expect(body.todo.id).toBeTruthy();
    expect(userDO._todos.map((t) => t.text)).toEqual(["call mom"]);
  });

  it("rejects an empty text with 400", async () => {
    const userDO = fakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });

    expect(res.status).toBe(400);
    expect(userDO._todos).toEqual([]);
  });
});

describe("POST /api/todos/{id}/done", () => {
  it("marks a todo done and returns it", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        doneAt: null,
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/todos/id-1/done", { method: "POST" });

    expect(res.status).toBe(200);
    const body: { todo: Todo } = await res.json();
    expect(body.todo.id).toBe("id-1");
    expect(body.todo.doneAt).toBeTruthy();
  });

  it("removes the done todo from a following list", async () => {
    const userDO = fakeUserDO([
      {
        id: "id-1",
        text: "buy milk",
        createdAt: "2023-11-14T22:13:20.001Z",
        doneAt: null,
      },
    ]);
    const app = buildApp(fakeEnv(userDO), "user_abc");

    await app.request("/api/todos/id-1/done", { method: "POST" });
    const res = await app.request("/api/todos");

    expect(await res.json()).toEqual({ todos: [] });
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildApp(fakeEnv(fakeUserDO()), "user_abc");

    const res = await app.request("/api/todos/nope/done", { method: "POST" });

    expect(res.status).toBe(404);
  });
});
