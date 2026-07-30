import { describe, expect, it } from "vitest";
import {
  DEADLINES_KEY,
  IDLE_LEARN_MS,
  dueDeadlines,
  earliestDueAt,
  scheduleDeadline,
  setDeadline,
  takeDueDeadlines,
  touchConversation,
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
