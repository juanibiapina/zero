import { describe, expect, it } from "vitest";
import { TaskDraft } from "./draft";

const today = "2026-10-01";
const recurrence = { version: 1 as const, origin: today, anchor: "scheduled" as const, weekStartsOn: "MO" as const, pattern: { unit: "day" as const, interval: 1 } };
const task = { text: "Water plants", showUpDate: today, recurrence };

function dismissFirst(draft: TaskDraft): TaskDraft {
  return draft.dismiss(draft.view(today).ranges[0]);
}

describe("Task drafts", () => {
  it.each(["create", "edit"] as const)("prepares a typed repeat in a %s draft", (kind) => {
    const draft = (kind === "create" ? TaskDraft.create() : TaskDraft.edit(task)).change("Water plants every week");
    expect(draft.view(today, task)).toMatchObject({ title: "Water plants", label: "every week on Thursday", ranges: [{ text: "every week" }], commit: { kind: "ready", text: "Water plants", schedule: { kind: "recurring", recurrence: { pattern: { unit: "week" } } } } });
  });

  it("leaves an unchanged stored title literal and retains a newer stored title", () => {
    const draft = TaskDraft.edit({ ...task, text: "Review every day" });
    expect(draft.view(today, { ...task, text: "Updated elsewhere" })).toMatchObject({ ranges: [], commit: { kind: "unchanged", text: "Updated elsewhere" } });
  });

  it("preserves scheduling when successive recognized phrases are dismissed", () => {
    let draft = TaskDraft.edit(task).change("Work today tomorrow");
    expect(draft.view(today, task).ranges[0].text).toBe("tomorrow");
    draft = dismissFirst(draft);
    expect(draft.view(today, task).ranges[0].text).toBe("today");
    draft = dismissFirst(draft);
    expect(draft.view(today, task)).toMatchObject({ title: "Work today tomorrow", ranges: [], date: today, recurrence, commit: { kind: "ready", text: "Work today tomorrow", schedule: undefined } });
  });

  it("retains time words and previews a postponement ahead of an existing repeat", () => {
    expect(TaskDraft.edit(task).change("Call tomorrow at 3pm").view(today, task)).toMatchObject({ title: "Call at 3pm", date: "2026-10-02", recurrence, label: "Tomorrow", commit: { kind: "ready", schedule: { kind: "once", date: "2026-10-02" } } });
  });

  it.each(["create", "edit"] as const)("rejects a schedule-only %s draft", (kind) => {
    const draft = (kind === "create" ? TaskDraft.create() : TaskDraft.edit(task)).change("every day");
    expect(draft.view(today, task).commit).toEqual({ kind: "invalid", message: "Enter a task title alongside the schedule." });
  });

  it("retains the current title on an ordinary empty edit", () => {
    expect(TaskDraft.edit(task).change(" ").view(today, task).commit).toEqual({ kind: "unchanged", text: task.text });
  });

  it("uses a manual creation date without creating the typed repeat or reparsing remaining words", () => {
    const draft = TaskDraft.create("Work today every day").pickCreationDate("2026-10-03", today);
    expect(draft.view(today)).toMatchObject({ ranges: [], date: "2026-10-03", recurrence: null, commit: { kind: "ready", schedule: { kind: "once", date: "2026-10-03" } } });
    expect(draft.view(today).title).toContain("today");
  });

  it("normalizes an applied edit without reapplying its schedule after a manual action", () => {
    const draft = TaskDraft.edit(task).change("Work today every day");
    const prepared = draft.view(today, task).commit;
    if (prepared.kind !== "ready") throw new Error("Expected an edit");
    const current = { ...task, text: prepared.text, recurrence: null, showUpDate: "2026-10-03" };
    const acknowledged = draft.acknowledge(current);
    expect(acknowledged.view(today, current)).toMatchObject({ ranges: [], date: "2026-10-03", recurrence: null, commit: { kind: "unchanged", text: prepared.text } });
    expect(acknowledged.change("Call tomorrow").view(today, current).commit).toMatchObject({ kind: "ready", schedule: { kind: "once" } });
  });

  it("resolves against the current day while a draft remains open", () => {
    const draft = TaskDraft.create("Call tomorrow");
    expect(draft.view(today).date).toBe("2026-10-02");
    expect(draft.view("2026-10-02").date).toBe("2026-10-03");
  });

  it("retains dismissal on an unchanged input event and recognizes again after a text change", () => {
    const draft = dismissFirst(TaskDraft.create("Call tomorrow"));
    expect(draft.change(draft.text).view(today).ranges).toEqual([]);
    expect(draft.change("Call tomorrow!").view(today).ranges[0].text).toBe("tomorrow");
  });

  it("ignores a stale dismissal from another text value", () => {
    const draft = TaskDraft.create("Call tomorrow");
    const range = draft.view(today).ranges[0];
    expect(draft.change("Read every day").dismiss(range).view(today).ranges[0].text).toBe("every day");
  });
});
