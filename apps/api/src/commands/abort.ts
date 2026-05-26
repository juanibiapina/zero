// Handles the /abort bot command: stops a running prompt in the
// container's session for the current topic.

import { abortSession } from "../agent-client";
import { log, logError } from "../log";
import { lookupSessionId, type SessionRecord } from "../sessions";
import type { TopicContext } from "../process-topic-message";
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

  const record: SessionRecord = {
    clerkUserId,
    chatId: ctx.chatId,
    messageThreadId: ctx.messageThreadId,
  };
  const sessionId = await lookupSessionId(env, record);
  if (!sessionId) {
    await sendReply(ctx.chatId, ctx.messageThreadId, "No active session");
    return;
  }

  const stub = env.AGENT_CONTAINER.getByName(clerkUserId);
  const result = await abortSession(stub, sessionId);

  if (result.kind === "aborted") {
    await sendReply(ctx.chatId, ctx.messageThreadId, "Aborted");
    log("abort_command_completed", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
    });
  } else if (result.kind === "nothing_running") {
    await sendReply(ctx.chatId, ctx.messageThreadId, "Nothing running");
  } else {
    logError("abort_command_failed", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
      result_kind: result.kind,
    });
    await sendReply(ctx.chatId, ctx.messageThreadId, "Abort failed");
  }
};
