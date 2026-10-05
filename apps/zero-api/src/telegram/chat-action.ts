import { createBot } from "./bot";
import type { Env } from "../types";

// Send a one-shot Telegram "typing" chat action. The action auto-expires
// after ~5s; sustained typing is driven by the UserDO alarm re-calling this.
export const sendChatAction = async (
  env: Env,
  chatId: number,
  topicId: number,
): Promise<void> => {
  const bot = createBot(env);
  await bot.api.sendChatAction(chatId, "typing", {
    ...(topicId && { message_thread_id: topicId }),
  });
};
