import type { Collection, Transaction } from "@tanstack/db";

import type { ProjectAttention } from "./types";

export type AddProjectAttention =
  | { projectId: string; kind: "free-text"; text: string; refId: null; targetStatus: null }
  | { projectId: string; kind: "project-status"; text: null; refId: string; targetStatus: "done" };

export type WaitsApi = {
  collection: Collection<ProjectAttention, string>;
  addWaiting: (projectId: string, text: string) => Transaction;
  addAfter: (projectId: string, afterProjectId: string) => Transaction;
  resolveWaiting: (id: string) => Transaction;
  remove: (id: string) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};
