import type { Task } from "./types";

// homeTasks is the availability seam: given the task collection (and, in later
// slices, the projects and waiting conditions), it returns the ordered list of
// tasks that show up in the Home top region. This is the single place the "what
// shows up" rule lives, so it deepens one function at a time:
//
//   slice 1 (now): every open task, oldest first.
//   slice 3:       gated to loose tasks + tasks whose project is active.
//   slice 4:       further gated to tasks the user has taken on.
//
// Pure and in-process (plain arrays in, list out), so it is tested directly
// through this interface with no adapter. `showUpDate` is deliberately ignored:
// availability, not the date, decides what shows up (see docs/plans).
export function homeTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.completedAt == null)
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
}
