// Worker entry point for zero-api. Changes under apps/agent-api/ are in this
// Worker's Workers Builds watch paths and trigger a redeploy; unrelated
// packages (CLI, docs, landing, dashboard UI) no longer do.
import { createApp } from "./app";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return createApp().fetch(req, env, ctx);
  },
};

export { UserDO } from "./UserDO/index";
