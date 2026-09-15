import { projectDisplayStatus } from "./derive";
import type { Project } from "./types";
import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";

// homeCallToAction owns the whole "empty region" decision for the Home screen:
// whether a call to action shows, and which. It is the single tested seam the web
// and mobile Home screens both render from, so neither the gate nor the
// project-state -> next-action mapping is duplicated across surfaces (see
// docs/plans/todo-home-rework.md).
//
// Home is a Clarify -> Engage pipeline top to bottom:
//   - plate has tasks            -> null (render the plate; nothing to nudge)
//   - plate empty, inbox present -> null (render the inbox; the captures are the
//                                   implicit "clarify these first")
//   - plate and inbox both empty -> the project call to action below, driven by
//                                   the derived display status of the projects.
//
// `plateCount` is the length of the already-computed homeTasks list (passed in,
// not recomputed here). The plate being empty means no project is `active`
// (an active project would have a taken-on open task on the plate), so the only
// working statuses left to reflect are next / waiting / blocked / backlog. An all-`done`
// user (no next/waiting/backlog) falls into `create`, which is honest since the
// Projects list hides done projects anyway. Pure and in-process; tested directly.
export type HomeCallToAction =
  | { kind: "plan"; next: number; waiting: number; blocked: number }
  | { kind: "blocked"; blocked: number }
  | { kind: "activate-backlog"; backlog: number }
  | { kind: "create" };

export function homeCallToAction(
  plateCount: number,
  captureCount: number,
  projects: Project[],
  tasks: Task[],
  today: string,
  conditions: WaitingCondition[] = [],
): HomeCallToAction | null {
  if (plateCount > 0) return null;
  if (captureCount > 0) return null;

  let next = 0;
  let waiting = 0;
  let blocked = 0;
  let backlog = 0;
  for (const project of projects) {
    const status = projectDisplayStatus(project, tasks, today, conditions, projects);
    if (status === "next") next++;
    else if (status === "waiting") waiting++;
    else if (status === "blocked") blocked++;
    else if (status === "backlog") backlog++;
    // `active` cannot occur on an empty plate; `done` is terminal and ignored.
  }

  if (next + waiting > 0) return { kind: "plan", next, waiting, blocked };
  if (blocked > 0) return { kind: "blocked", blocked };
  if (backlog > 0) return { kind: "activate-backlog", backlog };
  return { kind: "create" };
}

// The words each call to action shows, in one place so web and mobile cannot
// drift. `title` frames the empty state, `body` is a supporting line (for `plan`
// it is the non-zero Next/Waiting count summary, e.g. "1 Next · 3 Waiting"), and
// `button` is the verb-first action that routes to Projects. Every case leads
// with the state and points at the next step (empty-state microcopy best
// practice); see docs/plans/todo-home-rework.md.
export type HomeCallToActionCopy = {
  title: string;
  body: string;
  button: string;
};

export function homeCallToActionCopy(
  action: HomeCallToAction,
): HomeCallToActionCopy {
  switch (action.kind) {
    case "plan": {
      const parts: string[] = [];
      if (action.next > 0) parts.push(`${action.next} Next`);
      if (action.waiting > 0) parts.push(`${action.waiting} Waiting`);
      if (action.blocked > 0) parts.push(`${action.blocked} Blocked`);
      return {
        title: "Nothing on your plate yet",
        body: parts.join(" · "),
        button: "Plan your day",
      };
    }
    case "blocked":
      return {
        title: "Everything is blocked",
        body: `${action.blocked} Blocked`,
        button: "Review dependencies",
      };
    case "activate-backlog":
      return {
        title: "Your plate's clear",
        body: "Everything's on the backburner. Bring a project forward to work on.",
        button: "Bring a project forward",
      };
    case "create":
      return {
        title: "Nothing on your plate yet",
        body: "Projects are the outcomes you work toward.",
        button: "Create your first project",
      };
  }
}
