import { describe, expect, it, vi } from "vitest";
import { MAIL_INACTIVE_MS, runMailWatch } from "./mail-watch";
import { MemoryStore } from "../store/memory";
import { createMemoryGoogle } from "../google/memory";
import type { MemoryGoogleSeed } from "../google/memory";

const NOW = Date.parse("2026-02-10T12:00:00.000Z");

let submitted: { conversationId: string; text: string; operationId: string }[] = [];
const sent = (conversationId: string) =>
  submitted.filter((s) => s.conversationId === conversationId).map((s) => s.text);

const setup = (seed: MemoryGoogleSeed = {}) => {
  submitted = [];
  const store = new MemoryStore(() => new Date(NOW).toISOString());
  const conversationId = store.getOrCreateConversation(1, 0);
  store.updateSettings({ lastActiveAt: new Date(NOW - 1000).toISOString() });
  return { store, conversationId, google: createMemoryGoogle(seed) };
};

const run = (
  store: MemoryStore,
  google: ReturnType<typeof createMemoryGoogle>,
  now = NOW,
) =>
  runMailWatch({
    store,
    mail: google.mail,
    now,
    composeText: (threadId) => `[mail] ${threadId}`,
    submit: async (conversationId, text, operationId) => {
      submitted.push({ conversationId, text, operationId });
    },
  });

describe("runMailWatch", () => {
  it("does nothing and disarms when no thread is watched", async () => {
    const { store, google } = setup();
    await expect(run(store, google)).resolves.toEqual({
      status: "disarmed",
      reason: "no_threads",
    });
    expect(google.historyCalls).toEqual([]);
  });

  it("disarms without calling Gmail when the user has been away a week", async () => {
    const { store, google, conversationId } = setup();
    store.trackMailThread({ threadId: "T1", conversationId });
    store.updateSettings({
      lastActiveAt: new Date(NOW - MAIL_INACTIVE_MS - 1).toISOString(),
    });
    await expect(run(store, google)).resolves.toEqual({
      status: "disarmed",
      reason: "inactive",
    });
    expect(google.historyCalls).toEqual([]);
  });

  it("seeds the watermark from the mailbox on the first pass and notifies nobody", async () => {
    const { store, google, conversationId } = setup({ historyId: "9000" });
    store.trackMailThread({ threadId: "T1", conversationId });
    await expect(run(store, google)).resolves.toEqual({ status: "rebaselined" });
    expect(store.getSettings().mailHistoryId).toBe("9000");
    expect(sent(conversationId)).toEqual([]);
  });

  it("queues one turn per watched thread that got new inbox mail", async () => {
    const { store, google, conversationId } = setup({
      historyId: "9100",
      changedThreadIds: ["T1", "OTHER"],
    });
    store.trackMailThread({ threadId: "T1", conversationId });
    store.updateSettings({ mailHistoryId: "9000" });

    await expect(run(store, google)).resolves.toEqual({
      status: "checked",
      notified: 1,
    });
    expect(google.historyCalls).toEqual(["9000"]);
    expect(sent(conversationId)).toEqual(["[mail] T1"]);
    expect(store.listMailThreads()[0]?.lastNotifiedAt).toBe(
      new Date(NOW).toISOString(),
    );
  });

  it("advances the watermark even when nothing matched, so quiet threads stay watched", async () => {
    const { store, google, conversationId } = setup({
      historyId: "9100",
      changedThreadIds: [],
    });
    store.trackMailThread({ threadId: "T1", conversationId });
    store.updateSettings({ mailHistoryId: "9000" });

    await expect(run(store, google)).resolves.toEqual({
      status: "checked",
      notified: 0,
    });
    expect(store.getSettings().mailHistoryId).toBe("9100");
  });

  it("re-baselines and stays quiet when the watermark fell out of Gmail's history", async () => {
    const { store, google, conversationId } = setup({
      historyId: "9999",
      historyExpired: true,
    });
    store.trackMailThread({ threadId: "T1", conversationId });
    store.updateSettings({ mailHistoryId: "1" });

    await expect(run(store, google)).resolves.toEqual({ status: "rebaselined" });
    expect(store.getSettings().mailHistoryId).toBe("9999");
    expect(sent(conversationId)).toEqual([]);
  });

  it("disarms when Google is not connected", async () => {
    const { store, google, conversationId } = setup({ notConnected: true });
    store.trackMailThread({ threadId: "T1", conversationId });
    store.updateSettings({ mailHistoryId: "9000" });

    await expect(run(store, google)).resolves.toEqual({
      status: "disarmed",
      reason: "not_connected",
    });
  });

  it("notifies each conversation its own thread belongs to", async () => {
    const { store, google } = setup({
      historyId: "9100",
      changedThreadIds: ["T1", "T2"],
    });
    const a = store.getOrCreateConversation(1, 0);
    const b = store.getOrCreateConversation(2, 0);
    store.trackMailThread({ threadId: "T1", conversationId: a });
    store.trackMailThread({ threadId: "T2", conversationId: b });
    store.updateSettings({ mailHistoryId: "9000" });

    await expect(run(store, google)).resolves.toEqual({
      status: "checked",
      notified: 2,
    });
    expect(sent(a)).toEqual(["[mail] T1"]);
    expect(sent(b)).toEqual(["[mail] T2"]);
  });

  it("lets an unexpected Gmail failure through so the deadline retries", async () => {
    const { store, google, conversationId } = setup();
    store.trackMailThread({ threadId: "T1", conversationId });
    store.updateSettings({ mailHistoryId: "9000" });
    vi.spyOn(google.mail, "listChangedThreads").mockRejectedValue(
      new Error("Google API 500"),
    );
    await expect(run(store, google)).rejects.toThrow("Google API 500");
  });
});
