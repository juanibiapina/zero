import { describe, expect, it, vi } from "vitest";

import { processNewCommand, type SendReplyFn } from "./new";
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
    /** Expose for assertions. */
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
};

const fakeEnv = (kv: ReturnType<typeof fakeKV>): Env =>
  ({ KV: kv }) as unknown as Env;

const ctx: TopicContext = {
  telegramId: "111",
  chatId: 100,
  messageThreadId: 200,
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
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processNewCommand(ctx, fakeEnv(kv), sendReply);

    expect(sendReply).toHaveBeenCalledWith(100, 200, "New session started");
  });

  it("forgets existing session", async () => {
    const kv = fakeKV({
      "tg:111": "user_abc",
      "topic:user_abc:100:200": "old-session",
      "session:old-session": JSON.stringify({
        clerkUserId: "user_abc",
        chatId: 100,
        messageThreadId: 200,
      }),
    });
    const sendReply = vi.fn<SendReplyFn>().mockResolvedValue(undefined);

    await processNewCommand(ctx, fakeEnv(kv), sendReply);

    expect(kv._store.has("topic:user_abc:100:200")).toBe(false);
    expect(kv._store.has("session:old-session")).toBe(false);
    expect(sendReply).toHaveBeenCalledWith(100, 200, "New session started");
  });
});
