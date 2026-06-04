// Helpers for e2e tests.

interface CapturedMessage {
  chat_id: number;
  text: string;
  message_thread_id?: number;
  parse_mode?: string;
}

/** Build a Telegram webhook update JSON for a forum topic message. */
export function buildWebhookUpdate(opts: {
  updateId?: number;
  messageId?: number;
  fromId: number;
  chatId: number;
  topicId: number;
  text?: string;
  caption?: string;
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
  };
}) {
  const message: Record<string, unknown> = {
    message_id: opts.messageId ?? 1,
    from: { id: opts.fromId, is_bot: false, first_name: "Test" },
    chat: { id: opts.chatId, type: "supergroup" },
    date: Math.floor(Date.now() / 1000),
    is_topic_message: true,
    message_thread_id: opts.topicId,
  };
  if (opts.text !== undefined) message.text = opts.text;
  if (opts.caption !== undefined) message.caption = opts.caption;
  if (opts.document !== undefined) message.document = opts.document;
  return {
    update_id: opts.updateId ?? 1,
    message,
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
