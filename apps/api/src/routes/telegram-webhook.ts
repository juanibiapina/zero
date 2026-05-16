// POST /api/webhooks/telegram — public route.
//
// Accepts forum topic messages only; everything else (DMs, edits,
// channel posts) is dropped. grammY's `webhookCallback` validates the
// X-Telegram-Bot-Api-Secret-Token header. The bot middleware schedules
// `processTopicMessage` via `executionCtx.waitUntil` and the route
// returns 200 immediately. Background failures are logged and dropped.
//
// Self-heal: if `sendMessage` returns `stale` (the container lost its
// in-memory session map), we drop the stale KV entries and create a
// fresh session once. User sees a new conversation start; no notice.
//
// See docs/design.md § Routes for the full pipeline.

import { OpenAPIHono } from "@hono/zod-openapi";
import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import {
  createSession,
  sendMessage,
  type AgentStub,
} from "../agent-client";
import { log, logError } from "../log";
import {
  forgetSession,
  lookupSessionId,
  recordSession,
  type SessionRecord,
} from "../sessions";
import type { Env } from "../types";

interface TopicMessage {
  telegramId: string;
  chatId: number;
  messageThreadId: number;
  text: string;
}

export const createTelegramWebhookRoute = () => {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.post("/api/webhooks/telegram", async (c) => {
    const botInfo = JSON.parse(c.env.TELEGRAM_BOT_INFO) as UserFromGetMe;
    const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN, { botInfo });

    bot.on("message", (ctx) => {
      const msg = ctx.message;
      if (!msg.is_topic_message || msg.message_thread_id === undefined) {
        log("drop_non_topic_message", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }
      if (typeof msg.text !== "string" || msg.text.length === 0) {
        log("drop_topic_message_without_text", {
          telegram_id: String(ctx.from.id),
        });
        return;
      }

      const topic: TopicMessage = {
        telegramId: String(ctx.from.id),
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id,
        text: msg.text,
      };
      c.executionCtx.waitUntil(processTopicMessage(topic, c.env));
    });

    return webhookCallback(bot, "hono", {
      secretToken: c.env.TELEGRAM_WEBHOOK_SECRET,
    })(c);
  });

  return router;
};

const tgKey = (telegramId: string) => `tg:${telegramId}`;

const processTopicMessage = async (
  topic: TopicMessage,
  env: Env,
): Promise<void> => {
  const clerkUserId = await env.KV.get(tgKey(topic.telegramId));
  if (!clerkUserId) {
    log("drop_unknown_telegram_id", { telegram_id: topic.telegramId });
    return;
  }

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

// Resolve or create a session for this user's topic. Returns null on
// container error (logged here so a `waitUntil` throw stays visible).
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
