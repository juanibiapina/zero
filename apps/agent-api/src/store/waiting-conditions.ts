export type ManualWaitingCondition = {
  id: string;
  projectId: string;
  kind: "free-text";
  text: string;
  refId: null;
  targetStatus: null;
  resolvedAt: string | null;
  createdAt: string;
};

export type ProjectAfter = {
  id: string;
  projectId: string;
  kind: "project-status";
  text: null;
  refId: string;
  targetStatus: "done";
  resolvedAt: string | null;
  createdAt: string;
};

export type WaitingCondition = ManualWaitingCondition | ProjectAfter;
