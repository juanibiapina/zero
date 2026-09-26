import type { ProjectAfter } from "./waiting-conditions";

export type ProjectAfterConflict =
  | "id-conflict"
  | "missing-source"
  | "missing-target"
  | "target-done"
  | "self"
  | "duplicate"
  | "cycle";

export type AddProjectAfterResult =
  | { relationship: ProjectAfter }
  | { conflict: ProjectAfterConflict };
