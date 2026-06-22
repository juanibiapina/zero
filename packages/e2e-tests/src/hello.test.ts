import { describe, it, expect, beforeAll } from "vitest";
import { buildWebhookUpdate, pollForMessage } from "./helpers";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8791";
const MOCK_TELEGRAM_URL =
  process.env.MOCK_TELEGRAM_URL ?? "http://localhost:3501";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

describe("hello", () => {
  beforeAll(() => {
    if (!WEBHOOK_SECRET) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET must be set (run via bin/e2e-test or from .dev.vars)",
      );
    }
  });

  it("sends hello and receives a reply", async () => {
    // 1. Clear mock Telegram
    await fetch(`${MOCK_TELEGRAM_URL}/test/messages`, { method: "DELETE" });

    // 2. Send webhook
    const update = buildWebhookUpdate({
      fromId: 12345,
      chatId: -100999,
      topicId: 42,
      text: "hello",
    });

    const res = await fetch(`${WORKER_URL}/api/webhooks/telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET!,
      },
      body: JSON.stringify(update),
    });
    expect(res.status).toBe(200);

    // 3. Poll for reply (container cold start + agent round trip)
    const message = await pollForMessage(MOCK_TELEGRAM_URL, {
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });

    // 4. Assert: a reply was sent to the correct chat and topic
    expect(message.chat_id).toBe(-100999);
    expect(message.message_thread_id).toBe(42);
    expect(message.text).toBeTruthy();
  });
});
