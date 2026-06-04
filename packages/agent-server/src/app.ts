// Wires the contract routes from `contract.ts` to caller-supplied
// handlers; this module knows nothing about pi or any stateful concern.
//
// Keep the `.openapi(...)` chain inline (no intermediate variable) so
// TypeScript builds the full route map on the return type — that's what
// `hc<AppType>` on the worker side reads.

import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";

import {
  abortSessionRoute,
  createSessionRoute,
  getSessionStatusRoute,
  sendMessageRoute,
} from "./contract.js";
import { fmtErr, log, logError } from "./log.js";

export interface SessionStatus {
  model: string;
  contextPercent: number | null;
}

export interface PromptAttachment {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface AgentHandlers {
  createSession: (sessionId: string) => Promise<void>;
  /** Returns false when the session id is unknown (→ 404). */
  promptSession: (
    sessionId: string,
    text: string,
    attachments?: PromptAttachment[],
  ) => Promise<boolean>;
  /** Returns "aborted" | "nothing_running" | "unknown". */
  abortSession: (sessionId: string) => Promise<"aborted" | "nothing_running" | "unknown">;
  /** Returns null when the session id is unknown (→ 404). */
  getSessionStatus: (sessionId: string) => Promise<SessionStatus | null>;
}

export const createAgentApp = (handlers: AgentHandlers) =>
  new OpenAPIHono()
    .openapi(createSessionRoute, async (c) => {
      const sessionId = randomUUID();
      try {
        await handlers.createSession(sessionId);
      } catch (err) {
        logError("create_session_failed", {
          session_id: sessionId,
          error: fmtErr(err),
        });
        return c.json({ error: "create session failed" }, 500);
      }
      log("created_session", { session_id: sessionId });
      return c.json({ sessionId }, 200);
    })
    .openapi(sendMessageRoute, async (c) => {
      const { sessionId } = c.req.valid("param");
      const { text, attachments } = c.req.valid("json");
      const accepted = await handlers.promptSession(sessionId, text, attachments);
      if (!accepted) {
        return c.json({ error: "unknown session" }, 404);
      }
      return c.body(null, 202);
    })
    .openapi(abortSessionRoute, async (c) => {
      const { sessionId } = c.req.valid("param");
      const result = await handlers.abortSession(sessionId);
      if (result === "unknown") {
        return c.json({ error: "unknown session" }, 404);
      }
      if (result === "nothing_running") {
        return c.json({ error: "nothing running" }, 409);
      }
      return c.body(null, 204);
    })
    .openapi(getSessionStatusRoute, async (c) => {
      const { sessionId } = c.req.valid("param");
      const status = await handlers.getSessionStatus(sessionId);
      if (!status) {
        return c.json({ error: "unknown session" }, 404);
      }
      return c.json(status, 200);
    });

export type AppType = ReturnType<typeof createAgentApp>;
