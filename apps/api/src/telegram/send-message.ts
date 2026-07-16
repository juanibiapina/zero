// Reply helper usable from inside the DO. Builds a grammY Bot from env (like
// chat-action.ts) and sends through the transport-agnostic formatAndSend, which
// handles markdown conversion, chunking, and the plain-text fallback.

import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { formatAndSend } from "./send";
import type { Env } from "../types";

export const sendMessage = async (
  env: Env,
  chatId: number,
  topicId: number,
  text: string,
): Promise<void> => {
  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
    botInfo,
    client: { apiRoot: env.TELEGRAM_API_ROOT },
  });
  await formatAndSend(text, (formatted, parseMode) =>
    bot.api.sendMessage(chatId, formatted, {
      ...(topicId && { message_thread_id: topicId }),
      ...(parseMode && { parse_mode: parseMode }),
    }),
  );
};
