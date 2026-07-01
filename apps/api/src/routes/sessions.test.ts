import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { UserDO } from "../UserDO/index";
import type { AgentStub } from "../agent-client";
import { createSessionRoutes } from "./sessions";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type UserDOStub = Pick<
  UserDO,
  | "createWebuiSession"
  | "listSessions"
  | "lookupSessionById"
  | "appendMessage"
  | "listMessages"
  | "markSessionActiveById"
  | "markSessionIdleById"
  | "forgetSession"
>;

const createFakeUserDO = () => {
  const sessions = new Map<string, { type: string; name: string | null; status: string; updatedAt: string | null }>();
  const messages = new Map<string, Array<{ id: number; role: string; text: string; createdAt: string }>>();
  let nextId = 1;

  return {
    _sessions: sessions,
    _messages: messages,
    createWebuiSession: (sessionId: string, name?: string) => {
      sessions.set(sessionId, { type: "webui", name: name ?? null, status: "idle", updatedAt: new Date().toISOString() });
    },
    listSessions: () =>
      [...sessions.entries()].map(([sessionId, s]) => ({
        sessionId,
        type: s.type,
        name: s.name,
        status: s.status,
        updatedAt: s.updatedAt,
      })),
    lookupSessionById: (sessionId: string) => {
      const s = sessions.get(sessionId);
      if (!s) return null;
      return { type: s.type, chatId: 0, topicId: 0, ...(s.name ? { name: s.name } : {}) };
    },
    appendMessage: (sessionId: string, role: "user" | "agent", text: string) => {
      const list = messages.get(sessionId) ?? [];
      list.push({ id: nextId++, role, text, createdAt: new Date().toISOString() });
      messages.set(sessionId, list);
    },
    listMessages: (sessionId: string, since?: number) => {
      const list = messages.get(sessionId) ?? [];
      const filtered = since !== undefined ? list.filter((m) => m.id > since) : list;
      return { messages: filtered, status: sessions.get(sessionId)?.status ?? null };
    },
    markSessionActiveById: async (sessionId: string) => {
      const s = sessions.get(sessionId);
      if (s) s.status = "active";
    },
    markSessionIdleById: (sessionId: string) => {
      const s = sessions.get(sessionId);
      if (s) s.status = "idle";
    },
    forgetSession: (sessionId: string) => {
      sessions.delete(sessionId);
      messages.delete(sessionId);
    },
  };
};

interface StubOpts {
  sessionId?: string;
  /** Session ids the container still recognizes; missing ones return 404 (stale). */
  liveSessions?: Set<string>;
}

const fakeStub = (opts: StubOpts = {}): AgentStub => {
  const sessionId = opts.sessionId ?? "container-1";
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

const fakeEnv = (userDO: UserDOStub, stub?: AgentStub): Env =>
  ({
    AGENT_CONTAINER: {
      getByName: () => stub ?? fakeStub(),
    },
    USER_DO: {
      idFromName: () => ({ toString: () => "fake-id" }),
      get: () => userDO,
    },
  }) as unknown as Env;

const readJson = async <T>(res: { json: () => Promise<unknown> }): Promise<T> => (await res.json()) as T;

const buildApp = (env: Env, userId: string) => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createSessionRoutes());
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/sessions", () => {
  it("creates a container session and records a webui row", async () => {
    const userDO = createFakeUserDO();
    const stub = fakeStub({ sessionId: "sess-1" });
    const app = buildApp(fakeEnv(userDO, stub), "user_abc");

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My chat" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: "sess-1" });
    expect(userDO._sessions.get("sess-1")).toMatchObject({ type: "webui", name: "My chat" });
  });
});

describe("GET /api/sessions", () => {
  it("lists the caller's sessions", async () => {
    const userDO = createFakeUserDO();
    userDO.createWebuiSession("sess-1", "First");
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/sessions");

    expect(res.status).toBe(200);
    const body = await readJson<{ sessions: Array<{ sessionId: string; name: string | null; type: string }> }>(res);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ sessionId: "sess-1", name: "First", type: "webui" });
  });
});

describe("POST /api/sessions/{sessionId}/messages", () => {
  it("appends the user message, forwards, and marks active", async () => {
    const userDO = createFakeUserDO();
    userDO.createWebuiSession("sess-1");
    const stub = fakeStub({ liveSessions: new Set(["sess-1"]) });
    const app = buildApp(fakeEnv(userDO, stub), "user_abc");

    const res = await app.request("/api/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sessionId: "sess-1" });
    expect(userDO._messages.get("sess-1")).toMatchObject([{ role: "user", text: "hello" }]);
    expect(userDO._sessions.get("sess-1")?.status).toBe("active");
  });

  it("returns 404 for an unknown session", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/sessions/nope/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });

    expect(res.status).toBe(404);
  });

  it("mints a fresh session on stale and returns its id", async () => {
    const userDO = createFakeUserDO();
    userDO.createWebuiSession("stale-1", "Chat");
    // Container does not recognize "stale-1"; new sessions get "fresh-1".
    const stub = fakeStub({ sessionId: "fresh-1", liveSessions: new Set<string>() });
    const app = buildApp(fakeEnv(userDO, stub), "user_abc");

    const res = await app.request("/api/sessions/stale-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sessionId: "fresh-1" });
    expect(userDO._sessions.has("stale-1")).toBe(false);
    expect(userDO._sessions.get("fresh-1")).toMatchObject({ type: "webui", name: "Chat" });
    expect(userDO._messages.get("fresh-1")).toMatchObject([{ role: "user", text: "hello" }]);
  });
});

describe("GET /api/sessions/{sessionId}/messages", () => {
  it("returns messages and status, honoring the since cursor", async () => {
    const userDO = createFakeUserDO();
    userDO.createWebuiSession("sess-1");
    userDO.appendMessage("sess-1", "user", "one");
    userDO.appendMessage("sess-1", "agent", "two");
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const all = await app.request("/api/sessions/sess-1/messages");
    const allBody = await readJson<{ messages: Array<{ id: number; text: string }>; status: string | null }>(all);
    expect(allBody.messages.map((m) => m.text)).toEqual(["one", "two"]);
    expect(allBody.status).toBe("idle");

    const since = allBody.messages[0].id;
    const rest = await app.request(`/api/sessions/sess-1/messages?since=${since}`);
    const restBody = await readJson<{ messages: Array<{ text: string }> }>(rest);
    expect(restBody.messages.map((m) => m.text)).toEqual(["two"]);
  });

  it("returns 404 for an unknown session", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(userDO), "user_abc");

    const res = await app.request("/api/sessions/nope/messages");
    expect(res.status).toBe(404);
  });
});
