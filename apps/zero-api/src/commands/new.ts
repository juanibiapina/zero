// Handles the /new bot command: resets the conversation thread for this
// (chatId, topicId) so the next message starts a fresh exchange. Topics (the
// durable knowledge model) are left intact.

import { log } from "../log";
import type { TopicContext } from "../telegram/context";
import { resolveClerkUserId } from "../telegram/identity";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";

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
  const clerkUserId = await resolveClerkUserId(env, ctx.telegramId);
  if (!clerkUserId) return;

  const userDO = getUserDO(env, clerkUserId);
  await userDO.resetConversation(ctx.chatId, ctx.topicId);

  await sendReply(ctx.chatId, ctx.topicId, "Started a new conversation.");
  log("new_command_completed", { clerk_user_id: clerkUserId });
};
