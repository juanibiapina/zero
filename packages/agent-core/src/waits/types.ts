// Project attention relationships share one persisted collection but expose two
// product concepts. Callers create them through purpose-specific verbs and never
// construct arbitrary kinds, references, or target statuses.

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
  // The Project this source Project is After.
  refId: string;
  targetStatus: "done";
};

export type ProjectAttention = ManualWaitingCondition | ProjectAfter;

// Compatibility name for the persisted collection. Product code should narrow
// through isManualWaitingCondition/isProjectAfter before rendering a row.
export type WaitingCondition = ProjectAttention;
