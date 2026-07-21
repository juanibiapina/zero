// Handles the /new bot command: resets the conversation thread for this
// (chatId, topicId) so the next message starts a fresh exchange. Topics (the
// durable knowledge model) are left intact.

import { log } from "../log";
import type { TopicContext } from "../telegram/context";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";

const tgKey = (telegramId: string) => `tg:${telegramId}`;

export type SendReplyFn = (
  chatId: number,
  threadId: number,
  text: string,
) => Promise<void>;

export const processNewCommand = async (
  ctx: TopicContext,
  env: Env,
  sendReply: SendReplyFn,
): Promise<void> => {
  const clerkUserId = await env.KV.get(tgKey(ctx.telegramId));
  if (!clerkUserId) {
    log("drop_unknown_telegram_id", { telegram_id: ctx.telegramId });
    return;
  }

  const userDO = getUserDO(env, clerkUserId);
  await userDO.resetConversation(ctx.chatId, ctx.topicId);

  await sendReply(ctx.chatId, ctx.topicId, "Started a new conversation.");
  log("new_command_completed", { clerk_user_id: clerkUserId });
};
