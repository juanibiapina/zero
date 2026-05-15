/**
 * ============================================================================
 * agent-server
 * ============================================================================
 *
 * Standalone HTTP server for agentic sessions. Knows nothing about Cloudflare
 * or Telegram — designed to run in any Node.js environment that can reach
 * a configured reply URL.
 *
 * HTTP contract:
 *   POST /sessions
 *     → 200 { sessionId: string }
 *
 *   POST /sessions/:sessionId/messages   body: { text: string }
 *     → 202 (no body) on success; 404 if sessionId is unknown
 *     Side effect: when the agent finishes streaming, the server POSTs the
 *     final assistant text to ${REPLY_URL} as
 *       { sessionId, text }
 *
 * Environment:
 *   PORT       (optional, default 8080)
 *   REPLY_URL  (required) — full URL the server POSTs replies to.
 *   CWD        (optional, default /workspace) — working directory pi uses
 *              for its filesystem tools.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSessionBridge } from "./session-bridge.js";

const port = parseInt(process.env.PORT ?? "8080", 10);
const replyUrl = process.env.REPLY_URL;
const cwd = process.env.CWD ?? "/workspace";

if (!replyUrl) {
  console.error("REPLY_URL env var is required");
  process.exit(1);
}

// ── Reply callback ───────────────────────────────────────────────────────

const sendReply = async (sessionId: string, text: string): Promise<void> => {
  try {
    const res = await fetch(replyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, text }),
    });
    if (!res.ok) {
      console.error(
        `Reply to ${replyUrl} failed for sessionId=${sessionId}: ${res.status.toString()}`,
      );
    }
  } catch (err) {
    console.error(
      `Reply to ${replyUrl} threw for sessionId=${sessionId}:`,
      err,
    );
  }
};

const bridge = createSessionBridge(sendReply, cwd);

// ── HTTP helpers ─────────────────────────────────────────────────────────

const readJson = async <T>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
};

const send = (
  res: ServerResponse,
  status: number,
  body?: Record<string, unknown>,
): void => {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// ── Routing ──────────────────────────────────────────────────────────────

const MESSAGES_PATH = /^\/sessions\/([^/]+)\/messages$/;

const handle = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (method === "POST" && url === "/sessions") {
    const sessionId = randomUUID();
    try {
      await bridge.createSession(sessionId);
    } catch (err) {
      console.error(`Failed to create sessionId=${sessionId}:`, err);
      send(res, 500, { error: "create session failed" });
      return;
    }
    console.log(`Created sessionId=${sessionId}`);
    send(res, 200, { sessionId });
    return;
  }

  const match = MESSAGES_PATH.exec(url);
  if (method === "POST" && match) {
    const sessionId = match[1];
    let body: { text?: string };
    try {
      body = await readJson<{ text?: string }>(req);
    } catch {
      send(res, 400, { error: "invalid json" });
      return;
    }
    const text = body.text;
    if (typeof text !== "string" || text.length === 0) {
      send(res, 400, { error: "missing text" });
      return;
    }
    const accepted = bridge.promptSession(sessionId, text);
    if (!accepted) {
      send(res, 404, { error: "unknown session" });
      return;
    }
    console.log(`Received message on sessionId=${sessionId}`);
    send(res, 202);
    return;
  }

  send(res, 404, { error: "not found" });
};

// ── Server ───────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error("Unhandled request error:", err);
    send(res, 500, { error: "internal error" });
  });
});

server.listen(port, () => {
  console.log(
    `agent-server listening on port ${port.toString()}, replies to ${replyUrl}, cwd=${cwd}`,
  );
});

const shutdown = (): void => {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 5000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
