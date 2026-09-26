import type { ProjectAttention } from "../taskdo/types";
import { projectDisplayStatus } from "./derive";
import type { Project } from "./types";
import type { Task } from "../taskdo/types";

export type HomeCallToAction =
  | { kind: "plan"; next: number; waiting: number; after: number }
  | { kind: "activate-backlog"; backlog: number }
  | { kind: "after"; after: number }
  | { kind: "create" };

export function homeCallToAction(
  plateCount: number,
  captureCount: number,
  projects: Project[],
  tasks: Task[],
  today: string,
  conditions: ProjectAttention[] = [],
): HomeCallToAction | null {
  if (plateCount > 0 || captureCount > 0) return null;

  let next = 0;
  let waiting = 0;
  let after = 0;
  let backlog = 0;
  for (const project of projects) {
    const status = projectDisplayStatus(
      project,
      tasks,
      today,
      conditions,
      projects,
    );
    if (status === "next") next++;
    else if (status === "waiting") waiting++;
    else if (status === "after") after++;
    else if (status === "backlog") backlog++;
  }

  if (next + waiting > 0) return { kind: "plan", next, waiting, after };
  if (backlog > 0) return { kind: "activate-backlog", backlog };
  if (after > 0) return { kind: "after", after };
  return { kind: "create" };
}

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
      if (action.after > 0) parts.push(`${action.after} After`);
      return {
        title: "Nothing on your plate yet",
        body: parts.join(" · "),
        button: "Plan your day",
      };
    }
    case "after":
      return {
        title: "Nothing needs attention right now",
        body: `${action.after} After`,
        button: "View projects",
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
