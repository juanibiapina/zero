import { createMergeableStore } from "tinybase";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MedicineModel, medicineOccurrences } from "../medicines/model";
import { PromptModel } from "../prompts/model";
import { RecordingModel } from "../recordings/model";
import { runTodoOperation, todoOperations, type OperationContext, type OperationOutcome } from "./index";

function workspace(today = "2026-03-10") {
  let next = 0;
  const ctx: OperationContext = {
    store: createMergeableStore(),
    now: () => new Date(`${today}T09:00:00Z`),
    today,
    newId: () => `id-${++next}`,
  };
  const run = (name: string, input: unknown = {}) => runTodoOperation(ctx, name, input);
  const value = <T>(outcome: OperationOutcome): T => {
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value as T;
  };
  return { ctx, run, value };
}

const daily = (origin: string) => ({
  version: 1, origin, anchor: "scheduled", weekStartsOn: "MO", pattern: { unit: "day", interval: 1 },
});

describe("todo operation catalog", () => {
  it("names every operation uniquely in MCP tool form", () => {
    const names = todoOperations.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("offers a list operation for every synchronized entity table", () => {
    const reads = todoOperations.filter((operation) => operation.kind === "read").map((operation) => operation.name);
    expect(reads).toEqual(expect.arrayContaining(["tasks_list", "projects_list", "conditions_list", "medicines_list", "shopping_list", "recordings_list", "prompts_list", "recoveries_list"]));
  });

  it("creates Tasks with generated ids and lists them in manual order", async () => {
    const { run, value } = workspace();
    value(await run("tasks_create", { text: "Buy milk" }));
    value(await run("tasks_create", { text: "Call Ana", showUpDate: "2026-03-12" }));

    const { tasks } = value<{ tasks: Array<{ id: string; text: string; showUpDate: string | null }> }>(await run("tasks_list"));
    expect(tasks.map((task) => [task.id, task.text, task.showUpDate])).toEqual([
      ["id-1", "Buy milk", null],
      ["id-2", "Call Ana", "2026-03-12"],
    ]);
  });

  it("treats a replayed create with the same id as unchanged", async () => {
    const { run } = workspace();
    await run("tasks_create", { id: "t1", text: "Once" });
    expect(await run("tasks_create", { id: "t1", text: "Once" })).toMatchObject({ ok: true, changed: false });
  });

  it("rejects invalid input with a readable error and writes nothing", async () => {
    const { run, value } = workspace();
    const outcome = await run("tasks_create", { text: "", showUpDate: "tomorrow" });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/showUpDate/);
    expect(value<{ tasks: unknown[] }>(await run("tasks_list")).tasks).toEqual([]);
  });

  it("shows which Medicine a Task belongs to and does not let agents set it", async () => {
    const { ctx, run, value } = workspace();
    new MedicineModel(ctx.store, ctx.now).add("m", { name: "Pill", instructions: null, startsOn: "2026-03-10", endsOn: null, paused: false,
      weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [{ id: "a", remindAt: "07:00", alarmAt: "08:00", amount: 1 }] });
    new MedicineModel(ctx.store, ctx.now, () => "restock").setSupply("m", { pillsLeft: 3, leadDays: 14 });
    expect((await run("tasks_create", { id: "plain", text: "Plain", parent: { kind: "medicine", medicineId: "m", role: "restock" } })).ok).toBe(false);
    value(await run("tasks_create", { id: "plain", text: "Plain" }));
    const { tasks } = value<{ tasks: Array<{ id: string; parent: unknown }> }>(await run("tasks_list"));
    expect(tasks.map(({ id, parent }) => ({ id, parent }))).toEqual([
      { id: "restock", parent: { kind: "medicine", medicineId: "m", role: "restock" } },
      { id: "plain", parent: null },
    ]);
    const restock = value<{ tasks: Array<{ id: string }> }>(await run("tasks_list", { parent: { kind: "medicine", medicineId: "m" } }));
    expect(restock.tasks.map((task) => task.id)).toEqual(["restock"]);
  });

  it("reports model conflicts by name", async () => {
    const { run } = workspace();
    expect(await run("tasks_create", { text: "Orphan", parent: { kind: "project", projectId: "nope" } })).toEqual({ ok: false, error: "missing-project" });
    expect(await run("tasks_complete", { id: "nope" })).toEqual({ ok: false, error: "missing-task" });
    expect(await run("no_such_tool")).toEqual({ ok: false, error: "unknown operation: no_such_tool" });
  });

  it("advances a recurring Task on completion and does not advance twice on replay", async () => {
    const { run, value } = workspace();
    value(await run("tasks_create", { id: "r", text: "Stretch", recurrence: daily("2026-03-10") }));

    const first = value<{ recurrenceDate: string; completedAt: string | null }>(await run("tasks_complete", { id: "r" }));
    expect(first).toMatchObject({ recurrenceDate: "2026-03-11", completedAt: null });

    const { tasks } = value<{ tasks: Array<{ recurrenceDate: string }> }>(await run("tasks_list"));
    expect(tasks[0].recurrenceDate).toBe("2026-03-11");
  });

  it("completes and reopens a one-off Task", async () => {
    const { run, value } = workspace();
    value(await run("tasks_create", { id: "t", text: "File taxes" }));
    value(await run("tasks_complete", { id: "t" }));
    expect(value<{ tasks: unknown[] }>(await run("tasks_list")).tasks).toEqual([]);
    value(await run("tasks_reopen", { id: "t" }));
    expect(value<{ tasks: unknown[] }>(await run("tasks_list")).tasks).toHaveLength(1);
  });

  it("reports calculated Project attention and cascades Project deletion", async () => {
    const { run, value } = workspace();
    value(await run("projects_create", { id: "p", title: "Move flat" }));
    value(await run("projects_create", { id: "q", title: "Paint walls" }));
    value(await run("tasks_create", { text: "Book van", parent: { kind: "project", projectId: "p" } }));
    value(await run("waiting_create", { projectId: "p", text: "Landlord reply" }));
    value(await run("after_create", { projectId: "q", afterProjectId: "p" }));

    const { projects } = value<{ projects: Array<{ id: string; attention: string }> }>(await run("projects_list"));
    expect(projects.map((project) => [project.id, project.attention])).toEqual([["p", "waiting"], ["q", "after"]]);

    expect(await run("after_create", { projectId: "p", afterProjectId: "q" })).toEqual({ ok: false, error: "cycle" });
    expect(value(await run("projects_delete", { id: "p" }))).toEqual({ tasks: 1, conditions: 1, afters: 1 });
    expect(value<{ conditions: unknown[] }>(await run("conditions_list")).conditions).toEqual([]);
  });

  it("lists done Projects only when asked", async () => {
    const { run, value } = workspace();
    value(await run("projects_create", { id: "p", title: "Old", state: "done" }));
    expect(value<{ projects: unknown[] }>(await run("projects_list")).projects).toEqual([]);
    expect(value<{ projects: unknown[] }>(await run("projects_list", { includeDone: true })).projects).toHaveLength(1);
  });

  it("only reads Medicines, because the phone sets alarms only when the app sees a change", () => {
    const medicineOperations = todoOperations.filter((operation) => operation.name.startsWith("medicines_"));
    expect(medicineOperations.map((operation) => [operation.name, operation.kind])).toEqual([["medicines_list", "read"]]);
  });

  it("lists Medicines and their Doses since a date", async () => {
    const { ctx, run, value } = workspace();
    const model = new MedicineModel(ctx.store, ctx.now);
    const medicine = model.add("m", {
      name: "Vitamin D", instructions: null, startsOn: "2026-03-01", endsOn: null, paused: false, weekdays: [1, 2, 3, 4, 5, 6, 7],
      doses: [{ id: "morning", remindAt: "08:00", alarmAt: "08:30", amount: 1 }],
    });
    const [old] = medicineOccurrences(medicine, "2026-03-02");
    const [recent] = medicineOccurrences(medicine, "2026-03-09");
    model.take(old, "a1");
    model.take(recent, "a2");

    const listed = value<{ today: string; medicines: Array<{ id: string }>; doses: Array<{ id: string }> }>(await run("medicines_list"));
    expect(listed.today).toBe("2026-03-10");
    expect(listed.medicines.map((m) => m.id)).toEqual(["m"]);
    expect(listed.doses.map((dose) => dose.id)).toEqual([recent.id]);
  });

  it("lists as-needed Medicines and their intakes since a date", async () => {
    const { ctx, run, value } = workspace();
    const model = new MedicineModel(ctx.store, ctx.now);
    model.add("m", { name: "Ibuprofen", instructions: null, startsOn: "2026-03-01", endsOn: null, paused: false, asNeeded: true, weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [] });
    model.takeAsNeeded("m", 2, "old", "2026-03-01T10:00:00.000Z");
    model.takeAsNeeded("m", 1, "recent", "2026-03-09T10:00:00.000Z");

    const listed = value<{ medicines: Array<{ id: string; asNeeded: boolean }>; intakes: Array<{ id: string; amount: number }> }>(await run("medicines_list"));
    expect(listed.medicines).toEqual([expect.objectContaining({ id: "m", asNeeded: true })]);
    expect(listed.intakes).toEqual([expect.objectContaining({ id: "recent", amount: 1 })]);
  });

  it("keeps a Shopping list that agents can add to, reorder, edit, and buy from", async () => {
    const { run, value } = workspace();
    value(await run("shopping_add", { text: "Milk" }));
    value(await run("shopping_add", { id: "eggs", text: "Eggs" }));
    expect(await run("shopping_add", { id: "eggs", text: "Eggs" })).toMatchObject({ ok: true, changed: false });
    value(await run("shopping_add", { text: "Bread" }));

    value(await run("shopping_move", { id: "id-2", toIndex: 0 }));
    value(await run("shopping_update", { id: "id-1", text: "Oat milk" }));
    const texts = async () => value<{ items: Array<{ text: string }> }>(await run("shopping_list")).items.map((item) => item.text);
    const before = await texts();
    expect(before[0]).toBe("Bread");
    expect(before).toContain("Oat milk");

    value(await run("shopping_buy", { id: "eggs" }));
    expect(await texts()).toEqual(before.filter((text) => text !== "Eggs"));
    value(await run("shopping_unbuy", { id: "eggs" }));
    expect(await texts()).toEqual(before);
    expect(value<{ tasks: unknown[] }>(await run("tasks_list")).tasks).toEqual([]);
    expect(await run("shopping_buy", { id: "gone" })).toEqual({ ok: false, error: "missing-item" });
  });

  it("never deletes Recordings, because deleting one also deletes its audio on the phone", () => {
    const recordingOperations = todoOperations.filter((operation) => operation.name.startsWith("recordings_"));
    expect(recordingOperations.map((operation) => [operation.name, operation.kind])).toEqual([
      ["recordings_list", "read"],
      ["recordings_get", "read"],
      ["recordings_mark_handled", "write"],
    ]);
  });

  describe("Recordings", () => {
    const transcript = (text: string, verbatim = text, title = text === "" ? "" : "A title") => ({ text, verbatim, title, model: "stt+cleanup", transcribedAt: "2026-03-10T08:00:00.000Z" });

    function withRecordings() {
      const ws = workspace();
      const model = new RecordingModel(ws.ctx.store);
      const add = (id: string, startedAt: string, timeZone = "Europe/Berlin") =>
        model.add({ id, startedAt, timeZone, durationMs: 4200, source: "app", device: "Pixel 7" });
      add("late", "2026-03-09T23:30:00.000Z");
      add("silent", "2026-03-08T07:05:00.000Z");
      add("pending", "2026-03-07T12:00:00.000Z", "America/New_York");
      add("old", "2026-03-01T09:00:00.000Z");
      model.setTranscript("late", transcript("Call the plumber on Friday", "Call the, uh, plumber on Thursday, no, Friday", "Call the plumber"));
      model.setTranscript("silent", transcript(""));
      model.setTranscript("old", transcript("Old note"));
      return ws;
    }

    it("lists the last week's Recordings newest first, with their text and local time where they were recorded", async () => {
      const { run, value } = withRecordings();
      expect(value(await run("recordings_list"))).toEqual({
        recordings: [
          { id: "late", startedAt: "2026-03-09T23:30:00.000Z", timeZone: "Europe/Berlin", recordedOn: "2026-03-10", recordedAt: "00:30",
            durationMs: 4200, device: "Pixel 7", transcript: { title: "Call the plumber", text: "Call the plumber on Friday" }, handledAt: null, tasks: [] },
          { id: "silent", startedAt: "2026-03-08T07:05:00.000Z", timeZone: "Europe/Berlin", recordedOn: "2026-03-08", recordedAt: "08:05",
            durationMs: 4200, device: "Pixel 7", transcript: "no-speech", handledAt: null, tasks: [] },
          { id: "pending", startedAt: "2026-03-07T12:00:00.000Z", timeZone: "America/New_York", recordedOn: "2026-03-07", recordedAt: "07:00",
            durationMs: 4200, device: "Pixel 7", transcript: "pending", handledAt: null, tasks: [] },
        ],
      });
    });

    it("lists Recordings since a day in their own calendar", async () => {
      const { run, value } = withRecordings();
      const ids = async (since: string) => value<{ recordings: Array<{ id: string }> }>(await run("recordings_list", { since })).recordings.map((r) => r.id);
      expect(await ids("2026-03-10")).toEqual(["late"]);
      expect(await ids("2026-03-01")).toEqual(["late", "silent", "pending", "old"]);
    });

    it("reads one Recording with its verbatim words", async () => {
      const { run, value } = withRecordings();
      expect(value(await run("recordings_get", { id: "late" }))).toMatchObject({
        id: "late",
        recordedOn: "2026-03-10",
        transcript: {
          text: "Call the plumber on Friday",
          verbatim: "Call the, uh, plumber on Thursday, no, Friday",
          title: "Call the plumber",
          model: "stt+cleanup",
          transcribedAt: "2026-03-10T08:00:00.000Z",
        },
      });
      expect(value(await run("recordings_get", { id: "pending" }))).toMatchObject({ transcript: "pending" });
      expect(await run("recordings_get", { id: "gone" })).toEqual({ ok: false, error: "missing-recording" });
    });

    it("marks Recordings handled so the next list leaves them out", async () => {
      const { run, value } = withRecordings();
      const ids = async (handled?: boolean) =>
        value<{ recordings: Array<{ id: string }> }>(await run("recordings_list", { handled })).recordings.map((r) => r.id);

      expect(await run("recordings_mark_handled", { id: "late" })).toMatchObject({ ok: true, changed: true, value: { id: "late", handledAt: "2026-03-10T09:00:00.000Z" } });
      expect(await run("recordings_mark_handled", { id: "late" })).toMatchObject({ ok: true, changed: false });
      expect(await ids(false)).toEqual(["silent", "pending"]);
      expect(await ids(true)).toEqual(["late"]);
      expect(value(await run("recordings_get", { id: "late" }))).toMatchObject({ handledAt: "2026-03-10T09:00:00.000Z" });

      expect(await run("recordings_mark_handled", { id: "late", handled: false })).toMatchObject({ ok: true, changed: true, value: { handledAt: null } });
      expect(await ids(false)).toEqual(["late", "silent", "pending"]);
      expect(await run("recordings_mark_handled", { id: "gone" })).toEqual({ ok: false, error: "missing-recording" });
    });

    it("links Tasks to the Recording they came from, both ways, until the Recording is deleted", async () => {
      const { ctx, run, value } = withRecordings();
      value(await run("tasks_create", { id: "t1", text: "Call the plumber", recordingId: "late" }));
      value(await run("tasks_create", { id: "t2", text: "Book Friday", recordingId: "late" }));
      value(await run("tasks_complete", { id: "t2" }));
      value(await run("tasks_create", { id: "t3", text: "Unrelated" }));
      expect(await run("tasks_create", { text: "Lost", recordingId: "gone" })).toEqual({ ok: false, error: "missing-recording" });

      const listed = value<{ tasks: Array<{ id: string; recordingId: string | null }> }>(await run("tasks_list")).tasks;
      expect(listed.map(({ id, recordingId }) => [id, recordingId])).toEqual([["t1", "late"], ["t3", null]]);
      expect(value(await run("recordings_get", { id: "late" }))).toMatchObject({
        tasks: [
          { id: "t1", text: "Call the plumber", completedAt: null },
          { id: "t2", text: "Book Friday", completedAt: "2026-03-10T09:00:00.000Z" },
        ],
      });

      value(await run("tasks_update", { id: "t3", recordingId: "silent" }));
      value(await run("tasks_update", { id: "t1", recordingId: null }));
      const silent = value<{ recordings: Array<{ id: string; tasks: Array<{ id: string }> }> }>(await run("recordings_list"))
        .recordings.find((recording) => recording.id === "silent");
      expect(silent?.tasks.map((task) => task.id)).toEqual(["t3"]);

      new RecordingModel(ctx.store).remove("silent");
      const after = value<{ tasks: Array<{ id: string; text: string; recordingId: string | null }> }>(await run("tasks_list")).tasks;
      expect(after.find((task) => task.id === "t3")).toMatchObject({ text: "Unrelated", recordingId: null });
    });
  });

  describe("Prompts", () => {
    const ask = { title: "Which flight?", text: "Two flights fit. Which one should I book?", suggestions: ["The 9:40", "The 14:05"] };

    afterEach(() => { vi.useRealTimers(); });

    it("asks the user with a generated id and reads their answer as text", async () => {
      const { ctx, run, value } = workspace();
      const created = value<{ id: string; status: string }>(await run("prompts_create", ask));
      expect(created).toMatchObject({ id: "id-1", status: "unread", answer: null });

      new PromptModel(ctx.store, ctx.now).answer("id-1", "Neither, prices will drop");

      expect(value(await run("prompts_get", { id: "id-1" }))).toEqual({
        id: "id-1", ...ask, createdAt: "2026-03-10T09:00:00.000Z", status: "answered",
        answer: { text: "Neither, prices will drop", answeredAt: "2026-03-10T09:00:00.000Z" },
        handledAt: null, changedAfterHandling: null,
      });
      expect(await run("prompts_get", { id: "gone" })).toEqual({ ok: false, error: "missing-prompt" });
    });

    it("lists open and answered Prompts", async () => {
      const { ctx, run, value } = workspace();
      await run("prompts_create", { id: "open", ...ask });
      await run("prompts_create", { id: "done", ...ask, suggestions: [] });
      new PromptModel(ctx.store).answer("done", "Yes");
      const ids = async (status?: string) =>
        value<{ prompts: Array<{ id: string }> }>(await run("prompts_list", status ? { status } : {})).prompts.map((p) => p.id).sort();
      expect(await ids()).toEqual(["done", "open"]);
      expect(await ids("open")).toEqual(["open"]);
      expect(await ids("answered")).toEqual(["done"]);
    });

    it("marks a Prompt handled, and reports an answer that changed after that", async () => {
      const { ctx, run, value } = workspace();
      await run("prompts_create", { id: "p", ...ask });
      await run("prompts_create", { id: "other", ...ask });
      new PromptModel(ctx.store, ctx.now).answer("p", "The 9:40");
      new PromptModel(ctx.store, ctx.now).answer("other", "The 9:40");
      const ids = async (handled: boolean) =>
        value<{ prompts: Array<{ id: string }> }>(await run("prompts_list", { status: "answered", handled })).prompts.map((p) => p.id);

      expect(await run("prompts_mark_handled", { id: "p" })).toMatchObject({
        ok: true, changed: true, value: { handledAt: "2026-03-10T09:00:00.000Z", changedAfterHandling: null },
      });
      expect(await ids(false)).toEqual(["other"]);
      expect(await ids(true)).toEqual(["p"]);

      ctx.store.setCell("prompts", "p", "answer", JSON.stringify({ text: "The 14:05", answeredAt: "2026-03-10T09:30:00.000Z" }));
      expect(value(await run("prompts_get", { id: "p" }))).toMatchObject({
        answer: { text: "The 14:05" },
        handledAt: null,
        changedAfterHandling: { handledAt: "2026-03-10T09:00:00.000Z", handledAnswer: "The 9:40" },
      });
      expect((await ids(false)).sort()).toEqual(["other", "p"]);

      expect(await run("prompts_mark_handled", { id: "other", handled: false })).toMatchObject({ ok: true, changed: false });
      expect(await run("prompts_mark_handled", { id: "gone" })).toEqual({ ok: false, error: "missing-prompt" });
    });

    it("waits until the user answers", async () => {
      const { ctx, run, value } = workspace();
      await run("prompts_create", { id: "p", ...ask });
      const waiting = run("prompts_wait", { id: "p" });
      new PromptModel(ctx.store).answer("p", "The 9:40");
      expect(value(await waiting)).toMatchObject({ status: "answered", answer: { text: "The 9:40" } });
    });

    it("stops waiting at the timeout and returns the Prompt still open", async () => {
      vi.useFakeTimers();
      const { run, value } = workspace();
      await run("prompts_create", { id: "p", ...ask });
      const waiting = run("prompts_wait", { id: "p", timeoutSeconds: 5 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(value(await waiting)).toMatchObject({ status: "unread", answer: null });
    });

    it("stops waiting when the Prompt is deleted", async () => {
      const { run } = workspace();
      await run("prompts_create", { id: "p", ...ask });
      const waiting = run("prompts_wait", { id: "p" });
      expect(await run("prompts_delete", { id: "p" })).toMatchObject({ ok: true, changed: true });
      expect(await waiting).toEqual({ ok: false, error: "missing-prompt" });
    });

    it("marks only deletion as destructive", () => {
      const kinds = todoOperations.filter((operation) => operation.name.startsWith("prompts_")).map((operation) => [operation.name, operation.kind]);
      expect(kinds).toEqual([
        ["prompts_create", "write"],
        ["prompts_wait", "read"],
        ["prompts_get", "read"],
        ["prompts_list", "read"],
        ["prompts_mark_handled", "write"],
        ["prompts_delete", "destructive"],
      ]);
    });
  });

  it("reports invalid synchronized rows as recoveries instead of listing them", async () => {
    const { ctx, run, value } = workspace();
    ctx.store.setRow("tasks", "bad", { text: "Lost", createdAt: "2026-03-01T00:00:00Z", parent: JSON.stringify({ kind: "project", projectId: "gone" }) });

    expect(value(await run("recoveries_list"))).toEqual({
      todo: [{ table: "tasks", id: "bad", projectId: "gone", reason: "missing-project" }],
      medicines: [],
    });
  });
});
