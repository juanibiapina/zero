import { compareByOrder } from "./order";
import { projectDisplayStatus } from "../projects/derive";
import type { Project } from "../projects/types";
import type { WaitingCondition } from "../waits/types";
import type { Task } from "./types";

// homeTasks is the single-list seam: given the tasks, the projects, the waiting
// conditions and the user's local `today`, it returns the ordered Home list.
// This is the one place the "what shows up" rule lives. It is the whole Home
// list now — after the single-list merge there is no separate capture inbox; a
// loose task IS the list. See docs/plans/todo-single-list-1-merge.md.
//
// The rule is open ∧ shown-up ∧ available:
//   - open: completedAt == null.
//   - shown-up: showUpDate == null (loose, always relevant) OR showUpDate <=
//     today. A future date parks the task in Upcoming, even a taken-on one —
//     date-visibility is checked before availability, so postpone changes
//     relevance, not commitment.
//   - available: a loose task (projectId null) is always available; a project
//     task is available only when it is taken on AND its project's *display*
//     status is `active`. A taken-on open task makes its project display
//     `active` even when the project has an open waiting condition (taking a
//     task on overrides waiting), so such a task shows. A parked task, a task of
//     a backlog/done project, and a task of a project waiting with nothing taken
//     on stay hidden (reachable from the project's screen).
//
// Ordered by the manual sort key (compareByOrder: sortKey asc, nulls last,
// createdAt tiebreak) so drag-reorder on Home persists. Pure and in-process;
// tested directly.
export function homeTasks(
  tasks: Task[],
  projects: Project[],
  today: string,
  conditions: WaitingCondition[] = [],
): Task[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return tasks
    .filter((t) => t.completedAt == null)
    .filter((t) => t.showUpDate == null || t.showUpDate <= today)
    .filter((t) => {
      if (t.projectId == null) return true;
      const project = byId.get(t.projectId);
      if (!project || t.takenOnAt == null) return false;
      return (
        projectDisplayStatus(project, tasks, conditions, projects) === "active"
      );
    })
    .sort(compareByOrder);
}
