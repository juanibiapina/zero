import { createAgentClient, type AgentClient } from "./agent-client";
import { fmtErr, log, logError } from "./log";
import {
  forgetSession,
  lookupSessionId,
  recordSession,
  type SessionRecord,
} from "./sessions";
import type { Env } from "./types";

export interface TopicContext {
  telegramId: string;
  chatId: number;
  messageThreadId: number;
}

export interface TopicMessage extends TopicContext {
  text: string;
}

const tgKey = (telegramId: string) => `tg:${telegramId}`;

export const processTopicMessage = async (
  topic: TopicMessage,
  env: Env,
  sendTyping: (chatId: number, threadId: number) => Promise<void>,
): Promise<void> => {
  try {
    const clerkUserId = await env.KV.get(tgKey(topic.telegramId));
    if (!clerkUserId) {
      log("drop_unknown_telegram_id", { telegram_id: topic.telegramId });
      return;
    }

    sendTyping(topic.chatId, topic.messageThreadId).catch((err) => {
      logError("send_typing_failed", { error: fmtErr(err) });
    });

    const agent = createAgentClient(env, clerkUserId);

    let sessionId = await ensureSession(agent, env, clerkUserId, topic);
    if (sessionId === null) return;

    let result = await agent.sendMessage(sessionId, topic.text);
    if (result.kind === "stale") {
      log("stale_session", {
        session_id: sessionId,
        clerk_user_id: clerkUserId,
      });
      await forgetSession(env, sessionId);
      sessionId = await ensureSession(agent, env, clerkUserId, topic);
      if (sessionId === null) return;
      result = await agent.sendMessage(sessionId, topic.text);
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
  } catch (err) {
    logError("process_topic_message_failed", {
      telegram_id: topic.telegramId,
      error: fmtErr(err),
    });
  }
};

const ensureSession = async (
  agent: AgentClient,
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

  const result = await agent.createSession();
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
