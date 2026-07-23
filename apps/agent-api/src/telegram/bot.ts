// One place that knows "how to become the bot". Every grammY Bot in this worker
// is built the same way: parse the cached getMe from env, then construct with
// the configured API root. Centralizing it removes the copy-paste drift that
// left chat-action.ts without client.apiRoot.

import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "../types";

export const createBot = (env: Env): Bot => {
  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  return new Bot(env.TELEGRAM_BOT_TOKEN, {
    botInfo,
    client: { apiRoot: env.TELEGRAM_API_ROOT },
  });
};
