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
// The rule is open ∧ available, where availability splits loose vs project on
// the show-up date (the date is now the sole commitment gate — the take-on star
// is retired; see docs/plans/todo-retire-take-on.md):
//   - open: completedAt == null.
//   - loose task (projectId null): available when shown-up, i.e. showUpDate ==
//     null (always relevant) OR showUpDate <= today. A future date parks it in
//     Upcoming; a null date keeps it on Home.
//   - project task: available only when it has a date that has ARRIVED
//     (showUpDate != null AND showUpDate <= today) AND its project's *display*
//     status is `active`. A null date means the task is groomed — it lives only
//     on the project screen, never Home (the loose/project asymmetry on null).
//     A shown-up dated open task makes its project display `active` even when the
//     project has an open waiting condition (dating a task overrides waiting), so
//     such a task shows. An undated (groomed) task, a task of a backlog/done
//     project, and a task of a project waiting with nothing dated stay hidden
//     (reachable from the project's screen).
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
    .filter((t) => {
      if (t.projectId == null) {
        // Loose: null date is always relevant; a future date parks in Upcoming.
        return t.showUpDate == null || t.showUpDate <= today;
      }
      // Project task: needs a date that has arrived (a null date is groomed).
      if (t.showUpDate == null || t.showUpDate > today) return false;
      const project = byId.get(t.projectId);
      if (!project) return false;
      return (
        projectDisplayStatus(project, tasks, today, conditions, projects) ===
        "active"
      );
    })
    .sort(compareByOrder);
}
