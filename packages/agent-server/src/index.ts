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
 *   PORT             (optional, default 8080)
 *   REPLY_URL        (required) — full URL the server POSTs replies to.
 *   CWD              (optional, default /workspace) — working directory pi
 *                    uses for its filesystem tools.
 *   AGENT_STATE_DIR  (required) — directory used to persist sessions, one
 *                    subdir per sessionId. Must be writable.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fmtErr, log, logError } from "./log.js";
import { createSessionBridge } from "./session-bridge.js";

const port = parseInt(process.env.PORT ?? "8080", 10);
const replyUrl = process.env.REPLY_URL;
const cwd = process.env.CWD ?? "/workspace";
const stateDir = process.env.AGENT_STATE_DIR!;

if (!replyUrl) {
  logError("missing_env", { var: "REPLY_URL" });
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
      logError("reply_failed", {
        session_id: sessionId,
        reply_url: replyUrl,
        status: res.status,
      });
    }
  } catch (err) {
    logError("reply_threw", {
      session_id: sessionId,
      reply_url: replyUrl,
      error: fmtErr(err),
    });
  }
};

const bridge = createSessionBridge(sendReply, { cwd, stateDir });

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
      logError("create_session_failed", {
        session_id: sessionId,
        error: fmtErr(err),
      });
      send(res, 500, { error: "create session failed" });
      return;
    }
    log("created_session", { session_id: sessionId });
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
    const accepted = await bridge.promptSession(sessionId, text);
    if (!accepted) {
      send(res, 404, { error: "unknown session" });
      return;
    }
    send(res, 202);
    return;
  }

  send(res, 404, { error: "not found" });
};

// ── Server ───────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    logError("unhandled_request", { error: fmtErr(err) });
    send(res, 500, { error: "internal error" });
  });
});

server.listen(port, () => {
  log("listening", { port, reply_url: replyUrl, cwd, state_dir: stateDir });
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
