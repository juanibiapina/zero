/**
 * ============================================================================
 * Telegram MTProto Helpers
 * ============================================================================
 *
 * Thin wrappers around gramjs (`telegram` package) used by both the
 * round-trip test and the interactive `login` script. All identifiers
 * (chat id, thread id, bot username) come from env; this module owns no
 * config of its own.
 */

import bigInt from "big-integer";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import type { TelegramTestEnv } from "./env.js";

export type BigInteger = bigInt.BigInteger;

export const connect = async (
  cfg: Pick<TelegramTestEnv, "apiId" | "apiHash" | "session">,
): Promise<TelegramClient> => {
  const client = new TelegramClient(
    new StringSession(cfg.session),
    cfg.apiId,
    cfg.apiHash,
    { connectionRetries: 5 },
  );
  await client.connect();
  const authorised = await client.checkAuthorization();
  if (!authorised) {
    throw new Error(
      "Telegram session is not authorised. Re-run 'pnpm --filter @zero/integration-tests login' to capture a fresh TG_TEST_SESSION_STRING.",
    );
  }
  return client;
};

export const resolveBotId = async (
  client: TelegramClient,
  username: string,
): Promise<BigInteger> => {
  const entity = await client.getEntity(username);
  return entity.id;
};

export interface SentMessage {
  id: number;
  date: number;
}

/**
 * Send a message into a forum-topic thread. In gramjs, setting `replyTo`
 * to the topic header message id (which equals the `message_thread_id`
 * the Telegram Bot API surfaces) makes the new message land inside that
 * topic.
 */
export const sendToTopic = async (
  client: TelegramClient,
  chatId: string,
  threadId: number,
  text: string,
): Promise<SentMessage> => {
  const result = await client.sendMessage(chatId, {
    message: text,
    replyTo: threadId,
  });
  return { id: result.id, date: result.date };
};

export interface PollOptions {
  chatId: string;
  botId: BigInteger;
  sinceMessageId: number;
  timeoutMs: number;
  /** When set, only messages in the topic with this thread id qualify. */
  topicThreadId?: number;
  /** When set, the bot's text must include this substring. */
  needle?: string;
  intervalMs?: number;
}

export interface ReceivedMessage {
  id: number;
  text: string;
}

/**
 * Poll the chat for the next message from the bot with id greater than
 * `sinceMessageId`. When `needle` is set, the bot's text must contain it.
 * When `topicThreadId` is set, the search is scoped to that forum-topic
 * thread (the underlying call uses `messages.GetReplies`, which Telegram
 * uses to back forum-topic threads).
 */
export const pollForBotReply = async (
  client: TelegramClient,
  opts: PollOptions,
): Promise<ReceivedMessage | null> => {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 2_000;
  while (Date.now() < deadline) {
    const messages = await client.getMessages(opts.chatId, {
      limit: 50,
      minId: opts.sinceMessageId,
      ...(opts.topicThreadId !== undefined
        ? { replyTo: opts.topicThreadId }
        : {}),
    });
    for (const m of messages) {
      if (!m.senderId?.equals(opts.botId)) continue;
      const text = m.text;
      if (typeof text !== "string") continue;
      if (opts.needle !== undefined && !text.includes(opts.needle)) continue;
      return { id: m.id, text };
    }
    await sleep(interval);
  }
  return null;
};

export const deleteMessages = async (
  client: TelegramClient,
  chatId: string,
  ids: number[],
): Promise<void> => {
  if (ids.length === 0) return;
  await client.deleteMessages(chatId, ids, { revoke: true });
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
