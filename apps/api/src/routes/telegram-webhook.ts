/**
 * ============================================================================
 * Telegram Webhook Route
 * ============================================================================
 *
 * POST /api/webhooks/telegram — public route.
 *
 * The route delegates to grammY's `webhookCallback` ("hono" adapter), which
 * validates the X-Telegram-Bot-Api-Secret-Token header against
 * TELEGRAM_WEBHOOK_SECRET, parses the body as a Telegram `Update`, and
 * dispatches to bot middleware.
 *
 * We only act on **forum topic messages** (supergroup messages with
 * `message_thread_id`). Everything else — DMs, channel posts, edits,
 * callbacks — is dropped here. The web app pairs a Clerk user with a
 * Telegram user id; that user is expected to talk to the bot from inside
 * topics.
 *
 * Flow for an accepted message:
 *   1. grammY validates the secret and parses the update.
 *   2. We schedule `processTopicMessage` via `executionCtx.waitUntil` and
 *      return 200 immediately.
 *   3. Background:
 *        - KV `tg:{telegramId}` → clerkUserId  (drop unknown)
 *        - `ensureSession`: lookup-or-create the topic↔session linkage
 *          (see `sessions.ts`); on miss, asks the container for a fresh
 *          session via the typed `agent-client`.
 *        - `sendMessage` posts the text to the container session.
 *      Errors are logged and dropped. Telegram won't retry because the 200
 *      has already gone out.
 *
 * Durability gap: a worker crash inside `waitUntil` silently drops the
 * update. If the container has lost its in-memory session set (e.g. after
 * an idle eviction), `sendMessage` returns `{ kind: "stale" }`; we drop
 * the stale KV entries, create a fresh session, and retry once. The
 * user sees a new conversation start; we don't notify them.
 */

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

// ── Keys ─────────────────────────────────────────────────────────────────

const tgKey = (telegramId: string) => `tg:${telegramId}`;

// ── Pipeline ─────────────────────────────────────────────────────────────

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

/**
 * Resolve or create a session for this user's topic. On miss we ask the
 * container for a fresh sessionId via the typed `agent-client` and
 * persist the linkage in KV via `recordSession`. Returns null if the
 * container failed to create a session (logged here so the failure is
 * visible — a thrown error inside `waitUntil` would be invisible).
 */
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
