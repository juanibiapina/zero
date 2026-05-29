import { describe, expect, it, vi } from "vitest";

import type { AgentStub } from "./agent-client";
import type { TopicMessage } from "./process-topic-message";
import { processTopicMessage } from "./process-topic-message";
import type { UserDO } from "./UserDO/index";
import type { Env } from "./types";

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

type UserDOStub = Pick<UserDO, "lookupSessionByTopic" | "lookupSessionById" | "recordSession" | "recordTaskSession" | "forgetSession">;

const createFakeUserDO = (): UserDOStub & {
  _sessionByTopic: (chatId: number, topicId: number) => string | null;
  _sessionById: (sessionId: string) => { type: string; chatId: number; topicId: number } | null;
} => {
  const byTopic = new Map<string, string>();
  const byId = new Map<string, { type: string; chatId: number; topicId: number }>();
  const key = (chatId: number, topicId: number) => `${chatId}:${topicId}`;

  return {
    _sessionByTopic: (chatId, topicId) => byTopic.get(key(chatId, topicId)) ?? null,
    _sessionById: (sessionId) => byId.get(sessionId) ?? null,
    lookupSessionByTopic: (chatId: number, topicId: number) =>
      byTopic.get(key(chatId, topicId)) ?? null,
    lookupSessionById: (sessionId: string) =>
      byId.get(sessionId) ?? null,
    recordSession: (chatId: number, topicId: number, sessionId: string) => {
      const old = byTopic.get(key(chatId, topicId));
      if (old) byId.delete(old);
      byTopic.set(key(chatId, topicId), sessionId);
      byId.set(sessionId, { type: "telegram", chatId, topicId });
    },
    recordTaskSession: (sessionId: string) => {
      byId.set(sessionId, { type: "task", chatId: 0, topicId: 0 });
    },
    forgetSession: (sessionId: string) => {
      const record = byId.get(sessionId);
      if (record) byTopic.delete(key(record.chatId, record.topicId));
      byId.delete(sessionId);
    },
  };
};

interface StubOpts {
  sessionId?: string;
  /** Set of session IDs the stub considers live (messages return 202). */
  liveSessions?: Set<string>;
}

const fakeStub = (opts: StubOpts = {}): AgentStub => {
  const sessionId = opts.sessionId ?? "session-1";
  const live = opts.liveSessions ?? new Set<string>();
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/sessions") {
        live.add(sessionId);
        return Response.json({ sessionId });
      }
      const m = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (req.method === "POST" && m) {
        if (!live.has(m[1])) return Response.json({ error: "not found" }, { status: 404 });
        return new Response(null, { status: 202 });
      }
      return new Response("bad route", { status: 500 });
    },
  };
};

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

const topic: TopicMessage = {
  telegramId: "111",
  chatId: 100,
  topicId: 200,
  text: "hello",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processTopicMessage", () => {
  it("drops unknown telegram ID", async () => {
    const kv = fakeKV(); // empty — no tg:111 entry
    const sendTyping = vi.fn();

    await processTopicMessage(topic, fakeEnv(kv), sendTyping);

    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("sends typing after user identified", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    const stub = fakeStub();
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, userDO, stub), sendTyping);

    expect(sendTyping).toHaveBeenCalledWith(100, 200);
  });

  it("typing failure does not block forwarding", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    const live = new Set<string>();
    const stub = fakeStub({ liveSessions: live });
    const sendTyping = vi.fn().mockRejectedValue(new Error("network"));

    await processTopicMessage(topic, fakeEnv(kv, userDO, stub), sendTyping);

    // Message was still forwarded despite typing failure:
    // the stub created a session and it's in the live set.
    expect(live.size).toBe(1);
  });

  it("reuses existing session", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    // Pre-seed a session in the DO
    userDO.recordSession(100, 200, "existing-session");
    const live = new Set(["existing-session"]);
    const stub = fakeStub({ liveSessions: live });
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, userDO, stub), sendTyping);

    // No new session was created — still just the one we seeded.
    expect(live.size).toBe(1);
    expect(live.has("existing-session")).toBe(true);
  });

  it("creates and records new session", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    const stub = fakeStub({ sessionId: "new-sess" });
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, userDO, stub), sendTyping);

    // Session recorded in the DO:
    expect(userDO._sessionByTopic(100, 200)).toBe("new-sess");
    expect(userDO._sessionById("new-sess")).toEqual({ type: "telegram", chatId: 100, topicId: 200 });
  });

  it("creates session for DM (topicId=0)", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    const stub = fakeStub({ sessionId: "dm-sess" });
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    const dm = { ...topic, topicId: 0 };
    await processTopicMessage(dm, fakeEnv(kv, userDO, stub), sendTyping);

    expect(userDO._sessionByTopic(100, 0)).toBe("dm-sess");
    expect(userDO._sessionById("dm-sess")).toEqual({ type: "telegram", chatId: 100, topicId: 0 });
    expect(sendTyping).toHaveBeenCalledWith(100, 0);
  });

  it("retries on stale session", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    // Pre-seed a session that the container no longer knows about.
    userDO.recordSession(100, 200, "stale-sess");
    // The container only recognises sessions it creates — "stale-sess" is
    // not in the live set so sendMessage returns 404 (stale).
    const live = new Set<string>();
    const stub = fakeStub({ sessionId: "fresh-sess", liveSessions: live });
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, userDO, stub), sendTyping);

    // Stale entry cleaned, fresh session recorded:
    expect(userDO._sessionById("stale-sess")).toBeNull();
    expect(userDO._sessionByTopic(100, 200)).toBe("fresh-sess");
    expect(userDO._sessionById("fresh-sess")).toEqual({ type: "telegram", chatId: 100, topicId: 200 });
  });

  it("handles container error without throwing", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    // Stub that always returns 500 for messages.
    const stub: AgentStub = {
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/sessions") {
          return Response.json({ sessionId: "s1" });
        }
        return Response.json({ error: "boom" }, { status: 500 });
      },
    };
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    // Should not throw.
    await processTopicMessage(topic, fakeEnv(kv, userDO, stub), sendTyping);
  });

  it("handles session creation failure without throwing", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    // Stub that rejects session creation.
    const stub: AgentStub = {
      fetch: async () => Response.json({ error: "no capacity" }, { status: 500 }),
    };
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, userDO, stub), sendTyping);

    // No session recorded.
    expect(userDO._sessionByTopic(100, 200)).toBeNull();
  });

  it("catches thrown DO errors without crashing", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO();
    // Stub that throws (simulates DO infrastructure error after retries exhausted).
    const stub: AgentStub = {
      fetch: async () => {
        throw new Error("Durable Object reset because its code was updated");
      },
    };
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    // Should not throw — safety net catches it.
    await processTopicMessage(topic, fakeEnv(kv, userDO, stub), sendTyping);
  });
});
