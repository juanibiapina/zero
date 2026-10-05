import { describe, expect, it, vi } from "vitest";

import { purgeUserData, type PurgeDeps } from "./purge";

const deps = (overrides: Partial<PurgeDeps> = {}): PurgeDeps & { calls: string[] } => {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
  };
  return {
    calls,
    telegramId: "555",
    releaseTelegram: record("telegram"),
    purgeSchedules: record("schedules"),
    purgeLearning: record("learning"),
    purgeUser: record("user"),
    purgeTasks: record("tasks"),
    resetTasks: record("resetTasks"),
    resetUser: record("reset"),
    ...overrides,
  };
};

describe("purgeUserData", () => {
  it("releases the linked Telegram account before anything is wiped", async () => {
    const released: string[] = [];
    const d = deps({
      telegramId: "555",
      releaseTelegram: async (id) => {
        released.push(id);
      },
    });

    await purgeUserData(d);

    expect(released).toEqual(["555"]);
    expect(d.calls[0]).toBe("schedules");
  });

  it("wipes the user's own data after the deadlines and learning jobs", async () => {
    const d = deps();

    await purgeUserData(d);

    expect(d.calls).toEqual([
      "telegram",
      "schedules",
      "learning",
      "user",
      "schedules",
      "learning",
      "tasks",
      "resetTasks",
      "reset",
    ]);
  });

  it("skips the Telegram release when the user never linked an account", async () => {
    const releaseTelegram = vi.fn(async () => {});
    const d = deps({ telegramId: null, releaseTelegram });

    await purgeUserData(d);

    expect(releaseTelegram).not.toHaveBeenCalled();
    expect(d.calls).toEqual([
      "schedules",
      "learning",
      "user",
      "schedules",
      "learning",
      "tasks",
      "resetTasks",
      "reset",
    ]);
  });

  it("reports failure when the user's data could not be wiped", async () => {
    const d = deps({
      purgeUser: async () => {
        throw new Error("storage unavailable");
      },
    });

    await expect(purgeUserData(d)).rejects.toThrow("storage unavailable");
  });

  it("reports failure when TaskDO storage could not be erased", async () => {
    const d = deps({ purgeTasks: async () => { throw new Error("task storage unavailable"); } });
    await expect(purgeUserData(d)).rejects.toThrow("task storage unavailable");
    expect(d.calls).not.toContain("reset");
  });

  it("succeeds even though resetting the object always rejects", async () => {
    const d = deps({
      resetUser: async () => {
        throw new Error("Durable Object reset because its code was updated");
      },
    });

    await expect(purgeUserData(d)).resolves.toBeUndefined();
  });
});
