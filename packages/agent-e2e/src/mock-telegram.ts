// Mock Telegram Bot API server.
// Captures sendMessage and multipart sendDocument calls for assertions.
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

interface CapturedDocument {
  chat_id: number;
  message_thread_id?: number;
  filename: string;
  contentType: string;
  content_base64: string;
}

interface RegisteredFile {
  file_path: string;
  content: Buffer;
}

const messages: CapturedMessage[] = [];
const documents: CapturedDocument[] = [];
// Files the test registers so getFile + the download URL can resolve them.
const filesById = new Map<string, RegisteredFile>();
const filesByPath = new Map<string, Buffer>();
// Worker-side events for assertions: getFile lookups and file downloads.
const getFileCalls: string[] = [];
const downloads: string[] = [];
let messageIdCounter = 1;

const app = new Hono();

// Test endpoints (before the catch-all)
app.get("/test/messages", (c) => {
  return c.json({ messages });
});

app.get("/test/events", (c) => {
  return c.json({ getFileCalls, downloads, documents });
});

app.delete("/test/messages", (c) => {
  messages.length = 0;
  documents.length = 0;
  messageIdCounter = 1;
  filesById.clear();
  filesByPath.clear();
  getFileCalls.length = 0;
  downloads.length = 0;
  return c.body(null, 204);
});

// Register a downloadable file: { file_id, file_path, content_base64 }.
app.post("/test/files", async (c) => {
  const body = await c.req.json<{
    file_id: string;
    file_path?: string;
    content_base64: string;
  }>();
  const file_path = body.file_path ?? `documents/${body.file_id}`;
  const content = Buffer.from(body.content_base64, "base64");
  filesById.set(body.file_id, { file_path, content });
  filesByPath.set(file_path, content);
  return c.json({ ok: true });
});

// File download: GET /file/bot<token>/<file_path>. Must precede the
// catch-all POST below (this is a GET, so no conflict, but keep it near).
app.get("/file/*", (c) => {
  const path = new URL(c.req.url).pathname;
  const match = path.match(/^\/file\/bot[^/]+\/(.+)$/);
  if (!match) {
    return c.json({ ok: false, description: "not a file path" }, 404);
  }
  const content = filesByPath.get(match[1]);
  downloads.push(match[1]);
  if (!content) {
    return c.json({ ok: false, description: "file not found" }, 404);
  }
  return c.body(content, 200, { "Content-Type": "application/octet-stream" });
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

  if (method === "sendDocument") {
    const form = await c.req.formData();
    const document = form.get("document");
    if (!document || typeof document === "string") {
      return c.json({ ok: false, description: "document file missing" }, 400);
    }
    const chatId = Number(form.get("chat_id"));
    const thread = form.get("message_thread_id");
    documents.push({
      chat_id: chatId,
      ...(thread ? { message_thread_id: Number(thread) } : {}),
      filename: document.name,
      contentType: document.type,
      content_base64: Buffer.from(await document.arrayBuffer()).toString("base64"),
    });
    return c.json({
      ok: true,
      result: {
        message_id: messageIdCounter++,
        chat: { id: chatId },
        document: { file_name: document.name, mime_type: document.type },
      },
    });
  }

  if (method === "getFile") {
    const body = await c.req.json<{ file_id: string }>();
    getFileCalls.push(body.file_id);
    const file = filesById.get(body.file_id);
    if (!file) {
      return c.json({ ok: false, description: "file not found" }, 400);
    }
    return c.json({
      ok: true,
      result: {
        file_id: body.file_id,
        file_unique_id: body.file_id,
        file_size: file.content.length,
        file_path: file.file_path,
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
