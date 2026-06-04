import { describe, it, expect, beforeAll } from "vitest";
import { buildWebhookUpdate, pollForMessage } from "./helpers";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8791";
const MOCK_TELEGRAM_URL =
  process.env.MOCK_TELEGRAM_URL ?? "http://localhost:3501";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const FILE_ID = "e2e-doc-1";
const FILE_NAME = "notes.txt";
const DOC_CONTENT = "The magic passphrase is OPOSSUM-7.";

/** Poll the mock Telegram server until getFile/download events appear. */
async function pollForEvents(
  predicate: (e: { getFileCalls: string[]; downloads: string[] }) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ getFileCalls: string[]; downloads: string[] }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const interval = opts.intervalMs ?? 500;
  while (Date.now() < deadline) {
    const res = await fetch(`${MOCK_TELEGRAM_URL}/test/events`);
    const body = (await res.json()) as {
      getFileCalls: string[];
      downloads: string[];
    };
    if (predicate(body)) return body;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("Expected getFile/download events were not observed");
}

describe("attachments", () => {
  beforeAll(() => {
    if (!WEBHOOK_SECRET) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET must be set (use doppler run or .dev.vars)",
      );
    }
  });

  it("downloads a document and hands it to the agent", async () => {
    // 1. Reset mock state.
    await fetch(`${MOCK_TELEGRAM_URL}/test/messages`, { method: "DELETE" });

    // 2. Register the downloadable file with mock Telegram.
    await fetch(`${MOCK_TELEGRAM_URL}/test/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: FILE_ID,
        file_path: `documents/${FILE_NAME}`,
        content_base64: Buffer.from(DOC_CONTENT).toString("base64"),
      }),
    });

    // 3. Send a caption-less document update. With the old text-only
    //    handler this would have been dropped outright.
    const update = buildWebhookUpdate({
      fromId: 12345,
      chatId: -100999,
      topicId: 42,
      document: {
        file_id: FILE_ID,
        file_unique_id: "uniq-1",
        file_name: FILE_NAME,
        mime_type: "text/plain",
      },
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

    // 4. The webhook accepted the attachment-only message, resolved it via
    //    getFile, and downloaded the bytes from the file endpoint.
    const events = await pollForEvents(
      (e) => e.getFileCalls.includes(FILE_ID) && e.downloads.length > 0,
    );
    expect(events.getFileCalls).toContain(FILE_ID);
    expect(events.downloads).toContain(`documents/${FILE_NAME}`);

    // 5. The bytes were forwarded to the container and the agent replied
    //    into the same topic — proving the full attachment round-trip.
    const message = await pollForMessage(MOCK_TELEGRAM_URL, {
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });
    expect(message.chat_id).toBe(-100999);
    expect(message.message_thread_id).toBe(42);
    expect(message.text).toBeTruthy();
  });
});
