// Typed `hc` client over the agent-server's `AppType` (defined in
// packages/agent-server/src/contract.ts). `stub.fetch` is a DurableObject
// stub's fetch — the request never leaves the local Workers runtime, and
// the host portion is ignored. Errors surface as discriminated-union
// results so callers can branch with type safety; runtime throws
// propagate.

import { hc } from "hono/client";
import type { AppType } from "@zero/agent-server/app";

export interface AgentStub {
  fetch: (req: Request) => Promise<Response>;
}

const clientFor = (stub: AgentStub) =>
  hc<AppType>("http://internal", {
    // hc calls fetch with (input, init?); the DO stub only accepts a Request.
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      stub.fetch(new Request(input as RequestInfo, init)),
  });

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

export type AbortSessionResult =
  | { kind: "aborted" }
  | { kind: "nothing_running" }
  | { kind: "unknown" }
  | { kind: "error"; status: number };

export const abortSession = async (
  stub: AgentStub,
  sessionId: string,
): Promise<AbortSessionResult> => {
  const res = await clientFor(stub).sessions[":sessionId"].abort.$post({
    param: { sessionId },
  });
  const status = res.status as number;
  if (status === 204) return { kind: "aborted" };
  if (status === 404) return { kind: "unknown" };
  if (status === 409) return { kind: "nothing_running" };
  return { kind: "error", status };
};

export type GetSessionStatusResult =
  | { kind: "ok"; model: string; contextPercent: number | null }
  | { kind: "unknown" }
  | { kind: "error"; status: number };

export const getSessionStatus = async (
  stub: AgentStub,
  sessionId: string,
): Promise<GetSessionStatusResult> => {
  const res = await clientFor(stub).sessions[":sessionId"].status.$get({
    param: { sessionId },
  });
  const status = res.status as number;
  if (status === 200) {
    const body = (await res.json()) as { model: string; contextPercent: number | null };
    return { kind: "ok", model: body.model, contextPercent: body.contextPercent };
  }
  if (status === 404) return { kind: "unknown" };
  return { kind: "error", status };
};
