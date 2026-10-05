// Reply helper usable from inside the DO. Builds a grammY Bot from env (like
// chat-action.ts) and sends through the transport-agnostic formatAndSend, which
// handles markdown conversion, chunking, and the plain-text fallback.

import { createBot } from "./bot";
import { formatAndSend } from "./send";
import { logError, fmtErr } from "../log";
import type { Env } from "../types";

export const sendMessage = async (
  env: Env,
  chatId: number,
  topicId: number,
  text: string,
): Promise<void> => {
  const bot = createBot(env);
  try {
    await formatAndSend(text, (formatted, parseMode) =>
      bot.api.sendMessage(chatId, formatted, {
        ...(topicId && { message_thread_id: topicId }),
        ...(parseMode && { parse_mode: parseMode }),
      }),
    );
  } catch (err) {
    // Never let a Telegram failure be silent. No message content is logged
    // (log.ts convention); chat/topic ids are metadata already in turn_started.
    logError("telegram_send_failed", {
      chat_id: chatId,
      topic_id: topicId,
      error: fmtErr(err),
    });
    throw err;
  }
};
