// Client for the agent-server running inside a Cloudflare Container (Durable
// Object). The DO stub is cached and only refreshed before a retry — per CF
// docs, "certain types of errors will break the Durable Object stub", so a
// fresh stub is needed after a transient failure (.retryable). Overloaded
// errors (.overloaded) are never retried.
//
// See: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/

import { hc } from "hono/client";
import type { AppType } from "@zero/agent-server/app";
import type { Env } from "./types";

export interface AgentStub {
  fetch: (req: Request) => Promise<Response>;
}

interface DOError {
  retryable?: boolean;
  overloaded?: boolean;
}

const isDOError = (err: unknown): err is Error & DOError =>
  err instanceof Error;

// ---------------------------------------------------------------------------
// Hono typed client
// ---------------------------------------------------------------------------

const clientFor = (stub: AgentStub) =>
  hc<AppType>("http://internal", {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      stub.fetch(new Request(input, init)),
  });

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type CreateSessionResult =
  | { kind: "ok"; sessionId: string }
  | { kind: "error"; status: number };

export type SendMessageResult =
  | { kind: "ok" }
  | { kind: "stale" }
  | { kind: "error"; status: number };

export type AbortSessionResult =
  | { kind: "aborted" }
  | { kind: "nothing_running" }
  | { kind: "unknown" }
  | { kind: "error"; status: number };

export type GetSessionStatusResult =
  | { kind: "ok"; model: string; contextPercent: number | null }
  | { kind: "unknown" }
  | { kind: "error"; status: number };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface AgentClient {
  createSession(): Promise<CreateSessionResult>;
  sendMessage(sessionId: string, text: string): Promise<SendMessageResult>;
  abortSession(sessionId: string): Promise<AbortSessionResult>;
  getSessionStatus(sessionId: string): Promise<GetSessionStatusResult>;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 20_000;

export function createAgentClient(env: Env, clerkUserId: string): AgentClient {
  let stub = env.AGENT_CONTAINER.getByName(clerkUserId);

  const refreshStub = () => {
    stub = env.AGENT_CONTAINER.getByName(clerkUserId);
  };

  async function withRetry<T>(fn: (s: AgentStub) => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn(stub);
      } catch (err: unknown) {
        if (isDOError(err) && err.retryable && attempt + 1 < MAX_ATTEMPTS) {
          const backoff = Math.min(
            MAX_BACKOFF_MS,
            BASE_BACKOFF_MS * Math.random() * Math.pow(2, attempt),
          );
          await new Promise((r) => setTimeout(r, backoff));
          attempt++;
          refreshStub();
          continue;
        }
        throw err;
      }
    }
  }

  return {
    createSession(): Promise<CreateSessionResult> {
      return withRetry(async (s) => {
        const res = await clientFor(s).sessions.$post();
        if (res.ok) {
          const body = await res.json();
          return { kind: "ok", sessionId: body.sessionId };
        }
        return { kind: "error", status: res.status };
      });
    },

    sendMessage(sessionId: string, text: string): Promise<SendMessageResult> {
      return withRetry(async (s) => {
        const res = await clientFor(s).sessions[":sessionId"].messages.$post({
          param: { sessionId },
          json: { text },
        });
        if (res.ok) return { kind: "ok" };
        if (res.status === 404) return { kind: "stale" };
        return { kind: "error", status: res.status };
      });
    },

    abortSession(sessionId: string): Promise<AbortSessionResult> {
      return withRetry(async (s) => {
        const res = await clientFor(s).sessions[":sessionId"].abort.$post({
          param: { sessionId },
        });
        const status = res.status as number;
        if (status === 204) return { kind: "aborted" };
        if (status === 404) return { kind: "unknown" };
        if (status === 409) return { kind: "nothing_running" };
        return { kind: "error", status };
      });
    },

    getSessionStatus(sessionId: string): Promise<GetSessionStatusResult> {
      return withRetry(async (s) => {
        const res = await clientFor(s).sessions[":sessionId"].status.$get({
          param: { sessionId },
        });
        const status = res.status as number;
        if (status === 200) {
          const body = (await res.json()) as { model: string; contextPercent: number | null };
          return { kind: "ok", model: body.model, contextPercent: body.contextPercent };
        }
        if (status === 404) return { kind: "unknown" };
        return { kind: "error", status };
      });
    },
  };
}
