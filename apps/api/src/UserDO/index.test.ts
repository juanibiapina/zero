import { describe, expect, it } from "vitest";

import type { UserDO } from "./index";

// ---------------------------------------------------------------------------
// Fake UserDO stub — implements the same public RPC interface
// ---------------------------------------------------------------------------

type UserDOStub = Pick<UserDO, "getTelegramId" | "linkTelegram" | "unlinkTelegram" | "lookupSessionByTopic" | "lookupSessionById" | "recordSession" | "recordTaskSession" | "forgetSession" | "getSettings" | "updateSettings" | "setGoogleOnboardingStatus">;

const createFakeUserDO = (): UserDOStub => {
  let telegramId: string | null = null;
  const sessionsByTopic = new Map<string, string>();
  const sessionsBySessionId = new Map<string, { type: string; chatId: number; topicId: number; name?: string }>();
  let onboardingSeen = false;
  let googleOnboardingStatus: string | null = null;

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
      sessionsBySessionId.set(sessionId, { type: "telegram", chatId, topicId });
    },
    recordTaskSession: (sessionId: string, name?: string) => {
      sessionsBySessionId.set(sessionId, { type: "task", chatId: 0, topicId: 0, ...(name ? { name } : {}) });
    },
    forgetSession: (sessionId: string) => {
      const record = sessionsBySessionId.get(sessionId);
      if (record) {
        sessionsByTopic.delete(topicKey(record.chatId, record.topicId));
      }
      sessionsBySessionId.delete(sessionId);
    },
    getSettings: () => {
      return { onboardingSeen, googleOnboardingStatus };
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


describe("UserDO settings contract", () => {
  it("getSettings returns onboardingSeen false by default", () => {
    const userDO = createFakeUserDO();
    expect(userDO.getSettings()).toEqual({ onboardingSeen: false, googleOnboardingStatus: null });
  });

  it("updateSettings sets onboardingSeen to true", () => {
    const userDO = createFakeUserDO();
    userDO.updateSettings({ onboardingSeen: true });
    expect(userDO.getSettings()).toEqual({ onboardingSeen: true, googleOnboardingStatus: null });
  });

  it("updateSettings can reset onboardingSeen to false", () => {
    const userDO = createFakeUserDO();
    userDO.updateSettings({ onboardingSeen: true });
    userDO.updateSettings({ onboardingSeen: false });
    expect(userDO.getSettings()).toEqual({ onboardingSeen: false, googleOnboardingStatus: null });
  });

  it("updateSettings with empty object does not change settings", () => {
    const userDO = createFakeUserDO();
    userDO.updateSettings({ onboardingSeen: true });
    userDO.updateSettings({});
    expect(userDO.getSettings()).toEqual({ onboardingSeen: true, googleOnboardingStatus: null });
  });

  it("setGoogleOnboardingStatus updates status visible via getSettings", () => {
    const userDO = createFakeUserDO();
    userDO.setGoogleOnboardingStatus("running");
    expect(userDO.getSettings().googleOnboardingStatus).toBe("running");
    userDO.setGoogleOnboardingStatus("done");
    expect(userDO.getSettings().googleOnboardingStatus).toBe("done");
  });
});
