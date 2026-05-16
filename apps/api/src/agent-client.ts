/**
 * ============================================================================
 * Agent-server client
 * ============================================================================
 *
 * Typed client for the `@zero/agent-server` HTTP contract. The contract
 * itself (URLs, methods, request/response shapes) is defined exactly once
 * in `packages/agent-server/src/contract.ts`; this module derives a typed
 * `hc` client from the chain-inferred `AppType` so we never hand-encode
 * URL strings or response shapes on the caller side.
 *
 * The "fetch" is a Durable Object stub's `fetch` (the request never
 * leaves the local Workers runtime). The base URL `http://internal` is a
 * placeholder satisfying URL parsing — the stub ignores the host.
 *
 * Errors are surfaced as discriminated-union results so the route's
 * pipeline can branch with full type safety:
 *
 *   createSession  → { ok, sessionId } | { error, status }
 *   sendMessage    → ok | stale (=container 404, recoverable) | error
 *
 * Network/runtime throws propagate; the route never expects them under
 * normal operation (DurableObjectStub.fetch doesn't fail mid-flight).
 */

import { hc } from "hono/client";
import type { AppType } from "@zero/agent-server/app";

export interface AgentStub {
  fetch: (req: Request) => Promise<Response>;
}

const clientFor = (stub: AgentStub) =>
  hc<AppType>("http://internal", {
    // hc calls fetch with (input, init?); the DO stub only accepts a
    // Request, so always construct one before delegating.
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      stub.fetch(new Request(input as RequestInfo, init)),
  });

// ── createSession ───────────────────────────────────────────────────────

export type CreateSessionResult =
  | { kind: "ok"; sessionId: string }
  | { kind: "error"; status: number };

export const createSession = async (
  stub: AgentStub,
): Promise<CreateSessionResult> => {
  const res = await clientFor(stub).sessions.$post();
  if (res.ok) {
    const body = await res.json();
    return { kind: "ok", sessionId: body.sessionId };
  }
  return { kind: "error", status: res.status };
};

// ── sendMessage ─────────────────────────────────────────────────────────

export type SendMessageResult =
  | { kind: "ok" }
  | { kind: "stale" }
  | { kind: "error"; status: number };

export const sendMessage = async (
  stub: AgentStub,
  sessionId: string,
  text: string,
): Promise<SendMessageResult> => {
  const res = await clientFor(stub).sessions[":sessionId"].messages.$post({
    param: { sessionId },
    json: { text },
  });
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) return { kind: "stale" };
  return { kind: "error", status: res.status };
};
