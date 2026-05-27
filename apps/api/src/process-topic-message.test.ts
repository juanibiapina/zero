import { describe, expect, it, vi } from "vitest";

import type { AgentStub } from "./agent-client";
import type { TopicMessage } from "./process-topic-message";
import { processTopicMessage } from "./process-topic-message";
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
    /** Expose for assertions. */
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
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

const fakeEnv = (kv: ReturnType<typeof fakeKV>, stub?: object): Env =>
  ({
    KV: kv,
    AGENT_CONTAINER: {
      getByName: () => stub ?? {},
    },
  }) as unknown as Env;

const topic: TopicMessage = {
  telegramId: "111",
  chatId: 100,
  messageThreadId: 200,
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
    const stub = fakeStub();
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, stub), sendTyping);

    expect(sendTyping).toHaveBeenCalledWith(100, 200);
  });

  it("typing failure does not block forwarding", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const live = new Set<string>();
    const stub = fakeStub({ liveSessions: live });
    const sendTyping = vi.fn().mockRejectedValue(new Error("network"));

    await processTopicMessage(topic, fakeEnv(kv, stub), sendTyping);

    // Message was still forwarded despite typing failure:
    // the stub created a session and it's in the live set.
    expect(live.size).toBe(1);
  });

  it("reuses existing session", async () => {
    const kv = fakeKV({
      "tg:111": "user_abc",
      "topic:user_abc:100:200": "existing-session",
    });
    const live = new Set(["existing-session"]);
    const stub = fakeStub({ liveSessions: live });
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, stub), sendTyping);

    // No new session was created — still just the one we seeded.
    expect(live.size).toBe(1);
    expect(live.has("existing-session")).toBe(true);
  });

  it("creates and records new session", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const stub = fakeStub({ sessionId: "new-sess" });
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, stub), sendTyping);

    // Both KV directions written by sessions.ts:
    expect(kv._store.get("topic:user_abc:100:200")).toBe("new-sess");
    expect(kv._store.get("session:new-sess")).toBeDefined();
  });

  it("retries on stale session", async () => {
    // Pre-seed a session that the container no longer knows about.
    const kv = fakeKV({
      "tg:111": "user_abc",
      "topic:user_abc:100:200": "stale-sess",
      "session:stale-sess": JSON.stringify({
        clerkUserId: "user_abc",
        chatId: 100,
        messageThreadId: 200,
      }),
    });
    // The container only recognises sessions it creates — "stale-sess" is
    // not in the live set so sendMessage returns 404 (stale).
    const live = new Set<string>();
    const stub = fakeStub({ sessionId: "fresh-sess", liveSessions: live });
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, stub), sendTyping);

    // Stale entries cleaned, fresh session recorded:
    expect(kv._store.has("session:stale-sess")).toBe(false);
    expect(kv._store.get("topic:user_abc:100:200")).toBe("fresh-sess");
    expect(kv._store.get("session:fresh-sess")).toBeDefined();
  });

  it("handles container error without throwing", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
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
    await processTopicMessage(topic, fakeEnv(kv, stub), sendTyping);
  });

  it("handles session creation failure without throwing", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    // Stub that rejects session creation.
    const stub: AgentStub = {
      fetch: async () => Response.json({ error: "no capacity" }, { status: 500 }),
    };
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await processTopicMessage(topic, fakeEnv(kv, stub), sendTyping);

    // No session recorded.
    expect(kv._store.has("topic:user_abc:100:200")).toBe(false);
  });

  it("catches thrown DO errors without crashing", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    // Stub that throws (simulates DO infrastructure error after retries exhausted).
    const stub: AgentStub = {
      fetch: async () => {
        throw new Error("Durable Object reset because its code was updated");
      },
    };
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    // Should not throw — safety net catches it.
    await processTopicMessage(topic, fakeEnv(kv, stub), sendTyping);
  });
});
