import type { Collection, Transaction } from "@tanstack/db";
import type { PlainDate, Recurrence } from "@zeroapps/recurrence";

import type { Task } from "./types";

export type TasksApi = {
  collection: Collection<Task, string>;
  add: (
    text: string,
    showUpDate?: string | null,
    projectId?: string | null,
    sourceCaptureId?: string | null,
    recurrence?: Recurrence | null,
  ) => Transaction;
  complete: (id: string, completedOn?: PlainDate) => Transaction;
  completeForever: (id: string) => Transaction;
  undoOccurrence: (taskBefore: Task, completedOn: PlainDate) => Transaction;
  setRecurrence: (id: string, recurrence: Recurrence | null) => Transaction;
  reopen: (task: Task) => Transaction;
  edit: (id: string, text: string) => Transaction;
  reschedule: (id: string, showUpDate: string | null) => Transaction;
  reorder: (id: string, sortKey: string) => Transaction;
  moveToProject: (id: string, projectId: string | null) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};
