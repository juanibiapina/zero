// Drives the deployed production worker through three turns:
//
//   1. "Remember 1."                   — any reply OK
//   2. "Also remember 2."              — any reply OK
//   3. Sleep > 5 min (sleepAfter)      — container idles, in-memory state lost
//   4. "What's the next number?"       — expect exactly "3"
//
// Step 4 only passes if the cold-resumed container replayed the JSONL
// off the R2 mount via `SessionManager.continueRecent`, so a green test
// proves both round-trip and persistence.
//
// ~6.5 min wall clock (sleep dominates); ~$0.01 of Anthropic.
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

  // Wait out sleepAfter so turn 3 must wake a fresh container and resume
  // off the R2 mount.
  const SLEEP_MS = 5 * 60_000 + 30_000;
  console.log(
    `[test] turn 2 acknowledged; sleeping ${SLEEP_MS / 1_000}s to trigger container idle eviction…`,
  );
  await sleep(SLEEP_MS);

  const sent3 = await sendTurn(
    `${tag} What is the next number in the sequence? Reply with only the single digit and nothing else. Do not use any tools.`,
  );
  // 120s: cold start + FUSE mount + resume + Anthropic round-trip.
  const reply3 = await waitForBotReply(reply2!.id, 120_000, "3");
  expect(reply3, "no reply containing '3' to turn 3").not.toBeNull();

  // Strict: just the digit (allow trailing period). Chattier replies
  // ("1, 2, 3", "Three.") signal prompt drift or session loss.
  expect(
    reply3!.text.trim().replace(/\.$/, ""),
    `expected exactly "3", got: ${JSON.stringify(reply3!.text)}`,
  ).toBe("3");

  // Cleanup on success only; failures leave messages for inspection.
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
