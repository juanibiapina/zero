import type { Collection, Transaction } from "@tanstack/db";

import type { Project, ProjectState } from "./types";

export type ProjectEditFields = {
  title?: string;
  icon?: string;
  description?: string | null;
};

export type ProjectsApi = {
  collection: Collection<Project, string>;
  add: (title: string, sourceCaptureId?: string | null) => Transaction;
  setState: (id: string, state: ProjectState) => Transaction;
  reopen: (project: Project) => Transaction;
  edit: (id: string, fields: ProjectEditFields) => Transaction;
  remove: (id: string) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};
