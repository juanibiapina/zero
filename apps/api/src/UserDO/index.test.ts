import { describe, expect, it } from "vitest";

import type { UserDO } from "./index";

// ---------------------------------------------------------------------------
// Fake UserDO stub — implements the same public RPC interface
// ---------------------------------------------------------------------------

type UserDOStub = Pick<UserDO, "getTelegramId" | "linkTelegram" | "unlinkTelegram">;

const createFakeUserDO = (): UserDOStub & { _telegramId: string | null } => {
  let stored: string | null = null;
  return {
    get _telegramId() {
      return stored;
    },
    getTelegramId: () => stored,
    linkTelegram: (telegramId: string) => {
      const previous = stored;
      stored = telegramId;
      return { previous };
    },
    unlinkTelegram: () => {
      const removed = stored;
      stored = null;
      return { removed };
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
