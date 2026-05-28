import { describe, expect, it, vi } from "vitest";

import { processStatusCommand } from "./status";
import type { SendReplyFn } from "./new";
import type { AgentStub } from "../agent-client";
import type { TopicContext } from "../process-topic-message";
import type { UserDO } from "../UserDO/index";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const fakeKV = (entries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(entries));
  return {
    get: async (key: string) => store.get(key) ?? null,
    _store: store,
  } as unknown as KVNamespace;
};

type UserDOStub = Pick<UserDO, "lookupSessionByTopic">;

const createFakeUserDO = (sessions: Record<string, string> = {}): UserDOStub => {
  // sessions maps "chatId:topicId" → sessionId
  return {
    lookupSessionByTopic: (chatId: number, topicId: number) =>
      sessions[`${chatId}:${topicId}`] ?? null,
  };
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

const fakeEnv = (kv: ReturnType<typeof fakeKV>, userDO?: UserDOStub, stub?: object): Env =>
  ({
    KV: kv,
    AGENT_CONTAINER: {
      getByName: () => stub ?? {},
    },
    USER_DO: {
      idFromName: () => ({ toString: () => "fake-id" }),
      get: () => userDO ?? createFakeUserDO(),
    },
  }) as unknown as Env;

const ctx: TopicContext = {
  telegramId: "111",
  chatId: 100,
  topicId: 200,
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
    const userDO = createFakeUserDO();
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processStatusCommand(ctx, fakeEnv(kv, userDO), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "No active session");
  });

  it("replies with model and context usage", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO({ "100:200": "sess-1" });
    const stub = fakeStub({ model: "anthropic/claude-sonnet-4-5-20250929", contextPercent: 42 });
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processStatusCommand(ctx, fakeEnv(kv, userDO, stub), sendReply);

    expect(sendReply).toHaveBeenCalledWith(
      100,
      200,
      "🤖 anthropic/claude-sonnet-4-5-20250929\n📊 42% context",
    );
  });

  it("handles null context percent", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO({ "100:200": "sess-1" });
    const stub = fakeStub({ model: "anthropic/claude-sonnet-4-5-20250929", contextPercent: null });
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processStatusCommand(ctx, fakeEnv(kv, userDO, stub), sendReply);

    expect(sendReply).toHaveBeenCalledWith(
      100,
      200,
      "🤖 anthropic/claude-sonnet-4-5-20250929\n📊 —% context",
    );
  });
});
