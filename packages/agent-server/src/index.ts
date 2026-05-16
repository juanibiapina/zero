/**
 * ============================================================================
 * agent-server entrypoint
 * ============================================================================
 *
 * Process bootstrap: read env, build the session bridge, wire it into the
 * Hono app from `app.ts`, and serve it on `PORT` via @hono/node-server.
 * All HTTP details (routes, schemas, validation, response shapes) live in
 * `contract.ts` + `app.ts`.
 *
 * The reply callback is a fire-and-forget POST to `REPLY_URL` when pi
 * emits `agent_end`; errors are logged, not retried.
 *
 * Environment:
 *   PORT             (optional, default 8080)
 *   REPLY_URL        (required) — full URL the server POSTs replies to.
 *   ANTHROPIC_API_KEY (required) — read by pi-ai directly from process.env.
 *   CWD              (optional, default /workspace) — working directory pi
 *                    uses for its filesystem tools.
 *   AGENT_STATE_DIR  (required) — directory used to persist sessions, one
 *                    subdir per sessionId. Must be writable.
 */

import { serve } from "@hono/node-server";

import { createAgentApp } from "./app.js";
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

// ── App wiring ───────────────────────────────────────────────────────────

const bridge = createSessionBridge(sendReply, { cwd, stateDir });

const app = createAgentApp({
  createSession: (sessionId) => bridge.createSession(sessionId),
  promptSession: (sessionId, text) => bridge.promptSession(sessionId, text),
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  log("listening", {
    port: info.port,
    reply_url: replyUrl,
    cwd,
    state_dir: stateDir,
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────

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
