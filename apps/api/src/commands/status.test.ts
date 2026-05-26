import { describe, expect, it, vi } from "vitest";

import { processStatusCommand } from "./status";
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

/** Stub that responds to GET /sessions/{id}/status. */
const fakeStub = (
  status: { model: string; contextPercent: number | null } | null,
): AgentStub => ({
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/status")) {
      if (status) return Response.json(status);
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

describe("processStatusCommand", () => {
  it("drops unknown telegram ID", async () => {
    const kv = fakeKV();
    const sendReply = vi.fn<SendReplyFn>();

    await processStatusCommand(ctx, fakeEnv(kv), sendReply);

    expect(sendReply).not.toHaveBeenCalled();
  });

  it("replies when no session exists", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processStatusCommand(ctx, fakeEnv(kv), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "No active session");
  });

  it("replies with model and context usage", async () => {
    const kv = fakeKV({
      "tg:111": "user_abc",
      "topic:user_abc:100:200": "sess-1",
    });
    const stub = fakeStub({ model: "anthropic/claude-sonnet-4-5-20250929", contextPercent: 42 });
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processStatusCommand(ctx, fakeEnv(kv, stub), sendReply);

    expect(sendReply).toHaveBeenCalledWith(
      100,
      200,
      "🤖 anthropic/claude-sonnet-4-5-20250929\n📊 42% context",
    );
  });

  it("handles null context percent", async () => {
    const kv = fakeKV({
      "tg:111": "user_abc",
      "topic:user_abc:100:200": "sess-1",
    });
    const stub = fakeStub({ model: "anthropic/claude-sonnet-4-5-20250929", contextPercent: null });
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processStatusCommand(ctx, fakeEnv(kv, stub), sendReply);

    expect(sendReply).toHaveBeenCalledWith(
      100,
      200,
      "🤖 anthropic/claude-sonnet-4-5-20250929\n📊 —% context",
    );
  });
});
