import { OpenAPIHono } from "@hono/zod-openapi";

import { getTaskDO, isTaskDOFixture, usesTaskDO } from "../TaskDO/stub";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";

export const createTaskSyncRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  router.get("/api/todo-authority", async (c) => {
    const userId = c.get("userId");
    if (isTaskDOFixture(c.env, userId)) {
      return c.json({ authority: "switched" as const });
    }
    const { authority } = await getUserDO(c.env, userId).getTodoAuthority();
    return c.json({ authority });
  });
  router.get("/api/task-recoveries", async (c) => {
    const userId = c.get("userId");
    if (!(await usesTaskDO(c.env, userId))) return c.text("Not found", 404);
    const taskDO = getTaskDO(c.env, userId);
    if (await taskDO.isErased()) return c.text("Account erased", 410);
    return c.json({
      tasks: await taskDO.listRecoveries(),
      projects: await taskDO.listProjectRecoveries(),
      conditions: await taskDO.listConditionRecoveries(),
    });
  });
  router.get("/api/task-sync", async (c) => {
    const userId = c.get("userId");
    if (!(await usesTaskDO(c.env, userId))) return c.text("Not found", 404);
    const taskDO = getTaskDO(c.env, userId);
    if (await taskDO.isErased()) return c.text("Account erased", 410);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.text("Upgrade required", 426);
    }
    const url = new URL(c.req.url);
    url.pathname = "/sync";
    return taskDO.fetch(new Request(url, c.req.raw));
  });
  return router;
};
