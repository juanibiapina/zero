import { afterEach, describe, expect, it, vi } from "vitest";
import { runAlarmTurns, backoffMs, ATTEMPTS_KEY, BASE_BACKOFF_MS } from "./alarm";
import type { Thread } from "../store/types";

const thread = (id: string, chatId: number, topicId: number): Thread => ({
  id,
  chatId,
  topicId,
});

const fakeStorage = () => {
  const map = new Map<string, unknown>();
  const alarms: number[] = [];
  return {
    map,
    alarms,
    get: async <T>(k: string) => map.get(k) as T | undefined,
    put: async (k: string, v: unknown) => void map.set(k, v),
    delete: async (k: string) => map.delete(k),
    setAlarm: async (t: number) => void alarms.push(t),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backoffMs", () => {
  it("doubles per attempt from the base", () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(3)).toBe(8000);
  });

  it("caps the delay", () => {
    expect(backoffMs(20)).toBe(5 * 60 * 1000);
  });
});

describe("runAlarmTurns", () => {
  it("drains every awaiting thread and clears the attempt counter", async () => {
    const storage = fakeStorage();
    storage.map.set(ATTEMPTS_KEY, 3);
    const runTurn = vi.fn(async () => {});

    await runAlarmTurns({
      storage,
      findConversationsWithWork: () => [thread("c1", 1, 2), thread("c2", 3, 4)],
      runTurn,
    });

    expect(runTurn.mock.calls).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(storage.alarms).toEqual([]);
    expect(storage.map.has(ATTEMPTS_KEY)).toBe(false);
  });

  it("reschedules with backoff and does not throw when a thread still awaits reply", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage();
    const runTurn = vi.fn(async () => {
      throw new Error("gateway down");
    });

    await expect(
      runAlarmTurns({
        storage,
        findConversationsWithWork: () => [thread("c1", 1, 2)],
        runTurn,
        now: () => 1000,
      }),
    ).resolves.toBeUndefined();

    expect(storage.map.get(ATTEMPTS_KEY)).toBe(1);
    expect(storage.alarms).toEqual([1000 + BASE_BACKOFF_MS]);
  });

  it("grows backoff from the storage-backed counter across failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage();
    storage.map.set(ATTEMPTS_KEY, 1);
    const runTurn = vi.fn(async () => {
      throw new Error("gateway down");
    });

    await runAlarmTurns({
      storage,
      findConversationsWithWork: () => [thread("c1", 1, 2)],
      runTurn,
      now: () => 1000,
    });

    expect(storage.map.get(ATTEMPTS_KEY)).toBe(2);
    expect(storage.alarms).toEqual([1000 + backoffMs(2)]);
  });

  it("reports the failure to the error sink and still reschedules", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage();
    const reportError = vi.fn(async () => {});
    const boom = new Error("gateway down");
    const runTurn = vi.fn(async () => {
      throw boom;
    });

    await runAlarmTurns({
      storage,
      findConversationsWithWork: () => [thread("c1", 1, 2)],
      runTurn,
      reportError,
      now: () => 1000,
    });

    expect(reportError).toHaveBeenCalledWith(boom);
    expect(storage.alarms).toEqual([1000 + BASE_BACKOFF_MS]);
  });

  it("does not reschedule when nothing awaits reply (circuit breaker)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage();
    storage.map.set(ATTEMPTS_KEY, 2);
    // First call (loop entry) yields work that throws; the post-failure guard
    // then sees an empty queue, so no reschedule.
    let calls = 0;
    const runTurn = vi.fn(async () => {
      throw new Error("gateway down");
    });

    await runAlarmTurns({
      storage,
      findConversationsWithWork: () => (calls++ === 0 ? [thread("c1", 1, 2)] : []),
      runTurn,
    });

    expect(storage.alarms).toEqual([]);
    expect(storage.map.has(ATTEMPTS_KEY)).toBe(false);
  });
});

// The stall signal. A DO alarm invocation killed at the 900s wall-time ceiling
// reports `outcome: exceededWallTime` to Cloudflare but throws nothing, so the
// only in-app evidence that the drain finished is this line existing.
describe("runAlarmTurns completion marker", () => {
  it("logs alarm_finished with the turn count and duration", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = 1000;
    const storage = fakeStorage();

    await runAlarmTurns({
      storage,
      findConversationsWithWork: () => [thread("c1", 1, 2), thread("c2", 3, 4)],
      runTurn: async () => {
        clock += 500;
      },
      now: () => clock,
    });

    expect(logSpy.mock.calls.map((c) => c[0] as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({
        msg: "alarm_finished",
        turns: 2,
        duration_ms: 1000,
      }),
    );
  });

  it("logs alarm_finished with zero turns when nothing awaits reply", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAlarmTurns({
      storage: fakeStorage(),
      findConversationsWithWork: () => [],
      runTurn: async () => {},
    });

    expect(logSpy.mock.calls.map((c) => c[0] as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ msg: "alarm_finished", turns: 0 }),
    );
  });

  it("does not log alarm_finished when a turn throws", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runAlarmTurns({
      storage: fakeStorage(),
      findConversationsWithWork: () => [thread("c1", 1, 2)],
      runTurn: async () => {
        throw new Error("boom");
      },
      now: () => 1000,
    });

    expect(logSpy.mock.calls.map((c) => c[0] as Record<string, unknown>)).not.toContainEqual(
      expect.objectContaining({ msg: "alarm_finished" }),
    );
  });
});
