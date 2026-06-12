// Drives the deployed production worker through a Gmail round-trip,
// proving the badlogic CLIs (gmcli) work behind the secret proxy:
//
//   1. "Send an email to myself with subject <nonce>."  — expect SENT
//   2. "Search my inbox for <nonce>, reply the subject." — expect <nonce>
//
// Turn 1 exercises send (sentinel -> real token on egress, real From:
// address) and turn 2 exercises search + thread read. A green test means
// no rustls close_notify error and the injected accounts.json works.
//
// Fast: no container-sleep wait. ~1-2 min wall clock.
// See docs/integration-tests.md for setup.

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

it("sends and reads a Gmail message via the gmail skill", async () => {
  const nonce = randomNonce();
  const subject = `Zero gmail test ${nonce}`;
  const tag = `[zero-test ${nonce}]`;

  const sent1 = await sendTurn(
    `${tag} Use the gmail skill. Send an email to my own Gmail address ` +
      `with the exact subject "${subject}" and body "round-trip ok". ` +
      `I authorize you to send it now — do not ask for confirmation. ` +
      `After it is sent, reply with only the word SENT.`,
  );
  const reply1 = await waitForBotReply(sent1.id, 150_000, "SENT");
  expect(reply1, "bot did not confirm SENT for turn 1").not.toBeNull();

  const sent2 = await sendTurn(
    `${tag} Search my Gmail inbox for the message whose subject contains ` +
      `"${nonce}" and reply with its exact subject line and nothing else.`,
  );
  const reply2 = await waitForBotReply(reply1!.id, 150_000, nonce);
  expect(reply2, `bot reply did not contain the nonce ${nonce}`).not.toBeNull();
  expect(reply2!.text).toContain(subject);

  await deleteMessages(client, env.chatId, [
    sent1.id,
    reply1!.id,
    sent2.id,
    reply2!.id,
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
