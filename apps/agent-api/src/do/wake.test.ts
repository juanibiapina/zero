import { describe, expect, it, vi, afterEach } from "vitest";
import { MemoryStore } from "../store/memory";
import { messageText } from "../store/messages";
import { runWake, type WakeStore } from "./wake";
import { WAKE_INACTIVE_MS } from "./schedule";

const NOTE = "[wake note]";
const compose = () => NOTE;

// A store with one conversation and a lastActiveAt set to `sinceMs` before now.
const storeWithActivity = (input: {
  now: number;
  lastActiveMs: number;
  wokeAtMs?: number;
}): { store: WakeStore; conversationId: string } => {
  const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
  const conversationId = store.getOrCreateConversation(1, 0);
  store.storeMessage(conversationId, "user", "hi");
  store.updateSettings({
    lastActiveAt: new Date(input.lastActiveMs).toISOString(),
    ...(input.wokeAtMs !== undefined
      ? { wokeAt: new Date(input.wokeAtMs).toISOString() }
      : {}),
  });
  return { store, conversationId };
};

const pending = (store: WakeStore, conversationId: string) =>
  (store as unknown as MemoryStore).drainPendingMessages(conversationId);

describe("runWake", () => {
  afterEach(() => vi.restoreAllMocks());

  it("wakes an inactive, not-yet-woken user: queues the note and marks wokeAt", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = 10 * WAKE_INACTIVE_MS;
    const { store, conversationId } = storeWithActivity({
      now,
      lastActiveMs: now - WAKE_INACTIVE_MS - 1,
    });

    expect(runWake({ store, now, composeText: compose })).toEqual({
      status: "woken",
    });
    const drained = pending(store, conversationId);
    expect(drained).toHaveLength(1);
    expect(messageText(drained[0].content)).toBe(NOTE);
    expect(store.getSettings().wokeAt).toBe(new Date(now).toISOString());
  });

  it("skips an active user (within the window) and queues nothing", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = 10 * WAKE_INACTIVE_MS;
    const { store, conversationId } = storeWithActivity({
      now,
      lastActiveMs: now - 1000,
    });

    expect(runWake({ store, now, composeText: compose })).toEqual({
      status: "skipped",
      reason: "active",
    });
    expect(pending(store, conversationId)).toHaveLength(0);
    expect(store.getSettings().wokeAt).toBeNull();
  });

  it("skips an already-woken user, so a repeated backfill is a no-op", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = 10 * WAKE_INACTIVE_MS;
    const lastActiveMs = now - WAKE_INACTIVE_MS - 1;
    const { store, conversationId } = storeWithActivity({
      now,
      lastActiveMs,
      wokeAtMs: lastActiveMs + 1,
    });

    expect(runWake({ store, now, composeText: compose })).toEqual({
      status: "skipped",
      reason: "already_woken",
    });
    expect(pending(store, conversationId)).toHaveLength(0);
  });

  it("skips a user with no conversation", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = 10 * WAKE_INACTIVE_MS;
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.updateSettings({
      lastActiveAt: new Date(now - WAKE_INACTIVE_MS - 1).toISOString(),
    });

    expect(runWake({ store, now, composeText: compose })).toEqual({
      status: "skipped",
      reason: "no_conversation",
    });
  });

  it("wakes again after the user returns and lapses: wokeAt no longer guards", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = 10 * WAKE_INACTIVE_MS;
    // Woken once in the past, then the user spoke (lastActive after that woke),
    // then lapsed a week again.
    const lastActiveMs = now - WAKE_INACTIVE_MS - 1;
    const { store, conversationId } = storeWithActivity({
      now,
      lastActiveMs,
      wokeAtMs: lastActiveMs - 10, // older than the last message
    });

    expect(runWake({ store, now, composeText: compose })).toEqual({
      status: "woken",
    });
    expect(pending(store, conversationId)).toHaveLength(1);
  });
});
