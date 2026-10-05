// A schedule coming due, end to end in process: the firing pass queues the
// prompt, and the ordinary turn path answers it and messages the user. This is
// what says the two halves fit — everything either side of it is unit-tested,
// and the seam between them is where a scheduled turn would silently do nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireDueSchedules } from "./schedules";
import { runTurn } from "../agents/orchestrator";
import { capturingModel } from "../agents/mock-model";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";
import { createMemoryFetcher } from "../pagefetch/memory";
import { createMemoryGoogle } from "../google/memory";
import { createScheduleBook } from "../schedules/book";
import { composeTurnText, SCHEDULE_NOTE } from "../UserDO/turn-text";
import { nextRun } from "../schedules/recurrence";
import type { AgentModelRequest } from "../agents/protocol";

const NOW = new Date("2026-01-02T12:00:00Z").getTime();

const fire = (store: MemoryStore, now: number) =>
  fireDueSchedules({
    store,
    now,
    nextRun,
    composeText: (prompt) => composeTurnText({ note: SCHEDULE_NOTE, text: prompt }),
  });

afterEach(() => vi.restoreAllMocks());

describe("a schedule coming due", () => {
  it("runs a turn on its prompt and messages the user", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new MemoryStore();
    const conversationId = store.getOrCreateConversation(1, 0);
    const book = createScheduleBook({
      store,
      conversationId,
      now: () => NOW,
    });
    const created = book.create({
      prompt: "remind the user to take the bread out",
      pattern: "2026-01-02T13:10:00",
      timezone: "UTC",
    });
    if ("error" in created) throw new Error(created.error);

    // Nothing is due yet, so nothing is queued.
    expect(fire(store, NOW)).toBe(0);

    // The moment arrives.
    expect(fire(store, created.schedule.nextDueAt! + 1000)).toBe(1);

    const sent: string[] = [];
    const requests: AgentModelRequest[] = [];
    const model = capturingModel((request) => {
      requests.push(request);
      return {
        content: [{ type: "text", text: "Bread's ready to come out." }],
      };
    });

    await runTurn({
      store,
      makeModel: () => model,
      send: async (text) => void sent.push(text),
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    // The model saw the note and the prompt, and the user got the message.
    const text = JSON.stringify(requests[0]?.messages ?? []);
    expect(text).toContain(SCHEDULE_NOTE);
    expect(text).toContain("remind the user to take the bread out");
    expect(sent).toEqual(["Bread's ready to come out."]);
    // A one-shot is finished: it is gone from what the user has scheduled.
    expect(book.list()).toEqual([]);
    expect(store.earliestScheduleDueAt()).toBeNull();
  });

  it("keeps a recurring schedule due at its next occurrence", async () => {
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

    // Down for two weeks: every missed morning collapses into a single fire.
    const twoWeeksOn = created.schedule.nextDueAt! + 14 * 24 * 60 * 60 * 1000;
    expect(fire(store, twoWeeksOn)).toBe(1);
    expect(store.drainPendingMessages(conversationId)).toHaveLength(1);
    // And it is armed for the next weekday morning, not for a backlog.
    expect(store.earliestScheduleDueAt()!).toBeGreaterThan(twoWeeksOn);
    expect(book.list()).toHaveLength(1);
  });

  it("never fires a cancelled schedule", () => {
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
    expect(fire(store, created.schedule.nextDueAt! + 1000)).toBe(0);
    expect(store.drainPendingMessages(conversationId)).toEqual([]);
  });
});
