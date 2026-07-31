import { describe, expect, it, vi } from "vitest";

import {
  ALREADY_STARTED_REPLY,
  SIGN_IN_REPLY,
  processStartCommand,
} from "./start";
import type { SendReplyFn } from "./new";
import type { TopicContext } from "../telegram/context";
import type { Env } from "../types";

const fakeKV = (entries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(entries));
  return { get: async (key: string) => store.get(key) ?? null } as unknown as KVNamespace;
};

const createFakeUserDO = (enqueued: boolean) => {
  const calls: unknown[][] = [];
  return {
    _calls: calls,
    startConversation: async (...args: unknown[]) => {
      calls.push(args);
      return enqueued;
    },
  };
};

const fakeEnv = (kv: KVNamespace, userDO?: unknown): Env =>
  ({
    KV: kv,
    USER_DO: {
      idFromName: () => ({ toString: () => "fake-id" }),
      get: () => userDO,
    },
  }) as unknown as Env;

const ctx: TopicContext = { telegramId: "111", chatId: 100, topicId: 0 };

const makeDeps = () => ({
  sendReply: vi.fn<SendReplyFn>().mockResolvedValue(undefined),
  sendTyping: vi.fn<(chatId: number, topicId: number) => Promise<void>>().mockResolvedValue(undefined),
});

describe("processStartCommand", () => {
  it("tells an unlinked user where to sign in and enqueues nothing", async () => {
    const deps = makeDeps();
    const userDO = createFakeUserDO(true);

    await processStartCommand(ctx, fakeEnv(fakeKV(), userDO), deps, "42", "private");

    expect(deps.sendReply).toHaveBeenCalledWith(100, 0, SIGN_IN_REPLY);
    expect(userDO._calls).toEqual([]);
  });

  it("on first contact starts a turn and shows typing, with no canned reply", async () => {
    const deps = makeDeps();
    const userDO = createFakeUserDO(true);

    await processStartCommand(
      ctx,
      fakeEnv(fakeKV({ "tg:111": "user_abc" }), userDO),
      deps,
      "42",
      "private",
    );

    expect(userDO._calls).toEqual([["user_abc", 100, 0, "start:42"]]);
    expect(deps.sendTyping).toHaveBeenCalledWith(100, 0);
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it("acks a returning user without running a turn", async () => {
    const deps = makeDeps();
    const userDO = createFakeUserDO(false);

    await processStartCommand(
      ctx,
      fakeEnv(fakeKV({ "tg:111": "user_abc" }), userDO),
      deps,
      "43",
      "private",
    );

    expect(deps.sendReply).toHaveBeenCalledWith(100, 0, ALREADY_STARTED_REPLY);
    expect(deps.sendTyping).not.toHaveBeenCalled();
  });
});
