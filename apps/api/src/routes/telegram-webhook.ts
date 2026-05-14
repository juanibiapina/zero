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
 * update. Container memory loss leaves a stale topic→session mapping;
 * future messages will 404 against the container until cleared. Both are
 * accepted for the POC.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
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
        console.log(
          `Dropping non-topic message from telegramId=${ctx.from.id.toString()}`,
        );
        return;
      }
      if (typeof msg.text !== "string" || msg.text.length === 0) {
        console.log(
          `Dropping topic message without text from telegramId=${ctx.from.id.toString()}`,
        );
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
    console.log(`Dropping message from unknown telegramId=${topic.telegramId}`);
    return;
  }

  const stub = env.AGENT_CONTAINER.getByName(clerkUserId);

  const sessionId = await ensureSession(stub, env, clerkUserId, topic);

  const res = await stub.fetch(
    new Request(
      `http://internal/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: topic.text }),
      },
    ),
  );
  if (!res.ok) {
    console.error(
      `Container rejected message for clerkUserId=${clerkUserId} sessionId=${sessionId}: ${res.status.toString()}`,
    );
    return;
  }
  console.log(
    `Forwarded message to clerkUserId=${clerkUserId} sessionId=${sessionId}`,
  );
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
  console.log(
    `Created sessionId=${sessionId} for clerkUserId=${clerkUserId} chat=${topic.chatId.toString()} thread=${topic.messageThreadId.toString()}`,
  );
  return sessionId;
};
