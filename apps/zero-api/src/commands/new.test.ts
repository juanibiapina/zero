import { describe, expect, it, vi } from "vitest";

import { processNewCommand, type SendReplyFn } from "./new";
import type { TopicContext } from "../telegram/context";
import { fakeAccountNamespace } from "../telegram/test-support";
import type { UserDO } from "../UserDO/index";
import type { Env } from "../types";

const fakeKV = (entries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(entries));
  return {
    get: async (key: string) => store.get(key) ?? null,
    _store: store,
  } as unknown as KVNamespace;
};

type UserDOStub = Pick<UserDO, "resetConversation">;

const createFakeUserDO = (): UserDOStub & { _reset: Array<[number, number]> } => {
  const reset: Array<[number, number]> = [];
  return {
    _reset: reset,
    resetConversation: (chatId: number, topicId: number) => {
      reset.push([chatId, topicId]);
    },
  };
};

// An unlinked user now falls through to the account record, so every env needs
// one (see telegram/identity.ts).
const fakeEnv = (
  kv: ReturnType<typeof fakeKV>,
  userDO?: UserDOStub,
  owners: Record<string, string> = {},
): Env =>
  ({
    KV: kv,
    USER_DO: {
      idFromName: () => ({ toString: () => "fake-id" }),
      get: () => userDO ?? createFakeUserDO(),
    },
    TELEGRAM_ACCOUNT_DO: fakeAccountNamespace(owners).namespace,
  }) as unknown as Env;

const ctx: TopicContext = {
  telegramId: "111",
  chatId: 100,
  topicId: 200,
};

describe("processNewCommand", () => {
  it("drops unknown telegram ID", async () => {
    const kv = fakeKV(); // empty — no tg:111 entry
    const sendReply = vi.fn<SendReplyFn>();

    await processNewCommand(ctx, fakeEnv(kv), sendReply);

    expect(sendReply).not.toHaveBeenCalled();
  });

  it("resets the conversation and confirms", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processNewCommand(ctx, fakeEnv(kv, userDO), sendReply);

    expect(userDO._reset).toEqual([[100, 200]]);
    expect(sendReply).toHaveBeenCalledWith(100, 200, "Started a new conversation.");
  });

  // The link is fresh: the webhook colo's KV still serves the cached miss.
  it("resolves a just-linked user from the account record", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processNewCommand(
      ctx,
      fakeEnv(kv, userDO, { "111": "user_abc" }),
      sendReply,
    );

    expect(userDO._reset).toEqual([[100, 200]]);
  });
});
