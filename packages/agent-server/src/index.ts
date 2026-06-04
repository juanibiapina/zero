// Process bootstrap. Reads env, builds the session bridge, mounts the
// Hono app from `app.ts`, and serves it via @hono/node-server. The HTTP
// contract lives in `contract.ts` + `app.ts`; env var list is in README.
//
// SIGTERM saves the /workspace state archive before exiting so the last
// snapshot reaches R2 even on idle eviction or deploy rollout.

import { serve } from "@hono/node-server";

import { createAgentApp } from "./app.js";
import { fmtErr, log, logError } from "./log.js";
import { createSessionBridge, type SessionCostStats } from "./session-bridge.js";
import { saveState } from "./save-state.js";

const port = parseInt(process.env.PORT ?? "8080", 10);
const callbackUrl = process.env.CALLBACK_URL;
const cwd = "/workspace";
const stateDir = "/workspace/sessions";
const clerkUserId = process.env.CLERK_USER_ID;

if (!callbackUrl) {
  logError("missing_env", { var: "CALLBACK_URL" });
  process.exit(1);
}

if (!clerkUserId) {
  logError("missing_env", { var: "CLERK_USER_ID" });
  process.exit(1);
}

const messageEndUrl = `${callbackUrl}/message-end`;
const agentEndUrl = `${callbackUrl}/agent-end`;

const sendMessageEnd = async (sessionId: string, text: string): Promise<void> => {
  try {
    const res = await fetch(messageEndUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, text, clerkUserId }),
    });
    if (!res.ok) {
      logError("message_end_failed", {
        session_id: sessionId,
        url: messageEndUrl,
        status: res.status,
      });
    }
  } catch (err) {
    logError("message_end_threw", {
      session_id: sessionId,
      url: messageEndUrl,
      error: fmtErr(err),
    });
  }
};

const sendAgentEnd = async (sessionId: string, willRetry: boolean, stats: SessionCostStats | null): Promise<void> => {
  try {
    const res = await fetch(agentEndUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, clerkUserId, willRetry, ...(stats && { stats }) }),
    });
    if (!res.ok) {
      logError("agent_end_failed", {
        session_id: sessionId,
        url: agentEndUrl,
        status: res.status,
      });
    }
  } catch (err) {
    logError("agent_end_threw", {
      session_id: sessionId,
      url: agentEndUrl,
      error: fmtErr(err),
    });
  }
};

const bridge = createSessionBridge(sendMessageEnd, sendAgentEnd, { cwd, stateDir, callbackUrl, clerkUserId });

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

process.on("SIGTERM", () => {
  log("sigterm");
  void saveState(cwd, callbackUrl, clerkUserId).finally(() => {
    process.exit(0);
  });
});
