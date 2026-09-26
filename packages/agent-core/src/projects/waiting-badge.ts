import { dayLabel } from "../tasks/dates";
import type { Task } from "../taskdo/types";
import type { ProjectAttention } from "../taskdo/types";
import { projectDisplayStatus, waitingSince, waitingUntil } from "./derive";
import type { Project } from "./types";
import { waitingLabel } from "./waiting-label";

export type WaitingBadge = { label: string; sortKey: string };

export function waitingBadge(
  project: Project,
  tasks: readonly Task[],
  conditions: readonly ProjectAttention[],
  projects: readonly Project[],
  today: string,
  now: Date = new Date(),
): WaitingBadge | null {
  if (
    projectDisplayStatus(project, tasks, today, conditions, projects) !==
    "waiting"
  ) {
    return null;
  }

  const since = waitingSince(project, conditions);
  if (since != null) {
    const elapsed = waitingLabel(since, now);
    const label = elapsed === "just now" ? elapsed : `for ${elapsed}`;
    return { label, sortKey: `a:${since}` };
  }

  const until = waitingUntil(project, tasks, today);
  return until == null
    ? null
    : { label: `until ${dayLabel(until, today)}`, sortKey: `b:${until}` };
}
