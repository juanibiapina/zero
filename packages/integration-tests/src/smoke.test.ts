// Prod smoke test: proves the deployed bot is alive end to end.
//
//   1. Sign in to Telegram as a real user (MTProto/gramjs).
//   2. Send one message with a random nonce into the test supergroup topic,
//      asking the bot to echo the nonce back.
//   3. Poll the topic for the bot's reply containing that nonce.
//
// A green run means every real layer worked: Telegram delivery -> webhook ->
// UserDO alarm -> pi-ai adapter -> Cloudflare AI Gateway (BYOK) -> OpenAI ->
// reply back to Telegram. No mocks. It does NOT assert memory or persistence;
// it only answers "is the bot responding right now".
//
// ~1 model call, a few seconds of latency, ~$0.01. Run on demand against prod,
// not on every commit. See docs/integration-tests.md for setup.

import { afterAll, beforeAll, expect, it } from "vitest";

import { loadTelegramEnv } from "./env.js";
import {
  connect,
  deleteMessages,
  pollForBotReply,
  resolveBotId,
  type BigInteger,
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

it("the deployed bot replies to a message", async () => {
  const nonce = randomNonce();

  const sent = await client.sendMessage(env.chatId, {
    message:
      `[zero-smoke ${nonce}] Reply with exactly this token and nothing else: ` +
      `${nonce}. Do not use any tools.`,
    replyTo: env.threadId,
  });

  // Poll the whole chat (not thread-scoped): a forum reply is not reliably
  // returned by messages.getReplies for the topic, but the unique nonce plus the
  // bot sender id makes an unscoped match unambiguous in the dedicated test group.
  const reply = await pollForBotReply(client, {
    chatId: env.chatId,
    botId,
    sinceMessageId: sent.id,
    needle: nonce,
    timeoutMs: 120_000,
  });

  expect(reply, `no bot reply containing the nonce ${nonce}`).not.toBeNull();

  // Clean up on success only; a failure leaves the messages for inspection.
  await deleteMessages(client, env.chatId, [sent.id, reply!.id]);
});

const randomNonce = (): string => {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};
