// Worker entry point for zero-api. Changes under apps/zero-api/ are in this
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
// One instance of each per user, all three keyed by the Clerk user id. ScheduleDO
// owns deadlines, AssistantDO runs every agent on Pi Durable, UserDO owns user
// data (see docs/harness.md).
export { ScheduleDO } from "./ScheduleDO/index";
export { AssistantDO } from "./AssistantDO/index";
// One instance per Telegram account, keyed by the Telegram user id: the
// authoritative record of which Zero user that account belongs to.
export { TelegramAccountDO } from "./TelegramAccountDO/index";
// One instance per signed-in account; the sole todo authority shared by REST
// writers and synchronized local replicas.
export { TaskDO } from "./TaskDO/index";
