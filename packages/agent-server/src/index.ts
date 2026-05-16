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
 * Shutdown contract (called by the entrypoint supervisor on SIGTERM):
 *   1. close the HTTP listener so no new requests are accepted,
 *   2. wait up to `DRAIN_TIMEOUT_MS` for in-flight pi turns to finish
 *      (their `agent_end` triggers a reply, which is what we need on R2
 *      before the FUSE mount goes away),
 *   3. exit 0 so the supervisor proceeds to unmount tigrisfs.
 * Cloudflare's container SIGTERM-to-SIGKILL ceiling is 15 min; we cap
 * drain at 13 min and leave 2 min for unmount + tigrisfs flush.
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

/**
 * Cap the drain at 13 min so we leave headroom under Cloudflare's 15 min
 * SIGTERM → SIGKILL ceiling for the supervisor to unmount tigrisfs and
 * for tigrisfs to flush dirty pages to R2.
 */
const DRAIN_TIMEOUT_MS = 13 * 60_000;

let shuttingDown = false;

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown_signal", { signal });

  // Stop accepting new connections; existing ones (the HTTP request that
  // delivered the prompt has already returned 202) are unaffected.
  server.close();

  log("drain_started", { timeout_ms: DRAIN_TIMEOUT_MS });
  const startedAt = Date.now();
  const result = await bridge.awaitIdle({ timeoutMs: DRAIN_TIMEOUT_MS });
  log("drain_complete", {
    inflight: result.inflight,
    waited_ms: Date.now() - startedAt,
    timed_out: result.timedOut,
  });

  process.exit(0);
};

process.on("SIGTERM", (signal) => {
  void shutdown(signal);
});
process.on("SIGINT", (signal) => {
  void shutdown(signal);
});
