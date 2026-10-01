import { parseSchedule, toText, type Recurrence, type Schedule, type TextRange } from "@zeroapps/recurrence";
import type { Task } from "../taskdo/types";
import { scheduleLabel } from "./dates";

type CurrentTask = Pick<Task, "text" | "showUpDate" | "recurrence">;
type DraftState = {
  kind: "create" | "edit";
  text: string;
  baseline: string;
  recognizing: boolean;
  ignored: TextRange[];
  date: string | null;
};

export type TaskDraftCommit =
  | { kind: "invalid"; message: string }
  | { kind: "unchanged"; text: string }
  | { kind: "ready"; text: string; schedule?: Schedule };

export type TaskDraftView = {
  text: string;
  title: string;
  ranges: TextRange[];
  date: string | null;
  pickerDate: string | null;
  recurrence: Recurrence | null;
  label: string;
  commit: TaskDraftCommit;
};

// Immutable drafts let each platform store one value while keeping recognition
// and dismissal transitions independent of React and persistence.
export class TaskDraft {
  private constructor(private readonly state: DraftState) {}

  static create(text = ""): TaskDraft {
    return new TaskDraft({ kind: "create", text, baseline: "", recognizing: true, ignored: [], date: null });
  }

  static edit(task: CurrentTask): TaskDraft {
    return new TaskDraft({ kind: "edit", text: task.text, baseline: task.text, recognizing: false, ignored: [], date: null });
  }

  get text(): string { return this.state.text; }

  change(text: string): TaskDraft {
    if (text === this.text) return this;
    return new TaskDraft({ ...this.state, text, recognizing: true, ignored: [] });
  }

  dismiss(range: TextRange): TaskDraft {
    if (this.text.slice(range.start, range.end) !== range.text) return this;
    return new TaskDraft({ ...this.state, ignored: [...this.state.ignored, range] });
  }

  // Editing commits the typed schedule before rescheduling through the replica.
  // Creation consumes its phrase and replaces the pending schedule with a date.
  pickCreationDate(date: string | null, today: string): TaskDraft {
    if (this.state.kind !== "create") throw new Error("Commit the edited Task before choosing a date.");
    const view = this.view(today);
    return new TaskDraft({ ...this.state, text: view.ranges.length ? view.title : this.text, recognizing: false, ignored: [], date });
  }

  acknowledge(task: CurrentTask): TaskDraft { return TaskDraft.edit(task); }

  view(today: string, current?: CurrentTask | null): TaskDraftView {
    if (this.state.kind === "create") current = undefined;
    const parsed = this.state.recognizing
      ? parseSchedule(this.text, { today, weekStartsOn: "MO", ignored: this.state.ignored })
      : { kind: "none" as const };
    const recognized = parsed.kind === "scheduled";
    const title = (recognized ? parsed.remainingText : this.text).trim();
    const schedule = recognized && (title || this.state.kind === "create") ? parsed.schedule : undefined;
    const recurrence = schedule?.kind === "recurring" ? schedule.recurrence : current?.recurrence ?? null;
    const date = schedule?.kind === "once" ? schedule.date
      : schedule?.kind === "recurring" ? schedule.recurrence.origin
      : this.state.kind === "create" ? this.state.date : current?.showUpDate ?? null;
    const label = schedule?.kind !== "once" && recurrence ? toText(recurrence)
      : date ? scheduleLabel(date, today) : "No date";
    let commit: TaskDraftCommit;
    if ((recognized && !title) || (this.state.kind === "create" && !title)) {
      commit = { kind: "invalid", message: recognized ? "Enter a task title alongside the schedule." : "Enter a task title." };
    } else if (this.state.kind === "edit") {
      const text = title || current?.text || this.state.baseline;
      const edited = this.state.recognizing && (text !== this.state.baseline || schedule !== undefined);
      commit = edited && (text !== current?.text || schedule)
        ? { kind: "ready", text, schedule }
        : { kind: "unchanged", text: current?.text ?? this.state.baseline };
    } else {
      commit = { kind: "ready", text: title, schedule: schedule ?? (date ? { kind: "once", date } : undefined) };
    }
    return { text: this.text, title, ranges: recognized ? parsed.consumed : [], date, pickerDate: this.state.kind === "create" ? this.state.date : current?.showUpDate ?? null, recurrence, label, commit };
  }
}
