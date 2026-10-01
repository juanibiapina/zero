import { toText } from "@zeroapps/recurrence";
import type { Task } from "../taskdo/types";
import { parseLocalDay, tomorrow } from "./dates";

export function taskRecurrenceLabel(task: Pick<Task, "recurrence">): string | null {
  if (!task.recurrence) return null;
  let text = toText(task.recurrence).replace(/^every!/, "every");
  if (task.recurrence.anchor === "completed") text += " after completion";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Read the optimistic result after completion, including overdue catch-up dates.
export function taskCompletionMessage(task: Task | undefined, today: string): string {
  if (!task?.recurrence || task.completedAt || !task.recurrenceDate) return "Completed";
  const date = task.recurrenceDate;
  const label = date === today ? "Today" : date === tomorrow(today) ? "Tomorrow"
    : new Intl.DateTimeFormat(undefined, {
      weekday: "short", day: "numeric", month: "short",
      ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {}),
    }).format(parseLocalDay(date));
  return `Completed · Next: ${label}`;
}
