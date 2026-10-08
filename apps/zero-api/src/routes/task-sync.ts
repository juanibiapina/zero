import { OpenAPIHono } from "@hono/zod-openapi";

import { TASK_SYNC_SCHEMA } from "@zero/agent-core";

import { getTaskDO } from "../TaskDO/stub";
import type { Env } from "../types";

export const createTaskSyncRoutes = () => {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  router.get("/api/task-recoveries", async (c) => {
    const userId = c.get("userId");
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
    const taskDO = getTaskDO(c.env, userId);
    if (await taskDO.isErased()) return c.text("Account erased", 410);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.text("Upgrade required", 426);
    }
    if (c.req.query("schema") !== String(TASK_SYNC_SCHEMA)) {
      return c.text("Update the app to sync", 426);
    }
    const url = new URL(c.req.url);
    url.pathname = "/sync";
    url.search = "";
    return taskDO.fetch(new Request(url, c.req.raw));
  });
  return router;
};
