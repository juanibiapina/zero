import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { buildWebhookUpdate, pollForMessage } from "./helpers";

// Must match RATE_LIMIT_MESSAGE in apps/agent-api/src/agents/llm-error.ts.
// Inlined because agent-e2e does not depend on the worker package.
const RATE_LIMIT_MESSAGE =
  "I've hit my usage limit for now, so I can't get to that just yet. " +
  "Please try again in a little while.";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8791";
const MOCK_TELEGRAM_URL =
  process.env.MOCK_TELEGRAM_URL ?? "http://localhost:3501";
const MOCK_ANTHROPIC_URL =
  process.env.MOCK_ANTHROPIC_URL ?? "http://localhost:3502";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

describe("rate limit", () => {
  beforeAll(() => {
    if (!WEBHOOK_SECRET) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET must be set (run via bin/e2e-test or from .dev.vars)",
      );
    }
  });

  afterEach(async () => {
    // Reset the mock so other tests see normal responses.
    await fetch(`${MOCK_ANTHROPIC_URL}/test/mode`, { method: "DELETE" });
  });

  it("tells the user when the model is rate limited", async () => {
    // 1. Put the mock Anthropic server into 429 mode and clear mock Telegram.
    await fetch(`${MOCK_ANTHROPIC_URL}/test/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rate_limit" }),
    });
    await fetch(`${MOCK_TELEGRAM_URL}/test/messages`, { method: "DELETE" });

    // 2. Send a webhook update.
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

    // 3. Poll for the reply. The worker's Anthropic client retries the 429
    // twice (maxRetries: 2) with backoff before surfacing, so allow extra time
    // over hello.test.ts.
    const message = await pollForMessage(MOCK_TELEGRAM_URL, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    });

    expect(message.chat_id).toBe(-100999);
    expect(message.text).toBe(RATE_LIMIT_MESSAGE);
  });
});
