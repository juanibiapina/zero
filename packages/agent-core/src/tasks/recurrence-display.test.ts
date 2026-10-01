import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createMergeableStore } from "tinybase";
import type { Recurrence } from "@zeroapps/recurrence";
import { createTaskdoReplica } from "../taskdo/replica";
import { defaultToastController } from "../toast/controller";
import { undoableAction } from "../toast/undoable";
import { taskCompletionMessage, taskRecurrenceLabel } from "./recurrence-display";

const today = "2026-10-01";
const daily: Recurrence = {
  version: 1, origin: today, anchor: "scheduled", weekStartsOn: "MO",
  pattern: { unit: "day", interval: 1 },
};
afterEach(() => defaultToastController.dismiss());

describe("recurring task presentation", () => {
  it("describes scheduled and completion-based repeats without parser notation", () => {
    expect(taskRecurrenceLabel({ recurrence: null })).toBeNull();
    expect(taskRecurrenceLabel({ recurrence: daily })).toBe("Every day");
    expect(taskRecurrenceLabel({ recurrence: { ...daily, anchor: "completed", pattern: { unit: "day", interval: 3 } } }))
      .toBe("Every 3 days after completion");
    expect(taskRecurrenceLabel({ recurrence: { ...daily, until: "2026-10-03" } })).toContain("until 2026-10-03");
  });

  it.each([
    ["scheduled repeat", daily, today, today, "Tomorrow"],
    ["completion-based repeat", { ...daily, anchor: "completed" as const }, "2026-09-28", today, "Tomorrow"],
    ["today catch-up", daily, "2026-09-30", today, "Today"],
    ["overdue catch-up", daily, "2026-09-28", today, "Tue, 29 Sept"],
    ["postponed repeat", daily, today, "2026-10-05", "Tomorrow"],
    ["series ending", { ...daily, until: today }, today, today, null],
  ])("shows the actual next occurrence for %s and restores it with Undo", async (_name, recurrence, cursor, showUpDate, expected) => {
    const replica = createTaskdoReplica({
      store: createMergeableStore(), queryClient: new QueryClient(), queryKeyScope: ["recurrence-test"],
      randomId: () => "task", now: () => new Date("2026-10-01T12:00:00Z"), today: () => today,
    });
    try {
      await replica.tasks.add("Repeat", null, null, { ...recurrence, origin: cursor }).isPersisted.promise;
      await replica.tasks.collection.preload();
      await replica.tasks.reschedule("task", showUpDate).isPersisted.promise;
      const before = replica.tasks.collection.get("task")!;
      let undoPersisted: Promise<unknown> | undefined;
      undoableAction({
        message: () => taskCompletionMessage(replica.tasks.collection.get("task"), today),
        act: () => replica.tasks.complete("task", today), undo: () => { const tx = replica.tasks.undoOccurrence(before, today); undoPersisted = tx.isPersisted.promise; return tx; },
        onError: (error) => { throw new Error(error); },
      });
      const toast = defaultToastController.getSnapshot()[0];
      const dateLabel = expected === "Tue, 29 Sept" ? new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(2026, 8, 29)) : expected;
      expect(toast.message).toBe(dateLabel ? `Completed · Next: ${dateLabel}` : "Completed");
      toast.action!.onPress();
      expect(replica.tasks.collection.get("task")).toEqual(before);
      await undoPersisted;
      await replica.tasks.completeForever("task").isPersisted.promise;
      expect(taskCompletionMessage(replica.snapshot().tasks[0], today)).toBe("Completed");
    } finally { await replica.close(); }
  });

  it("includes the year for next occurrences in another year", async () => {
    const replica = createTaskdoReplica({ store: createMergeableStore(), queryClient: new QueryClient(), queryKeyScope: ["year-test"], randomId: () => "task" });
    try {
      await replica.tasks.add("Repeat", null, null, { ...daily, origin: "2027-01-01" }).isPersisted.promise;
      expect(taskCompletionMessage(replica.tasks.collection.get("task"), today)).toContain("2027");
    } finally { await replica.close(); }
  });
});
