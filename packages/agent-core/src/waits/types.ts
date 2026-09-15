// A WaitingCondition: why a project is waiting. The single shared type for the
// waiting-condition data layer, used by web and mobile. See
// docs/entities/waiting-condition.md.

export type WaitingConditionKind = "free-text" | "task-done" | "project-status";

export type WaitingCondition = {
  id: string;
  // The project this condition blocks.
  projectId: string;
  kind: WaitingConditionKind;
  // Prose condition (kind 'free-text'); null otherwise.
  text: string | null;
  // Referenced task ('task-done') or project ('project-status') id; else null.
  refId: string | null;
  // Target status the referenced project must reach ('project-status'); else null.
  targetStatus: string | null;
  // When a free-text wait was resolved or a project-completion dependency was
  // terminally settled; null while open. Other structured kinds stay derived.
  resolvedAt: string | null;
  createdAt: string;
};
