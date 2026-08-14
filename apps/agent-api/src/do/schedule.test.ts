import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import {
  DEADLINES_KEY,
  IDLE_LEARN_MS,
  dueDeadlines,
  earliestDueAt,
  scheduleDeadline,
  setDeadline,
  takeDueDeadlines,
  requestLearnSafely,
  retryDeadline,
  retryDispatch,
  RETRY_BASE_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_MS,
  touchConversation,
  touchScheduleSafely,
  type Deadlines,
  type ScheduleStorage,
} from "./schedule";

// Storage double with the alarm slot modelled explicitly: a Durable Object has
// exactly one, which is the whole reason these deadlines live in their own
// object.
const fakeStorage = () => {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: ScheduleStorage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => void data.set(key, value),
    setAlarm: async (time) => void (alarm = time),
    deleteAlarm: async () => void (alarm = null),
  };
  return {
    storage,
    deadlines: () => (data.get(DEADLINES_KEY) ?? {}) as Deadlines,
    alarmAt: () => alarm,
  };
};

describe("deadline set", () => {
  it("replaces a conversation's deadline instead of accumulating one per touch", () => {
    let d: Deadlines = {};
    d = setDeadline(d, { reason: "idle", conversationId: "c1", dueAt: 100 });
    d = setDeadline(d, { reason: "idle", conversationId: "c1", dueAt: 200 });
    expect(Object.keys(d)).toHaveLength(1);
    expect(earliestDueAt(d)).toBe(200);
  });

  it("keeps deadlines for different conversations and reasons apart", () => {
    let d: Deadlines = {};
    d = setDeadline(d, { reason: "idle", conversationId: "c1", dueAt: 100 });
    d = setDeadline(d, { reason: "idle", conversationId: "c2", dueAt: 300 });
    d = setDeadline(d, { reason: "size", conversationId: "c1", dueAt: 50 });
    expect(Object.keys(d)).toHaveLength(3);
    expect(earliestDueAt(d)).toBe(50);
  });

  it("has no earliest deadline when empty", () => {
    expect(earliestDueAt({})).toBeNull();
  });

  it("splits at now, oldest due first", () => {
    let d: Deadlines = {};
    d = setDeadline(d, { reason: "idle", conversationId: "late", dueAt: 300 });
    d = setDeadline(d, { reason: "idle", conversationId: "old", dueAt: 100 });
    d = setDeadline(d, { reason: "size", conversationId: "now", dueAt: 200 });
    const { due, remaining } = dueDeadlines(d, 200);
    expect(due.map((e) => e.conversationId)).toEqual(["old", "now"]);
    expect(Object.keys(remaining)).toHaveLength(1);
  });
});

describe("scheduleDeadline", () => {
  it("arms the alarm for the earliest deadline, not the newest", async () => {
    const s = fakeStorage();
    await scheduleDeadline(s.storage, {
      reason: "idle",
      conversationId: "c1",
      dueAt: 1000,
    });
    expect(s.alarmAt()).toBe(1000);
    // A later deadline must not push the earlier one back.
    await scheduleDeadline(s.storage, {
      reason: "idle",
      conversationId: "c2",
      dueAt: 5000,
    });
    expect(s.alarmAt()).toBe(1000);
    await scheduleDeadline(s.storage, {
      reason: "size",
      conversationId: "c2",
      dueAt: 10,
    });
    expect(s.alarmAt()).toBe(10);
  });

  it("touch pushes a conversation an hour out", async () => {
    const s = fakeStorage();
    await touchConversation(s.storage, "c1", 1_000_000);
    expect(s.alarmAt()).toBe(1_000_000 + IDLE_LEARN_MS);
    await touchConversation(s.storage, "c1", 1_500_000);
    expect(Object.keys(s.deadlines())).toHaveLength(1);
    expect(s.alarmAt()).toBe(1_500_000 + IDLE_LEARN_MS);
  });
});

describe("takeDueDeadlines", () => {
  it("returns what is due, keeps the rest, and re-arms for the next", async () => {
    const s = fakeStorage();
    await scheduleDeadline(s.storage, {
      reason: "idle",
      conversationId: "c1",
      dueAt: 100,
    });
    await scheduleDeadline(s.storage, {
      reason: "idle",
      conversationId: "c2",
      dueAt: 900,
    });

    const due = await takeDueDeadlines(s.storage, 500);
    expect(due.map((e) => e.conversationId)).toEqual(["c1"]);
    expect(Object.keys(s.deadlines())).toHaveLength(1);
    expect(s.alarmAt()).toBe(900);
  });

  it("clears the alarm when nothing is left", async () => {
    const s = fakeStorage();
    await scheduleDeadline(s.storage, { reason: "size", dueAt: 100 });
    expect(await takeDueDeadlines(s.storage, 100)).toHaveLength(1);
    expect(s.deadlines()).toEqual({});
    expect(s.alarmAt()).toBeNull();
  });

  it("does not re-fire a deadline it already handed out", async () => {
    const s = fakeStorage();
    await scheduleDeadline(s.storage, {
      reason: "idle",
      conversationId: "c1",
      dueAt: 100,
    });
    await takeDueDeadlines(s.storage, 100);
    expect(await takeDueDeadlines(s.storage, 100)).toEqual([]);
  });
});

// The turn path must never fail because a timer could not be set.
describe("retryDeadline", () => {
  it("backs off exponentially from the first failure", () => {
    const entry = { reason: "onboarding" as const, dueAt: 1000 };
    const first = retryDeadline(entry, 10_000);
    expect(first).toEqual({
      reason: "onboarding",
      attempts: 1,
      dueAt: 10_000 + RETRY_BASE_MS,
    });
    const second = retryDeadline(first!, 20_000);
    expect(second).toEqual({
      reason: "onboarding",
      attempts: 2,
      dueAt: 20_000 + RETRY_BASE_MS * 2,
    });
  });

  it("caps the delay", () => {
    const entry = { reason: "admin_task" as const, dueAt: 0, attempts: 20 };
    // Attempt count above the ceiling is refused, so cap the delay one below it.
    const late = { ...entry, attempts: RETRY_MAX_ATTEMPTS - 1 };
    expect(retryDeadline(late, 0)?.dueAt).toBeLessThanOrEqual(RETRY_MAX_MS);
  });

  it("keeps the conversation a learning deadline is about", () => {
    const entry = { reason: "size" as const, dueAt: 0, conversationId: "c1" };
    expect(retryDeadline(entry, 0)?.conversationId).toBe("c1");
  });

  it("gives up after too many failures instead of retrying forever", () => {
    const entry = {
      reason: "onboarding" as const,
      dueAt: 0,
      attempts: RETRY_MAX_ATTEMPTS,
    };
    expect(retryDeadline(entry, 0)).toBeNull();
  });
});

describe("best-effort scheduling from the turn path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows a schedule that cannot be reached on touch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const schedule = {
      touch: async () => {
        throw new Error("do unreachable");
      },
      requestLearn: async () => {},
      requestReminderAt: async () => {},
      requestMailWatchAt: async () => {},
    };
    await expect(
      touchScheduleSafely(schedule, "user_1", "c1"),
    ).resolves.toBeUndefined();
  });

  it("swallows a failed learn request and passes the reason through otherwise", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: Array<[string, string, string | undefined]> = [];
    const schedule = {
      touch: async () => {},
      requestLearn: async (user: string, reason: "idle" | "size", conversationId?: string) => {
        calls.push([user, reason, conversationId]);
      },
      requestReminderAt: async () => {},
      requestMailWatchAt: async () => {},
    };
    await requestLearnSafely(schedule, "user_1", "size", "c1");
    expect(calls).toEqual([["user_1", "size", "c1"]]);

    const broken = {
      touch: async () => {},
      requestLearn: async () => {
        throw new Error("do unreachable");
      },
      requestReminderAt: async () => {},
      requestMailWatchAt: async () => {},
    };
    await expect(
      requestLearnSafely(broken, "user_1", "size", "c1"),
    ).resolves.toBeUndefined();
  });
});

describe("retryDispatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-arms a failed deadline without reporting: nothing is lost yet", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const d = fakeStorage();
    const reportError = vi.fn(async () => {});

    await retryDispatch({
      storage: d.storage,
      entry: { reason: "onboarding", dueAt: 1_000 },
      err: new Error("do unreachable"),
      now: 1_000,
      reportError,
      clerkUserId: "user_1",
    });

    expect(Object.values(d.deadlines())).toEqual([
      { reason: "onboarding", dueAt: 1_000 + RETRY_BASE_MS, attempts: 1 },
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports the cause when it gives up, dropping the work for good", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = fakeStorage();
    const reportError = vi.fn(async () => {});
    const err = new Error("do unreachable");

    await retryDispatch({
      storage: d.storage,
      entry: { reason: "admin_task", dueAt: 1_000, attempts: RETRY_MAX_ATTEMPTS },
      err,
      now: 1_000,
      reportError,
      clerkUserId: "user_1",
    });

    // Nothing re-scheduled: the deadline is gone.
    expect(d.deadlines()).toEqual({});
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportError.mock.calls[0] as unknown as [
      Error,
      Record<string, unknown>,
    ];
    expect(reported).toBe(err);
    expect(context).toEqual({
      site: "schedule_gave_up",
      reason: "admin_task",
      attempts: RETRY_MAX_ATTEMPTS,
      clerk_user_id: "user_1",
    });
  });
});
