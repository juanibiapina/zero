import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory";
import { createScheduleBook, MAX_ACTIVE_SCHEDULES } from "./book";

const NOW = new Date("2026-01-02T12:00:00Z").getTime();

const makeBook = (overrides: { now?: () => number } = {}) => {
  const store = new MemoryStore(() => "2026-01-02T12:00:00.000Z");
  const conversationId = store.getOrCreateConversation(1, 0);
  let counter = 0;
  const book = createScheduleBook({
    store,
    conversationId,
    now: overrides.now ?? (() => NOW),
    newId: () => `sch_${++counter}`,
  });
  return { store, book, conversationId };
};

describe("ScheduleBook", () => {
  it("creates a schedule with its first due time resolved", () => {
    const { book } = makeBook();
    const result = book.create({
      prompt: "send today's calendar",
      pattern: "0 8 * * 1-5",
      timezone: "Europe/Berlin",
    });
    expect(result).toMatchObject({
      schedule: { id: "sch_1", pattern: "0 8 * * 1-5", lastFiredAt: null },
    });
    if ("error" in result) throw new Error("expected a schedule");
    // Friday 13:00 Berlin → Monday 08:00 Berlin = 07:00Z.
    expect(new Date(result.schedule.nextDueAt!).toISOString()).toBe(
      "2026-01-05T07:00:00.000Z",
    );
  });

  it("rejects an invalid timezone with suggestions", () => {
    const { book } = makeBook();
    const result = book.create({
      prompt: "x",
      pattern: "0 8 * * *",
      timezone: "Europe/Berln",
    });
    expect(result).toMatchObject({ reason: "timezone" });
    expect(result).toHaveProperty("suggestions");
  });

  it("rejects an invalid pattern", () => {
    const { book } = makeBook();
    expect(
      book.create({ prompt: "x", pattern: "tomorrow", timezone: "UTC" }),
    ).toMatchObject({ reason: "pattern" });
  });

  it("rejects a pattern below the frequency floor", () => {
    const { book } = makeBook();
    expect(
      book.create({ prompt: "x", pattern: "*/5 * * * *", timezone: "UTC" }),
    ).toMatchObject({ reason: "pattern" });
  });

  it("refuses to go past the per-user cap", () => {
    const { book } = makeBook();
    for (let i = 0; i < MAX_ACTIVE_SCHEDULES; i++) {
      expect(
        book.create({ prompt: "x", pattern: "0 8 * * *", timezone: "UTC" }),
      ).toHaveProperty("schedule");
    }
    expect(
      book.create({ prompt: "x", pattern: "0 8 * * *", timezone: "UTC" }),
    ).toMatchObject({ reason: "cap" });
  });

  it("lists only this conversation's active schedules, soonest first", () => {
    const { store, book } = makeBook();
    book.create({ prompt: "late", pattern: "0 18 * * *", timezone: "UTC" });
    book.create({ prompt: "early", pattern: "0 6 * * *", timezone: "UTC" });
    // Another thread's schedule is not this book's business.
    const other = store.getOrCreateConversation(2, 0);
    createScheduleBook({ store, conversationId: other, now: () => NOW }).create({
      prompt: "elsewhere",
      pattern: "0 7 * * *",
      timezone: "UTC",
    });
    expect(book.list().map((s) => s.prompt)).toEqual(["late", "early"]);
  });

  it("cancels a schedule once and reports an unknown id", () => {
    const { book } = makeBook();
    const result = book.create({
      prompt: "x",
      pattern: "0 8 * * *",
      timezone: "UTC",
    });
    if ("error" in result) throw new Error("expected a schedule");
    expect(book.cancel(result.schedule.id)).toBe(true);
    expect(book.cancel(result.schedule.id)).toBe(false);
    expect(book.cancel("sch_nope")).toBe(false);
    expect(book.list()).toEqual([]);
  });
});
