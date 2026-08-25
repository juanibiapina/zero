// Clerk-authed routes for the todo capture list. Todos live in the caller's
// UserDO (one instance per Clerk user), reached the same way as user settings.
// This is the parallel todo app's API; it does not touch the agent.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";

import { log } from "../log";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

type Variables = {
  userId: string;
};

const TodoSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
});

export const createTodosRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  const listRoute = createRoute({
    method: "get",
    path: "/api/todos",
    tags: ["Todos"],
    summary: "List the caller's todos",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ todos: z.array(TodoSchema) }),
          },
        },
        description: "The open todo list, oldest first",
      },
    },
  });

  router.openapi(listRoute, async (c) => {
    const userId = c.get("userId");
    const userDO = getUserDO(c.env, userId);
    const todos = await userDO.listTodos();
    return c.json({ todos }, 200);
  });

  const addRoute = createRoute({
    method: "post",
    path: "/api/todos",
    tags: ["Todos"],
    summary: "Add a todo to the capture list",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ text: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      201: {
        content: {
          "application/json": { schema: z.object({ todo: TodoSchema }) },
        },
        description: "The created todo",
      },
      400: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Empty or missing text",
      },
    },
  });

  router.openapi(addRoute, async (c) => {
    const userId = c.get("userId");
    const { text } = c.req.valid("json");
    const userDO = getUserDO(c.env, userId);
    const todo = await userDO.addTodo(text);
    log("todo_added", { clerk_user_id: userId });
    return c.json({ todo }, 201);
  });

  return router;
};
