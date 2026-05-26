// Process bootstrap. Reads env, builds the session bridge, mounts the
// Hono app from `app.ts`, and serves it via @hono/node-server. The HTTP
// contract lives in `contract.ts` + `app.ts`; env var list is in README.
//
// Per-write durability comes from tigrisfs `--fsync-on-close` (see
// entrypoint.sh), so no shutdown drain is needed.

import { serve } from "@hono/node-server";

import { createAgentApp } from "./app.js";
import { fmtErr, log, logError } from "./log.js";
import { createSessionBridge } from "./session-bridge.js";

const port = parseInt(process.env.PORT ?? "8080", 10);
const callbackUrl = process.env.CALLBACK_URL;
const cwd = process.env.CWD ?? "/workspace";
const stateDir = process.env.AGENT_STATE_DIR!;

if (!callbackUrl) {
  logError("missing_env", { var: "CALLBACK_URL" });
  process.exit(1);
}

const replyUrl = `${callbackUrl}/reply`;

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

const bridge = createSessionBridge(sendReply, { cwd, stateDir, callbackUrl });

const app = createAgentApp({
  createSession: (sessionId) => bridge.createSession(sessionId),
  promptSession: (sessionId, text) => bridge.promptSession(sessionId, text),
  abortSession: (sessionId) => bridge.abortSession(sessionId),
  getSessionStatus: (sessionId) => bridge.getSessionStatus(sessionId),
});

serve({ fetch: app.fetch, port }, (info) => {
  log("listening", {
    port: info.port,
    callback_url: callbackUrl,
    cwd,
    state_dir: stateDir,
  });
});
