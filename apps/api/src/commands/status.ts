// Handles the /status bot command: shows model and context usage
// for the current session.

import { createAgentClient } from "../agent-client";
import { log, logError } from "../log";
import { lookupSessionId, type SessionRecord } from "../sessions";
import type { TopicContext } from "../process-topic-message";
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

  const agent = createAgentClient(env, clerkUserId);
  const result = await agent.getSessionStatus(sessionId);

  if (result.kind === "ok") {
    const pct = result.contextPercent !== null ? String(Math.round(result.contextPercent)) : "—";
    const lines = [
      `🤖 ${result.model}`,
      `📊 ${pct}% context`,
    ];
    await sendReply(ctx.chatId, ctx.messageThreadId, lines.join("\n"));
    log("status_command_completed", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
    });
  } else if (result.kind === "unknown") {
    await sendReply(ctx.chatId, ctx.messageThreadId, "No active session");
  } else {
    logError("status_command_failed", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
      result_kind: result.kind,
    });
    await sendReply(ctx.chatId, ctx.messageThreadId, "Status unavailable");
  }
};
