// Client for the agent-server running inside a Cloudflare Container (Durable
// Object). Retry / backoff logic for transient DO stub errors is provided by
// the shared helpers in do/retry.

import { hc } from "hono/client";
import type { AppType } from "@zero/agent-server/app";
import type { Env } from "./types";
import { isDOError, doBackoff, MAX_ATTEMPTS } from "./do/retry";

export interface AgentStub {
  fetch: (req: Request) => Promise<Response>;
}

// An attachment to forward to the container: raw bytes plus metadata.
export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  data: ArrayBuffer | Uint8Array;
}

// Base64-encode bytes in chunks to avoid blowing the argument stack on
// large (up to ~20MB) attachments.
const toBase64 = (data: ArrayBuffer | Uint8Array): string => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

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

export type ImportNotesResult =
  | { kind: "ok"; filesExtracted: number }
  | { kind: "error"; status: number };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface AgentClient {
  createSession(): Promise<CreateSessionResult>;
  sendMessage(sessionId: string, text: string, attachments?: OutgoingAttachment[]): Promise<SendMessageResult>;
  abortSession(sessionId: string): Promise<AbortSessionResult>;
  getSessionStatus(sessionId: string): Promise<GetSessionStatusResult>;
  importNotes(data: ArrayBuffer | Uint8Array): Promise<ImportNotesResult>;
}

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
          await doBackoff(attempt);
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

    sendMessage(sessionId: string, text: string, attachments?: OutgoingAttachment[]): Promise<SendMessageResult> {
      const encoded = attachments?.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        dataBase64: toBase64(a.data),
      }));
      return withRetry(async (s) => {
        const res = await clientFor(s).sessions[":sessionId"].messages.$post({
          param: { sessionId },
          json: { text, ...(encoded && encoded.length > 0 && { attachments: encoded }) },
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

    importNotes(data: ArrayBuffer | Uint8Array): Promise<ImportNotesResult> {
      const dataBase64 = toBase64(data);
      return withRetry(async (s) => {
        const res = await clientFor(s)["import-notes"].$post({
          json: { dataBase64 },
        });
        const status = res.status as number;
        if (status === 200) {
          const body = (await res.json()) as { filesExtracted: number };
          return { kind: "ok", filesExtracted: body.filesExtracted };
        }
        return { kind: "error", status };
      });
    },
  };
}
