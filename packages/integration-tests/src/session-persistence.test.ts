/**
 * ============================================================================
 * Session Persistence Integration Test
 * ============================================================================
 *
 * Drives the deployed production worker through three turns in the same
 * forum topic:
 *
 *   1. Send a message mentioning the number `1`.        — any bot reply OK
 *   2. Send a message mentioning the number `2`.        — any bot reply OK
 *   3. *** Sleep > 5 minutes ***                        — container idles
 *      (Cloudflare Containers' `sleepAfter = 5 min` evicts the per-user
 *       container; pi's in-memory session map is lost.)
 *   4. Send a third message asking "what is the next number?".
 *      Assert the bot replies with `3`.
 *
 * The only way step 4 can succeed is if the container, woken cold by the
 * third message, resumed the prior conversation off the R2-mounted JSONL
 * via `SessionManager.continueRecent`. So a passing test proves both the
 * round-trip AND the persistence path.
 *
 * Pre-conditions are the same as before: TG_TEST_* env vars populated,
 * bot is a member of TG_TEST_CHAT_ID with topic TG_TEST_THREAD_ID, and
 * the test user's Telegram id is linked to a Clerk user in Zero's KV.
 *
 * Wall-clock: ~6.5 minutes when warm (sleep dominates). Cost: ~$0.01 of
 * Anthropic.
 */

import { afterAll, beforeAll, expect, it } from "vitest";

import { loadTelegramEnv } from "./env.js";
import {
  connect,
  deleteMessages,
  pollForBotReply,
  resolveBotId,
  sendToTopic,
  type BigInteger,
  type ReceivedMessage,
  type SentMessage,
} from "./telegram.js";
import type { TelegramClient } from "telegram";

const env = loadTelegramEnv();

let client: TelegramClient;
let botId: BigInteger;

beforeAll(async () => {
  client = await connect(env);
  botId = await resolveBotId(client, env.botUsername);
});

afterAll(async () => {
  if (client) await client.disconnect();
});

it("persists session context across container sleep", async () => {
  const nonce = randomNonce();
  const tag = `[zero-test ${nonce}]`;

  const sent1 = await sendTurn(
    `${tag} Please remember the following number: 1. Briefly acknowledge. Do not use any tools.`,
  );
  const reply1 = await waitForBotReply(sent1.id, 90_000);
  expect(reply1, "no bot reply to turn 1").not.toBeNull();

  const sent2 = await sendTurn(
    `${tag} Please also remember: 2. Briefly acknowledge. Do not use any tools.`,
  );
  const reply2 = await waitForBotReply(reply1!.id, 90_000);
  expect(reply2, "no bot reply to turn 2").not.toBeNull();

  // Wait out the container's `sleepAfter = 5 min` window so the per-user
  // container is evicted before we send turn 3. The next message must
  // wake a fresh container and the agent-server must resume the session
  // off the R2 mount for the assertion below to pass.
  const SLEEP_MS = 5 * 60_000 + 30_000;
  console.log(
    `[test] turn 2 acknowledged; sleeping ${SLEEP_MS / 1_000}s to trigger container idle eviction…`,
  );
  await sleep(SLEEP_MS);

  const sent3 = await sendTurn(
    `${tag} What is the next number in the sequence? Reply with only the single digit and nothing else. Do not use any tools.`,
  );
  // 120s timeout: container cold start + FUSE mount + session resume + Anthropic round-trip.
  const reply3 = await waitForBotReply(reply2!.id, 120_000, "3");
  expect(reply3, "no reply containing '3' to turn 3").not.toBeNull();

  // Strict: the bot must reply with just the digit (modulo trailing
  // whitespace or a period). Anything chattier (e.g. "1, 2, 3" or "Three.")
  // signals either prompt drift or session loss.
  expect(
    reply3!.text.trim().replace(/\.$/, ""),
    `expected exactly "3", got: ${JSON.stringify(reply3!.text)}`,
  ).toBe("3");

  // Cleanup on success only; failures leave the messages for inspection.
  await deleteMessages(client, env.chatId, [
    sent1.id,
    reply1!.id,
    sent2.id,
    reply2!.id,
    sent3.id,
    reply3!.id,
  ]);
});

const sendTurn = (text: string): Promise<SentMessage> =>
  sendToTopic(client, env.chatId, env.threadId, text);

const waitForBotReply = (
  sinceMessageId: number,
  timeoutMs: number,
  needle?: string,
): Promise<ReceivedMessage | null> =>
  pollForBotReply(client, {
    chatId: env.chatId,
    botId,
    sinceMessageId,
    topicThreadId: env.threadId,
    timeoutMs,
    needle,
  });

const randomNonce = (): string => {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
