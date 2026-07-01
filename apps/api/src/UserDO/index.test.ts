import { describe, expect, it } from "vitest";

import type { UserDO } from "./index";

// ---------------------------------------------------------------------------
// Fake UserDO stub — implements the same public RPC interface
// ---------------------------------------------------------------------------

type UserDOStub = Pick<UserDO, "getTelegramId" | "linkTelegram" | "unlinkTelegram" | "lookupSessionByTopic" | "lookupSessionById" | "recordSession" | "recordTaskSession" | "createWebuiSession" | "listSessions" | "appendMessage" | "listMessages" | "markSessionActiveById" | "markSessionIdleById" | "forgetSession" | "getSettings" | "updateSettings" | "setGoogleOnboardingStatus">;

const createFakeUserDO = (): UserDOStub => {
  let telegramId: string | null = null;
  const sessionsByTopic = new Map<string, string>();
  const sessionsBySessionId = new Map<string, { type: string; chatId: number; topicId: number; name?: string; status: string; updatedAt: string | null }>();
  const messagesBySession = new Map<string, Array<{ id: number; role: string; text: string; createdAt: string }>>();
  let nextMessageId = 1;
  let onboardingSeen = false;
  let googleOnboardingStatus: string | null = null;
  let createdAt: string | null = null;
  let hasRow = false;

  const topicKey = (chatId: number, topicId: number) => `${chatId}:${topicId}`;

  return {
    getTelegramId: () => telegramId,
    linkTelegram: (id: string) => {
      const previous = telegramId;
      telegramId = id;
      return { previous };
    },
    unlinkTelegram: () => {
      const removed = telegramId;
      telegramId = null;
      return { removed };
    },
    lookupSessionByTopic: (chatId: number, topicId: number) => {
      return sessionsByTopic.get(topicKey(chatId, topicId)) ?? null;
    },
    lookupSessionById: (sessionId: string) => {
      const r = sessionsBySessionId.get(sessionId);
      if (!r) return null;
      return { type: r.type, chatId: r.chatId, topicId: r.topicId, ...(r.name ? { name: r.name } : {}) };
    },
    recordSession: (chatId: number, topicId: number, sessionId: string) => {
      const oldSessionId = sessionsByTopic.get(topicKey(chatId, topicId));
      if (oldSessionId) sessionsBySessionId.delete(oldSessionId);
      sessionsByTopic.set(topicKey(chatId, topicId), sessionId);
      sessionsBySessionId.set(sessionId, { type: "telegram", chatId, topicId, status: "idle", updatedAt: null });
    },
    recordTaskSession: (sessionId: string, name?: string) => {
      sessionsBySessionId.set(sessionId, { type: "task", chatId: 0, topicId: 0, status: "idle", updatedAt: null, ...(name ? { name } : {}) });
    },
    createWebuiSession: (sessionId: string, name?: string) => {
      sessionsBySessionId.set(sessionId, { type: "webui", chatId: 0, topicId: 0, status: "idle", updatedAt: new Date().toISOString(), ...(name ? { name } : {}) });
    },
    listSessions: () =>
      [...sessionsBySessionId.entries()].map(([sessionId, s]) => ({
        sessionId,
        type: s.type,
        name: s.name ?? null,
        status: s.status,
        updatedAt: s.updatedAt,
      })),
    appendMessage: (sessionId: string, role: "user" | "agent", text: string) => {
      const list = messagesBySession.get(sessionId) ?? [];
      list.push({ id: nextMessageId++, role, text, createdAt: new Date().toISOString() });
      messagesBySession.set(sessionId, list);
      const s = sessionsBySessionId.get(sessionId);
      if (s) s.updatedAt = new Date().toISOString();
    },
    listMessages: (sessionId: string, since?: number) => {
      const list = messagesBySession.get(sessionId) ?? [];
      const filtered = since !== undefined ? list.filter((m) => m.id > since) : list;
      return { messages: filtered, status: sessionsBySessionId.get(sessionId)?.status ?? null };
    },
    markSessionActiveById: async (sessionId: string) => {
      const s = sessionsBySessionId.get(sessionId);
      if (s) s.status = "active";
    },
    markSessionIdleById: (sessionId: string) => {
      const s = sessionsBySessionId.get(sessionId);
      if (s) s.status = "idle";
    },
    forgetSession: (sessionId: string) => {
      const record = sessionsBySessionId.get(sessionId);
      if (record) {
        sessionsByTopic.delete(topicKey(record.chatId, record.topicId));
      }
      sessionsBySessionId.delete(sessionId);
    },
    getSettings: () => {
      if (!hasRow) {
        createdAt = new Date().toISOString();
        hasRow = true;
        return { onboardingSeen, googleOnboardingStatus, createdAt, isNewUser: true };
      }
      return { onboardingSeen, googleOnboardingStatus, createdAt, isNewUser: false };
    },
    updateSettings: (patch: { onboardingSeen?: boolean }) => {
      if (patch.onboardingSeen !== undefined) onboardingSeen = patch.onboardingSeen;
    },
    setGoogleOnboardingStatus: (status: string) => {
      googleOnboardingStatus = status;
    },
  };
};
// ---------------------------------------------------------------------------
// Tests — verify the fake behaves like a correct UserDO
// ---------------------------------------------------------------------------

describe("UserDO contract", () => {
  it("getTelegramId returns null when no link exists", () => {
    const userDO = createFakeUserDO();
    expect(userDO.getTelegramId()).toBeNull();
  });

  it("linkTelegram stores the id and returns no previous", () => {
    const userDO = createFakeUserDO();
    const result = userDO.linkTelegram("12345");
    expect(result).toEqual({ previous: null });
    expect(userDO.getTelegramId()).toBe("12345");
  });

  it("linkTelegram returns the previous id when re-linking", () => {
    const userDO = createFakeUserDO();
    userDO.linkTelegram("111");
    const result = userDO.linkTelegram("222");
    expect(result).toEqual({ previous: "111" });
    expect(userDO.getTelegramId()).toBe("222");
  });

  it("unlinkTelegram clears the id and returns the removed value", () => {
    const userDO = createFakeUserDO();
    userDO.linkTelegram("12345");
    const result = userDO.unlinkTelegram();
    expect(result).toEqual({ removed: "12345" });
    expect(userDO.getTelegramId()).toBeNull();
  });

  it("unlinkTelegram returns null when nothing linked", () => {
    const userDO = createFakeUserDO();
    const result = userDO.unlinkTelegram();
    expect(result).toEqual({ removed: null });
  });
});

describe("UserDO sessions contract", () => {
  it("lookupSessionByTopic returns null when no session exists", () => {
    const userDO = createFakeUserDO();
    expect(userDO.lookupSessionByTopic(100, 200)).toBeNull();
  });

  it("recordSession makes session retrievable by topic", () => {
    const userDO = createFakeUserDO();
    userDO.recordSession(100, 200, "sess-1");
    expect(userDO.lookupSessionByTopic(100, 200)).toBe("sess-1");
  });

  it("recordSession makes session retrievable by id", () => {
    const userDO = createFakeUserDO();
    userDO.recordSession(100, 200, "sess-1");
    expect(userDO.lookupSessionById("sess-1")).toEqual({ type: "telegram", chatId: 100, topicId: 200 });
  });

  it("lookupSessionById returns null for unknown session", () => {
    const userDO = createFakeUserDO();
    expect(userDO.lookupSessionById("nonexistent")).toBeNull();
  });

  it("forgetSession removes both lookups", () => {
    const userDO = createFakeUserDO();
    userDO.recordSession(100, 200, "sess-1");
    userDO.forgetSession("sess-1");
    expect(userDO.lookupSessionByTopic(100, 200)).toBeNull();
    expect(userDO.lookupSessionById("sess-1")).toBeNull();
  });

  it("forgetSession is safe for unknown session", () => {
    const userDO = createFakeUserDO();
    userDO.forgetSession("nonexistent");
  });

  it("recordSession overwrites existing topic mapping", () => {
    const userDO = createFakeUserDO();
    userDO.recordSession(100, 200, "sess-1");
    userDO.recordSession(100, 200, "sess-2");
    expect(userDO.lookupSessionByTopic(100, 200)).toBe("sess-2");
    expect(userDO.lookupSessionById("sess-1")).toBeNull();
  });

  it("recordTaskSession makes session retrievable by id with type task", () => {
    const userDO = createFakeUserDO();
    userDO.recordTaskSession("task-sess-1");
    expect(userDO.lookupSessionById("task-sess-1")).toEqual({ type: "task", chatId: 0, topicId: 0 });
  });

  it("multiple task sessions do not collide", () => {
    const userDO = createFakeUserDO();
    userDO.recordTaskSession("task-1");
    userDO.recordTaskSession("task-2");
    expect(userDO.lookupSessionById("task-1")).toEqual({ type: "task", chatId: 0, topicId: 0 });
    expect(userDO.lookupSessionById("task-2")).toEqual({ type: "task", chatId: 0, topicId: 0 });
  });

  it("forgetSession works for task sessions", () => {
    const userDO = createFakeUserDO();
    userDO.recordTaskSession("task-sess-1");
    userDO.forgetSession("task-sess-1");
    expect(userDO.lookupSessionById("task-sess-1")).toBeNull();
  });

  it("recordTaskSession stores name and lookupSessionById returns it", () => {
    const userDO = createFakeUserDO();
    userDO.recordTaskSession("task-sess-1", "google-onboarding");
    expect(userDO.lookupSessionById("task-sess-1")).toEqual({ type: "task", chatId: 0, topicId: 0, name: "google-onboarding" });
  });
});


describe("UserDO webui sessions and messages contract", () => {
  it("createWebuiSession makes a webui session retrievable by id", () => {
    const userDO = createFakeUserDO();
    userDO.createWebuiSession("web-1", "Chat");
    expect(userDO.lookupSessionById("web-1")).toEqual({ type: "webui", chatId: 0, topicId: 0, name: "Chat" });
  });

  it("listSessions returns telegram and webui sessions", () => {
    const userDO = createFakeUserDO();
    userDO.recordSession(100, 200, "tg-1");
    userDO.createWebuiSession("web-1", "Chat");
    const list = userDO.listSessions();
    expect(list.map((s) => s.sessionId).sort()).toEqual(["tg-1", "web-1"]);
    expect(list.find((s) => s.sessionId === "web-1")).toMatchObject({ type: "webui", name: "Chat", status: "idle" });
  });

  it("appendMessage then listMessages returns both directions in order", () => {
    const userDO = createFakeUserDO();
    userDO.createWebuiSession("web-1");
    userDO.appendMessage("web-1", "user", "hi");
    userDO.appendMessage("web-1", "agent", "hello");
    const { messages, status } = userDO.listMessages("web-1");
    expect(messages.map((m) => [m.role, m.text])).toEqual([["user", "hi"], ["agent", "hello"]]);
    expect(status).toBe("idle");
  });

  it("listMessages honors the since cursor", () => {
    const userDO = createFakeUserDO();
    userDO.createWebuiSession("web-1");
    userDO.appendMessage("web-1", "user", "one");
    userDO.appendMessage("web-1", "agent", "two");
    const first = userDO.listMessages("web-1").messages[0].id;
    const { messages } = userDO.listMessages("web-1", first);
    expect(messages.map((m) => m.text)).toEqual(["two"]);
  });

  it("messages for different sessions do not mix", () => {
    const userDO = createFakeUserDO();
    userDO.recordSession(100, 200, "tg-1");
    userDO.createWebuiSession("web-1");
    userDO.appendMessage("tg-1", "user", "from telegram");
    userDO.appendMessage("web-1", "user", "from web");
    expect(userDO.listMessages("tg-1").messages.map((m) => m.text)).toEqual(["from telegram"]);
    expect(userDO.listMessages("web-1").messages.map((m) => m.text)).toEqual(["from web"]);
  });

  it("markSessionActiveById and markSessionIdleById toggle status", async () => {
    const userDO = createFakeUserDO();
    userDO.createWebuiSession("web-1");
    await userDO.markSessionActiveById("web-1");
    expect(userDO.listMessages("web-1").status).toBe("active");
    userDO.markSessionIdleById("web-1");
    expect(userDO.listMessages("web-1").status).toBe("idle");
  });
});

describe("UserDO settings contract", () => {
  it("getSettings returns isNewUser true on first access", () => {
    const userDO = createFakeUserDO();
    const settings = userDO.getSettings();
    expect(settings.isNewUser).toBe(true);
    expect(settings.onboardingSeen).toBe(false);
    expect(settings.googleOnboardingStatus).toBeNull();
    expect(settings.createdAt).toBeDefined();
  });

  it("getSettings returns isNewUser false on subsequent access", () => {
    const userDO = createFakeUserDO();
    userDO.getSettings();
    const settings = userDO.getSettings();
    expect(settings.isNewUser).toBe(false);
  });

  it("updateSettings sets onboardingSeen to true", () => {
    const userDO = createFakeUserDO();
    userDO.updateSettings({ onboardingSeen: true });
    expect(userDO.getSettings().onboardingSeen).toBe(true);
  });

  it("updateSettings can reset onboardingSeen to false", () => {
    const userDO = createFakeUserDO();
    userDO.updateSettings({ onboardingSeen: true });
    userDO.updateSettings({ onboardingSeen: false });
    expect(userDO.getSettings().onboardingSeen).toBe(false);
  });

  it("updateSettings with empty object does not change settings", () => {
    const userDO = createFakeUserDO();
    userDO.updateSettings({ onboardingSeen: true });
    userDO.updateSettings({});
    expect(userDO.getSettings().onboardingSeen).toBe(true);
  });

  it("setGoogleOnboardingStatus updates status visible via getSettings", () => {
    const userDO = createFakeUserDO();
    userDO.setGoogleOnboardingStatus("running");
    expect(userDO.getSettings().googleOnboardingStatus).toBe("running");
    userDO.setGoogleOnboardingStatus("done");
    expect(userDO.getSettings().googleOnboardingStatus).toBe("done");
  });
});
