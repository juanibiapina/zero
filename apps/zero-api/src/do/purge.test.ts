import { describe, expect, it } from "vitest";

import { purgeUserData, type PurgeDeps } from "./purge";

const deps = (overrides: Partial<PurgeDeps> = {}): PurgeDeps & { calls: string[] } => {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
  };
  return {
    calls,
    purgeTasks: record("tasks"),
    purgeUser: record("user"),
    resetTasks: record("resetTasks"),
    resetUser: record("resetUser"),
    ...overrides,
  };
};

describe("purgeUserData", () => {
  it("empties both objects before aborting them", async () => {
    const d = deps();

    await purgeUserData(d);

    expect(d.calls).toEqual(["tasks", "user", "resetTasks", "resetUser"]);
  });

  it("reports failure when TaskDO storage could not be erased", async () => {
    const d = deps({ purgeTasks: async () => { throw new Error("task storage unavailable"); } });

    await expect(purgeUserData(d)).rejects.toThrow("task storage unavailable");
    expect(d.calls).toEqual([]);
  });

  it("reports failure when the user's settings could not be erased", async () => {
    const d = deps({ purgeUser: async () => { throw new Error("storage unavailable"); } });

    await expect(purgeUserData(d)).rejects.toThrow("storage unavailable");
    expect(d.calls).not.toContain("resetUser");
  });

  it("succeeds even though aborting the objects always rejects", async () => {
    const abort = async () => {
      throw new Error("Durable Object reset because its code was updated");
    };
    const d = deps({ resetTasks: abort, resetUser: abort });

    await expect(purgeUserData(d)).resolves.toBeUndefined();
  });
});
