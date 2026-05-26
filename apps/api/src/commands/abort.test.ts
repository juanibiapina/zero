import { describe, expect, it, vi } from "vitest";

import { processAbortCommand } from "./abort";
import type { SendReplyFn } from "./new";
import type { AgentStub } from "../agent-client";
import type { TopicContext } from "../process-topic-message";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const fakeKV = (entries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(entries));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
};

/** Stub that responds to POST /sessions/{id}/abort with the given status. */
const fakeStub = (abortStatus: number): AgentStub => ({
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/abort")) {
      if (abortStatus === 204) return new Response(null, { status: 204 });
      if (abortStatus === 409) return Response.json({ error: "nothing running" }, { status: 409 });
      return Response.json({ error: "unknown session" }, { status: 404 });
    }
    return new Response("bad route", { status: 500 });
  },
});

const fakeEnv = (kv: ReturnType<typeof fakeKV>, stub?: object): Env =>
  ({
    KV: kv,
    AGENT_CONTAINER: {
      getByName: () => stub ?? {},
    },
  }) as unknown as Env;

const ctx: TopicContext = {
  telegramId: "111",
  chatId: 100,
  messageThreadId: 200,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processAbortCommand", () => {
  it("drops unknown telegram ID", async () => {
    const kv = fakeKV();
    const sendReply = vi.fn<SendReplyFn>();

    await processAbortCommand(ctx, fakeEnv(kv), sendReply);

    expect(sendReply).not.toHaveBeenCalled();
  });

  it("replies when no session exists", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processAbortCommand(ctx, fakeEnv(kv), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "No active session");
  });

  it("replies when abort succeeds", async () => {
    const kv = fakeKV({
      "tg:111": "user_abc",
      "topic:user_abc:100:200": "sess-1",
    });
    const stub = fakeStub(204);
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processAbortCommand(ctx, fakeEnv(kv, stub), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "Aborted");
  });

  it("replies when nothing is running", async () => {
    const kv = fakeKV({
      "tg:111": "user_abc",
      "topic:user_abc:100:200": "sess-1",
    });
    const stub = fakeStub(409);
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processAbortCommand(ctx, fakeEnv(kv, stub), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "Nothing running");
  });
});
