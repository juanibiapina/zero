import {
  createSession,
  sendMessage,
  type AgentStub,
} from "./agent-client";
import { fmtErr, log, logError } from "./log";
import {
  forgetSession,
  lookupSessionId,
  recordSession,
  type SessionRecord,
} from "./sessions";
import type { Env } from "./types";

export interface TopicMessage {
  telegramId: string;
  chatId: number;
  messageThreadId: number;
  text: string;
}

const tgKey = (telegramId: string) => `tg:${telegramId}`;

export const processTopicMessage = async (
  topic: TopicMessage,
  env: Env,
  sendTyping: (chatId: number, threadId: number) => Promise<void>,
): Promise<void> => {
  const clerkUserId = await env.KV.get(tgKey(topic.telegramId));
  if (!clerkUserId) {
    log("drop_unknown_telegram_id", { telegram_id: topic.telegramId });
    return;
  }

  sendTyping(topic.chatId, topic.messageThreadId).catch((err) => {
    logError("send_typing_failed", { error: fmtErr(err) });
  });

  const stub = env.AGENT_CONTAINER.getByName(clerkUserId);

  let sessionId = await ensureSession(stub, env, clerkUserId, topic);
  if (sessionId === null) return;

  let result = await sendMessage(stub, sessionId, topic.text);
  if (result.kind === "stale") {
    log("stale_session", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
    });
    await forgetSession(env, sessionId);
    sessionId = await ensureSession(stub, env, clerkUserId, topic);
    if (sessionId === null) return;
    result = await sendMessage(stub, sessionId, topic.text);
  }
  if (result.kind === "error") {
    logError("container_rejected_message", {
      clerk_user_id: clerkUserId,
      session_id: sessionId,
      status: result.status,
    });
    return;
  }
  log("forwarded_message", {
    clerk_user_id: clerkUserId,
    session_id: sessionId,
  });
};

const ensureSession = async (
  stub: AgentStub,
  env: Env,
  clerkUserId: string,
  topic: TopicMessage,
): Promise<string | null> => {
  const record: SessionRecord = {
    clerkUserId,
    chatId: topic.chatId,
    messageThreadId: topic.messageThreadId,
  };
  const existing = await lookupSessionId(env, record);
  if (existing) {
    return existing;
  }

  const result = await createSession(stub);
  if (result.kind === "error") {
    logError("create_session_failed", {
      clerk_user_id: clerkUserId,
      status: result.status,
    });
    return null;
  }

  await recordSession(env, result.sessionId, record);
  log("created_session", {
    session_id: result.sessionId,
    clerk_user_id: clerkUserId,
    chat_id: topic.chatId,
    thread_id: topic.messageThreadId,
  });
  return result.sessionId;
};
