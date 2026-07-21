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
      findThreadsAwaitingReply: () => [thread("c1", 1, 2), thread("c2", 3, 4)],
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
        findThreadsAwaitingReply: () => [thread("c1", 1, 2)],
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
      findThreadsAwaitingReply: () => [thread("c1", 1, 2)],
      runTurn,
      now: () => 1000,
    });

    expect(storage.map.get(ATTEMPTS_KEY)).toBe(2);
    expect(storage.alarms).toEqual([1000 + backoffMs(2)]);
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
      findThreadsAwaitingReply: () => (calls++ === 0 ? [thread("c1", 1, 2)] : []),
      runTurn,
    });

    expect(storage.alarms).toEqual([]);
    expect(storage.map.has(ATTEMPTS_KEY)).toBe(false);
  });
});
