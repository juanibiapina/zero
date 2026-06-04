import { createAgentClient, type AgentClient, type OutgoingAttachment } from "./agent-client";
import { fmtErr, log, logError } from "./log";
import { getUserDO, type UserDOStub } from "./UserDO/stub";
import type { Env } from "./types";

export interface TopicContext {
  telegramId: string;
  chatId: number;
  topicId: number;
}

export interface TopicMessage extends TopicContext {
  text: string;
  attachments?: OutgoingAttachment[];
}

const tgKey = (telegramId: string) => `tg:${telegramId}`;


export const processTopicMessage = async (
  topic: TopicMessage,
  env: Env,
): Promise<void> => {
  try {
    const clerkUserId = await env.KV.get(tgKey(topic.telegramId));
    if (!clerkUserId) {
      log("drop_unknown_telegram_id", { telegram_id: topic.telegramId });
      return;
    }

    const agent = createAgentClient(env, clerkUserId);
    const userDO = getUserDO(env, clerkUserId);

    let sessionId = await ensureSession(agent, userDO, clerkUserId, topic);
    if (sessionId === null) return;

    let result = await agent.sendMessage(sessionId, topic.text, topic.attachments);
    if (result.kind === "stale") {
      log("stale_session", {
        session_id: sessionId,
        clerk_user_id: clerkUserId,
      });
      await userDO.forgetSession(sessionId);
      sessionId = await ensureSession(agent, userDO, clerkUserId, topic);
      if (sessionId === null) return;
      result = await agent.sendMessage(sessionId, topic.text, topic.attachments);
    }
    if (result.kind === "error") {
      logError("container_rejected_message", {
        clerk_user_id: clerkUserId,
        session_id: sessionId,
        status: result.status,
      });
      return;
    }

    await userDO.markSessionActive(topic.chatId, topic.topicId);
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
  userDO: UserDOStub,
  clerkUserId: string,
  topic: TopicMessage,
): Promise<string | null> => {
  const existing = await userDO.lookupSessionByTopic(topic.chatId, topic.topicId);
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

  await userDO.recordSession(topic.chatId, topic.topicId, result.sessionId);
  log("created_session", {
    session_id: result.sessionId,
    clerk_user_id: clerkUserId,
    chat_id: topic.chatId,
    thread_id: topic.topicId,
  });
  return result.sessionId;
};
