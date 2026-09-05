// A Project: the third entity of the todo app (after Capture and Task). A named,
// outcome-oriented container with a status, enriched over time. The single shared
// entity type for the Project data layer, used by web and mobile. See
// docs/entities/project.md.

// The status set. 'done' is terminal; the other four are working states. The
// union is defined now so slices A2/A3 reuse it; slice A1 only ever writes 'next'.
export type ProjectStatus = "active" | "next" | "waiting" | "backlog" | "done";

export type Project = {
  id: string;
  title: string;
  // A single emoji. Defaults to 📁 at creation; changed later from the detail
  // sheet. A plain string so the representation can evolve without a migration.
  icon: string;
  // Free-text notes (a sentence of intent). Null when unset.
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  // The capture this project was refined from, or null. Optional so existing
  // rows and optimistic drafts need not carry it.
  sourceCaptureId?: string | null;
};
