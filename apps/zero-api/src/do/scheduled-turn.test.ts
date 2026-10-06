// A schedule coming due, end to end in process: the firing pass hands the
// prompt to the assistant, and the assistant answers it and messages the user.
// This is what says the two halves fit; the seam between them is where a
// scheduled turn would silently do nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fireDueSchedules } from "./schedules";
import { MemoryStore } from "../store/memory";
import { createScheduleBook } from "../schedules/book";
import { composeTurnText, SCHEDULE_NOTE } from "../UserDO/turn-text";
import { nextRun } from "../schedules/recurrence";
import { createTestAssistant } from "../assistant/test-support";

const NOW = new Date("2026-01-02T12:00:00Z").getTime();

type Submitted = { conversationId: string; text: string; operationId: string };

const fire = (
  store: MemoryStore,
  now: number,
  submit: (conversationId: string, text: string, operationId: string) => Promise<void>,
) =>
  fireDueSchedules({
    store,
    now,
    nextRun,
    composeText: (prompt) => composeTurnText({ note: SCHEDULE_NOTE, text: prompt }),
    submit,
  });

const recorder = () => {
  const submitted: Submitted[] = [];
  return {
    submitted,
    submit: async (conversationId: string, text: string, operationId: string) => {
      submitted.push({ conversationId, text, operationId });
    },
  };
};

afterEach(() => vi.restoreAllMocks());

describe("a schedule coming due", () => {
  it("runs a turn on its prompt and messages the user", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new MemoryStore();
    const conversationId = store.getOrCreateConversation(1, 0);
    const book = createScheduleBook({ store, conversationId, now: () => NOW });
    const created = book.create({
      prompt: "remind the user to take the bread out",
      pattern: "2026-01-02T13:10:00",
      timezone: "UTC",
    });
    if ("error" in created) throw new Error(created.error);

    const seen: string[] = [];
    const t = await createTestAssistant({
      store,
      steps: [
        (context) => {
          seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("Bread's ready to come out.");
        },
      ],
    });
    const submit = async (conversation: string, text: string, operationId: string) =>
      t.assistant.submit({ chat: { chatId: 1, topicId: 0 }, conversationId: conversation, text, operationId });

    expect(await fire(store, NOW, submit)).toBe(0);
    expect(await fire(store, created.schedule.nextDueAt! + 1000, submit)).toBe(1);
    await t.idle();

    expect(seen[0]).toContain(SCHEDULE_NOTE);
    expect(seen[0]).toContain("remind the user to take the bread out");
    expect(t.sent.map((s) => s.text)).toEqual(["Bread's ready to come out."]);
    expect(book.list()).toEqual([]);
    expect(store.earliestScheduleDueAt()).toBeNull();
    await t.close();
  });

  it("submits one occurrence under a key a retry repeats", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new MemoryStore();
    const conversationId = store.getOrCreateConversation(1, 0);
    const book = createScheduleBook({ store, conversationId, now: () => NOW });
    const created = book.create({
      prompt: "send today's calendar",
      pattern: "0 8 * * 1-5",
      timezone: "Europe/Berlin",
    });
    if ("error" in created) throw new Error(created.error);

    const { submitted, submit } = recorder();
    const twoWeeksOn = created.schedule.nextDueAt! + 14 * 24 * 60 * 60 * 1000;
    expect(await fire(store, twoWeeksOn, submit)).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].operationId).toBe(
      `schedule:${created.schedule.id}:${created.schedule.nextDueAt}`,
    );
    expect(store.earliestScheduleDueAt()!).toBeGreaterThan(twoWeeksOn);
    expect(book.list()).toHaveLength(1);
  });

  it("does not advance a schedule whose hand-off failed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new MemoryStore();
    const conversationId = store.getOrCreateConversation(1, 0);
    const book = createScheduleBook({ store, conversationId, now: () => NOW });
    const created = book.create({
      prompt: "x",
      pattern: "2026-01-02T13:10:00",
      timezone: "UTC",
    });
    if ("error" in created) throw new Error(created.error);
    const failing = async () => {
      throw new Error("assistant unavailable");
    };
    await expect(fire(store, created.schedule.nextDueAt! + 1000, failing)).rejects.toThrow();
    expect(book.list()).toHaveLength(1);
  });

  it("never fires a cancelled schedule", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new MemoryStore();
    const conversationId = store.getOrCreateConversation(1, 0);
    const book = createScheduleBook({ store, conversationId, now: () => NOW });
    const created = book.create({
      prompt: "x",
      pattern: "2026-01-02T13:10:00",
      timezone: "UTC",
    });
    if ("error" in created) throw new Error(created.error);
    expect(book.cancel(created.schedule.id)).toBe(true);
    const { submitted, submit } = recorder();
    expect(await fire(store, created.schedule.nextDueAt! + 1000, submit)).toBe(0);
    expect(submitted).toEqual([]);
  });
});
