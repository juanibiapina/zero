import { describe, expect, it } from "vitest";

import type { UserDO } from "./index";

// ---------------------------------------------------------------------------
// Fake UserDO stub — implements the same public RPC interface
// ---------------------------------------------------------------------------

type UserDOStub = Pick<UserDO, "getTelegramId" | "linkTelegram" | "unlinkTelegram" | "getSettings" | "updateSettings" | "setGoogleOnboardingStatus">;

const createFakeUserDO = (): UserDOStub => {
  let telegramId: string | null = null;
  let onboardingSeen = false;
  let googleOnboardingStatus: string | null = null;
  let createdAt: string | null = null;
  let hasRow = false;

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
