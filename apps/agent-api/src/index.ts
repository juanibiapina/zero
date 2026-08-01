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
// One instance of each per user, all three keyed by the Clerk user id. ScheduleDO
// owns deadlines, LearningDO owns durable learning execution, UserDO owns user
// data and interactive turns (see docs/topics.md).
export { ScheduleDO } from "./ScheduleDO/index";
export { LearningDO } from "./LearningDO/index";
// One instance per Telegram account, keyed by the Telegram user id: the
// authoritative record of which Zero user that account belongs to.
export { TelegramAccountDO } from "./TelegramAccountDO/index";
