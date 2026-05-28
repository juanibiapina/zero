// Custom tool: close_session
//
// Lets the agent close the current session when the conversation is done.
// POSTs { sessionId } to `{callbackUrl}/close-session`; the worker handles
// connector-specific cleanup (e.g. closing a Telegram forum topic).

import { Type } from "typebox";

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { fmtErr, log, logError } from "./log.js";

const closeSessionSchema = Type.Object({
  message: Type.String({ description: "A short farewell message to send before closing." }),
});

export const createCloseSessionTool = (opts: {
  callbackUrl: string;
  getSessionId: () => string;
  getClerkUserId: () => string;
}): ToolDefinition => {
  const { callbackUrl, getSessionId, getClerkUserId } = opts;
  const url = `${callbackUrl}/close-session`;

  return defineTool({
    name: "close_session",
    label: "Close session",
    description:
      "Close the current session. Call this when the user says goodbye or asks to close the session.",
    parameters: closeSessionSchema,
    async execute(_toolCallId, params) {
      const sessionId = getSessionId();
      log("close_session_tool", { session_id: sessionId });

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: params.message, clerkUserId: getClerkUserId() }),
        });
        if (!res.ok) {
          logError("close_session_failed", {
            session_id: sessionId,
            status: res.status,
          });
          return {
            content: [{ type: "text", text: `Close failed: HTTP ${res.status}` }],
            details: undefined,
          };
        }
      } catch (err) {
        logError("close_session_threw", {
          session_id: sessionId,
          error: fmtErr(err),
        });
        return {
          content: [{ type: "text", text: `Close failed: ${fmtErr(err).message}` }],
          details: undefined,
        };
      }

      return {
        content: [{ type: "text", text: "Session closed." }],
        details: undefined,
      };
    },
  });
};
