// Handles the /new bot command: forgets the current session for a topic
// so the next regular message starts a fresh conversation.
//
// The new session is NOT created eagerly — `ensureSession` in
// `process-topic-message.ts` handles that on the next message.

import { forgetSession, lookupSessionId, type SessionRecord } from "../sessions";
import { log } from "../log";
import type { TopicContext } from "../process-topic-message";
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

  const record: SessionRecord = {
    clerkUserId,
    chatId: ctx.chatId,
    messageThreadId: ctx.messageThreadId,
  };
  const sessionId = await lookupSessionId(env, record);
  if (sessionId) {
    await forgetSession(env, sessionId);
    log("new_command_forgot_session", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
    });
  }

  await sendReply(
    ctx.chatId,
    ctx.messageThreadId,
    "New session started",
  );
  log("new_command_completed", { clerk_user_id: clerkUserId });
};
