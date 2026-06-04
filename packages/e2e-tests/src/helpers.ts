// Helpers for e2e tests.

interface CapturedMessage {
  chat_id: number;
  text: string;
  message_thread_id?: number;
  parse_mode?: string;
}

/** Build a Telegram webhook update JSON for a forum topic text message. */
export function buildWebhookUpdate(opts: {
  updateId?: number;
  messageId?: number;
  fromId: number;
  chatId: number;
  topicId: number;
  text: string;
}) {
  return {
    update_id: opts.updateId ?? 1,
    message: {
      message_id: opts.messageId ?? 1,
      from: { id: opts.fromId, is_bot: false, first_name: "Test" },
      chat: { id: opts.chatId, type: "supergroup" },
      text: opts.text,
      date: Math.floor(Date.now() / 1000),
      is_topic_message: true,
      message_thread_id: opts.topicId,
    },
  };
}

/** Poll the mock Telegram server until at least one sendMessage is captured. */
export async function pollForMessage(
  mockTelegramUrl: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<CapturedMessage> {
  const timeout = opts.timeoutMs ?? 120_000;
  const interval = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const res = await fetch(`${mockTelegramUrl}/test/messages`);
    const body = (await res.json()) as { messages: CapturedMessage[] };
    if (body.messages.length > 0) {
      return body.messages[0];
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`No message captured within ${timeout}ms`);
}
