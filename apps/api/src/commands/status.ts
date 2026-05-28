// Handles the /status bot command: shows model and context usage
// for the current session.

import { createAgentClient } from "../agent-client";
import { log, logError } from "../log";
import type { TopicContext } from "../process-topic-message";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";
import type { SendReplyFn } from "./new";

const tgKey = (telegramId: string) => `tg:${telegramId}`;


export const processStatusCommand = async (
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
  const result = await agent.getSessionStatus(sessionId);

  if (result.kind === "ok") {
    const pct = result.contextPercent !== null ? String(Math.round(result.contextPercent)) : "—";
    const lines = [
      `🤖 ${result.model}`,
      `📊 ${pct}% context`,
    ];
    await sendReply(ctx.chatId, ctx.topicId, lines.join("\n"));
    log("status_command_completed", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
    });
  } else if (result.kind === "unknown") {
    await sendReply(ctx.chatId, ctx.topicId, "No active session");
  } else {
    logError("status_command_failed", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
      result_kind: result.kind,
    });
    await sendReply(ctx.chatId, ctx.topicId, "Status unavailable");
  }
};
