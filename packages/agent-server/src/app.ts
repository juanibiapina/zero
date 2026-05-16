/**
 * ============================================================================
 * agent-server app
 * ============================================================================
 *
 * Wires the contract routes from `contract.ts` to handlers supplied by the
 * caller. The handlers are injected so this module has no dependency on
 * pi, the session bridge, or anything stateful — `index.ts` owns those.
 *
 * The exported `AppType` is the chain-inferred OpenAPIHono type used by
 * the worker's `hc<AppType>` client. Keep the `.openapi(...)` chain
 * inline (no intermediate variable) so TypeScript can build the full
 * route map on the return type.
 */

import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";

import { createSessionRoute, sendMessageRoute } from "./contract.js";
import { fmtErr, log, logError } from "./log.js";

export interface AgentHandlers {
  /** Create a session with the given (server-generated) id. */
  createSession: (sessionId: string) => Promise<void>;
  /** Send a prompt to an existing session. Returns false if unknown. */
  promptSession: (sessionId: string, text: string) => Promise<boolean>;
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
      const { text } = c.req.valid("json");
      const accepted = await handlers.promptSession(sessionId, text);
      if (!accepted) {
        return c.json({ error: "unknown session" }, 404);
      }
      return c.body(null, 202);
    });

/** The chain-inferred app type; consumed by the worker's `hc<AppType>` client. */
export type AppType = ReturnType<typeof createAgentApp>;
