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
 *        - KV `topic:{clerkUserId}:{chatId}:{threadId}` → sessionId
 *            miss → POST /sessions on the user's container; store both
 *                   the topic mapping and the reverse `session:{sessionId}`
 *                   record used by the outbound reply handler.
 *        - POST /sessions/{sessionId}/messages with the text.
 *      Errors are logged and dropped. Telegram won't retry because the 200
 *      has already gone out.
 *
 * Durability gap: a worker crash inside `waitUntil` silently drops the
 * update. If the container has lost its in-memory session set (e.g. after
 * an idle eviction), `POST /sessions/{id}/messages` returns 404; we drop
 * the stale `topic:` and `session:` KV entries, create a fresh session,
 * and retry the message once. The user sees a new conversation start;
 * we don't notify them.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { log, logError } from "../log";
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

const topicKey = (
  clerkUserId: string,
  chatId: number,
  messageThreadId: number,
) =>
  `topic:${clerkUserId}:${chatId.toString()}:${messageThreadId.toString()}`;

const sessionKey = (sessionId: string) => `session:${sessionId}`;

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

  let res = await postMessage(stub, sessionId, topic.text);
  if (res.status === 404) {
    log("stale_session", {
      session_id: sessionId,
      clerk_user_id: clerkUserId,
    });
    await resetSession(env, clerkUserId, topic, sessionId);
    sessionId = await ensureSession(stub, env, clerkUserId, topic);
    res = await postMessage(stub, sessionId, topic.text);
  }
  if (!res.ok) {
    logError("container_rejected_message", {
      clerk_user_id: clerkUserId,
      session_id: sessionId,
      status: res.status,
    });
    return;
  }
  log("forwarded_message", {
    clerk_user_id: clerkUserId,
    session_id: sessionId,
  });
};

const postMessage = (
  stub: { fetch: (req: Request) => Promise<Response> },
  sessionId: string,
  text: string,
): Promise<Response> =>
  stub.fetch(
    new Request(
      `http://internal/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
    ),
  );

/**
 * Drop both KV entries that point at a session the container no longer
 * knows about. The next `ensureSession` call will create a fresh one.
 */
const resetSession = async (
  env: Env,
  clerkUserId: string,
  topic: TopicMessage,
  staleSessionId: string,
): Promise<void> => {
  await Promise.all([
    env.KV.delete(topicKey(clerkUserId, topic.chatId, topic.messageThreadId)),
    env.KV.delete(sessionKey(staleSessionId)),
  ]);
};

/**
 * Resolve or create a session for this user's topic. On miss we ask the
 * container for a fresh sessionId and write both forward and reverse KV
 * mappings before returning.
 */
const ensureSession = async (
  stub: { fetch: (req: Request) => Promise<Response> },
  env: Env,
  clerkUserId: string,
  topic: TopicMessage,
): Promise<string> => {
  const key = topicKey(clerkUserId, topic.chatId, topic.messageThreadId);
  const existing = await env.KV.get(key);
  if (existing) {
    return existing;
  }

  const res = await stub.fetch(
    new Request("http://internal/sessions", { method: "POST" }),
  );
  if (!res.ok) {
    throw new Error(
      `container POST /sessions returned ${res.status.toString()}`,
    );
  }
  const body: unknown = await res.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("sessionId" in body) ||
    typeof body.sessionId !== "string" ||
    body.sessionId.length === 0
  ) {
    throw new Error("container POST /sessions returned no sessionId");
  }
  const sessionId = body.sessionId;

  await env.KV.put(key, sessionId);
  await env.KV.put(
    sessionKey(sessionId),
    JSON.stringify({
      clerkUserId,
      chatId: topic.chatId,
      messageThreadId: topic.messageThreadId,
    }),
  );
  log("created_session", {
    session_id: sessionId,
    clerk_user_id: clerkUserId,
    chat_id: topic.chatId,
    thread_id: topic.messageThreadId,
  });
  return sessionId;
};
