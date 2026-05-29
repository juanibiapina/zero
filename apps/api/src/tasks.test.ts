import { describe, expect, it } from "vitest";

import type { AgentStub } from "./agent-client";
import type { UserDO } from "./UserDO/index";
import { runTask } from "./tasks";
import type { Env } from "./types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type UserDOStub = Pick<UserDO, "recordTaskSession">;

const createFakeUserDO = (): UserDOStub & {
  _sessions: Map<string, { type: string; chatId: number; topicId: number }>;
} => {
  const sessions = new Map<string, { type: string; chatId: number; topicId: number }>();
  return {
    _sessions: sessions,
    recordTaskSession: (sessionId: string) => {
      sessions.set(sessionId, { type: "task", chatId: 0, topicId: 0 });
    },
  };
};

interface StubOpts {
  sessionId?: string;
  createFails?: boolean;
  sendFails?: boolean;
}

const fakeStub = (opts: StubOpts = {}): AgentStub => {
  const sessionId = opts.sessionId ?? "task-session-1";
  const live = new Set<string>();
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/sessions") {
        if (opts.createFails) return Response.json({ error: "no capacity" }, { status: 500 });
        live.add(sessionId);
        return Response.json({ sessionId });
      }
      const m = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (req.method === "POST" && m) {
        if (opts.sendFails) return Response.json({ error: "boom" }, { status: 500 });
        if (!live.has(m[1])) return Response.json({ error: "not found" }, { status: 404 });
        return new Response(null, { status: 202 });
      }
      return new Response("bad route", { status: 500 });
    },
  };
};

const fakeEnv = (userDO?: UserDOStub, stub?: object): Env =>
  ({
    AGENT_CONTAINER: {
      getByName: () => stub ?? {},
    },
    USER_DO: {
      idFromName: () => ({ toString: () => "fake-id" }),
      get: () => userDO ?? createFakeUserDO(),
    },
  }) as unknown as Env;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTask", () => {
  it("creates session, records task, and sends prompt", async () => {
    const userDO = createFakeUserDO();
    const stub = fakeStub({ sessionId: "task-1" });

    await runTask(fakeEnv(userDO, stub), "user_abc", "do something");

    expect(userDO._sessions.get("task-1")).toEqual({ type: "task", chatId: 0, topicId: 0 });
  });

  it("throws when session creation fails", async () => {
    const userDO = createFakeUserDO();
    const stub = fakeStub({ createFails: true });

    await expect(runTask(fakeEnv(userDO, stub), "user_abc", "do something"))
      .rejects.toThrow("Failed to create task session");

    expect(userDO._sessions.size).toBe(0);
  });

  it("throws when sending prompt fails", async () => {
    const userDO = createFakeUserDO();
    const stub = fakeStub({ sendFails: true });

    await expect(runTask(fakeEnv(userDO, stub), "user_abc", "do something"))
      .rejects.toThrow("Failed to send task prompt");
  });
});
