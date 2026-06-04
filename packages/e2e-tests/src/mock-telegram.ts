// Mock Telegram Bot API server.
// Captures sendMessage calls so the test can assert on them.
//
// grammY sends to /bot<TOKEN>/sendMessage where token is directly after "bot".
// We use middleware to match all POST /bot*/method requests.

import { Hono } from "hono";
import { serve } from "@hono/node-server";

interface CapturedMessage {
  chat_id: number;
  text: string;
  message_thread_id?: number;
  parse_mode?: string;
}

const messages: CapturedMessage[] = [];
let messageIdCounter = 1;

const app = new Hono();

// Test endpoints (before the catch-all)
app.get("/test/messages", (c) => {
  return c.json({ messages });
});

app.delete("/test/messages", (c) => {
  messages.length = 0;
  messageIdCounter = 1;
  return c.body(null, 204);
});

// Catch all Bot API calls: /bot<token>/<method>
app.post("/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  const match = path.match(/^\/bot[^/]+\/(\w+)$/);
  if (!match) {
    return c.json({ ok: false, description: "not a bot api path" }, 404);
  }

  const method = match[1];

  if (method === "sendMessage") {
    const body = await c.req.json<CapturedMessage>();
    messages.push(body);
    return c.json({
      ok: true,
      result: {
        message_id: messageIdCounter++,
        chat: { id: body.chat_id },
      },
    });
  }

  if (method === "sendChatAction") {
    return c.json({ ok: true, result: true });
  }

  // Catch-all for other methods
  return c.json({ ok: true, result: {} });
});

const PORT = Number(process.env.MOCK_TELEGRAM_PORT ?? 3501);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Mock Telegram API listening on :${PORT}`);
});
