import { describe, expect, it, vi } from "vitest";

import { processAbortCommand } from "./abort";
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

const createFakeUserDO = (sessions: Record<string, string> = {}): UserDOStub => ({
  lookupSessionByTopic: (chatId: number, topicId: number) =>
    sessions[`${chatId}:${topicId}`] ?? null,
});

/** Stub that responds to POST /sessions/{id}/abort. */
const fakeStub = (
  result: "aborted" | "nothing_running",
): AgentStub => ({
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/abort")) {
      if (result === "aborted") return new Response(null, { status: 204 });
      return Response.json({ error: "nothing running" }, { status: 409 });
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

describe("processAbortCommand", () => {
  it("drops unknown telegram ID", async () => {
    const kv = fakeKV();
    const sendReply = vi.fn<SendReplyFn>();

    await processAbortCommand(ctx, fakeEnv(kv), sendReply);

    expect(sendReply).not.toHaveBeenCalled();
  });

  it("replies when no session exists", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processAbortCommand(ctx, fakeEnv(kv, userDO), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "No active session");
  });

  it("replies when abort succeeds", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO({ "100:200": "sess-1" });
    const stub = fakeStub("aborted");
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processAbortCommand(ctx, fakeEnv(kv, userDO, stub), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "Aborted");
  });

  it("replies when nothing is running", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO({ "100:200": "sess-1" });
    const stub = fakeStub("nothing_running");
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processAbortCommand(ctx, fakeEnv(kv, userDO, stub), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "Nothing running");
  });
});
