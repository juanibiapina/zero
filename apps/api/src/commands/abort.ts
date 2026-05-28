// Handles the /abort bot command: stops a running prompt in the
// container's session for the current topic.

import { createAgentClient } from "../agent-client";
import { log, logError } from "../log";
import type { TopicContext } from "../process-topic-message";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";
import type { SendReplyFn } from "./new";

const tgKey = (telegramId: string) => `tg:${telegramId}`;


export const processAbortCommand = async (
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
  const sessionId = await userDO.lookupSessionByTopic(ctx.chatId, ctx.topicId);
  if (!sessionId) {
    await sendReply(ctx.chatId, ctx.topicId, "No active session");
    return;
  }

  const agent = createAgentClient(env, clerkUserId);
  const result = await agent.abortSession(sessionId);

  if (result.kind === "aborted") {
    await sendReply(ctx.chatId, ctx.topicId, "Aborted");
    log("abort_command_completed", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
    });
  } else if (result.kind === "nothing_running") {
    await sendReply(ctx.chatId, ctx.topicId, "Nothing running");
  } else {
    logError("abort_command_failed", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
      result_kind: result.kind,
    });
    await sendReply(ctx.chatId, ctx.topicId, "Abort failed");
  }
};
