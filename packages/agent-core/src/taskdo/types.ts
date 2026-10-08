import type { PlainDate, Recurrence } from "@zeroapps/recurrence";

export type ProjectState = "in-play" | "backlog" | "done";

export type TaskParent =
  | { kind: "project"; projectId: string }
  | { kind: "medicine"; medicineId: string; role: "restock" | null };

export type Task = {
  id: string;
  text: string;
  showUpDate: PlainDate | null;
  recurrence: Recurrence | null;
  recurrenceDate: PlainDate | null;
  createdAt: string;
  completedAt: string | null;
  parent: TaskParent | null;
  sortKey: string | null;
};

export type Project = {
  id: string;
  title: string;
  icon: string;
  description: string | null;
  state: ProjectState;
  createdAt: string;
};

type ProjectAttentionBase = {
  id: string;
  projectId: string;
  resolvedAt: string | null;
  createdAt: string;
};

export type ManualWaitingCondition = ProjectAttentionBase & {
  kind: "free-text";
  text: string;
  refId: null;
  targetStatus: null;
};

export type ProjectAfter = ProjectAttentionBase & {
  kind: "project-status";
  text: null;
  refId: string;
  targetStatus: "done";
};

export type ProjectAttention = ManualWaitingCondition | ProjectAfter;
export type WaitingCondition = ProjectAttention;

export type ProjectAfterConflict =
  | "id-conflict"
  | "missing-source"
  | "missing-target"
  | "target-done"
  | "self"
  | "duplicate"
  | "cycle";

export type TodoIssue =
  | { table: "projects"; id: string; reason: "invalid-project" }
  | {
      table: "tasks";
      id: string;
      projectId: string | null;
      reason: "invalid-task" | "invalid-recurrence" | "missing-project" | "deleted-project";
    }
  | {
      table: "conditions";
      id: string;
      projectId: string | null;
      refId: string | null;
      reason:
        | "invalid-condition"
        | "invalid-waiting"
        | "invalid-after"
        | "missing-source"
        | "missing-target"
        | "target-done"
        | "self"
        | "duplicate"
        | "cycle";
    };
