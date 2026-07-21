import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "../types";

// Send a one-shot Telegram "typing" chat action. The action auto-expires
// after ~5s; sustained typing is driven by the UserDO alarm re-calling this.
export const sendChatAction = async (
  env: Env,
  chatId: number,
  topicId: number,
): Promise<void> => {
  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
  await bot.api.sendChatAction(chatId, "typing", {
    ...(topicId && { message_thread_id: topicId }),
  });
};
