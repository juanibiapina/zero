import { describe, expect, it, vi } from "vitest";

import { processNewCommand, type SendReplyFn } from "./new";
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

type UserDOStub = Pick<UserDO, "lookupSessionByTopic" | "forgetSession">;

const createFakeUserDO = (sessions: Record<string, string> = {}): UserDOStub & {
  _forgotten: string[];
} => {
  const byTopic = new Map(Object.entries(sessions));
  const forgotten: string[] = [];
  return {
    _forgotten: forgotten,
    lookupSessionByTopic: (chatId: number, topicId: number) =>
      byTopic.get(`${chatId}:${topicId}`) ?? null,
    forgetSession: (sessionId: string) => {
      forgotten.push(sessionId);
      for (const [k, v] of byTopic) {
        if (v === sessionId) byTopic.delete(k);
      }
    },
  };
};

const fakeEnv = (kv: ReturnType<typeof fakeKV>, userDO?: UserDOStub): Env =>
  ({
    KV: kv,
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

describe("processNewCommand", () => {
  it("drops unknown telegram ID", async () => {
    const kv = fakeKV(); // empty — no tg:111 entry
    const sendReply = vi.fn<SendReplyFn>();

    await processNewCommand(ctx, fakeEnv(kv), sendReply);

    expect(sendReply).not.toHaveBeenCalled();
  });

  it("replies even when no existing session", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processNewCommand(ctx, fakeEnv(kv, userDO), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "New session started");
    expect(userDO._forgotten).toEqual([]);
  });

  it("forgets existing session", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO({ "100:200": "old-session" });
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processNewCommand(ctx, fakeEnv(kv, userDO), sendReply);

    expect(userDO._forgotten).toEqual(["old-session"]);
    expect(sendReply).toHaveBeenCalledWith(100, 200, "New session started");
  });
});
