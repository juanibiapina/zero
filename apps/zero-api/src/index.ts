import { createApp } from "./app";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return createApp().fetch(req, env, ctx);
  },
};

// One instance per signed-in account, keyed by the Clerk user id: the user's
// account settings.
export { UserDO } from "./UserDO/index";
// One instance per signed-in account; the sole todo authority shared by REST
// writers and synchronized local replicas.
export { TaskDO } from "./TaskDO/index";
