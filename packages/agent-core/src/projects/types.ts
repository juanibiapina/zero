// A Project: a named, outcome-oriented container. Persistence stores only its
// deliberate lifecycle state; Active, Next, Waiting, and Blocked are calculated from its
// work and conditions. See docs/entities/project.md.

export type ProjectState = "in-play" | "backlog" | "done";

export type ProjectDisplayStatus =
  | "active"
  | "next"
  | "waiting"
  | "blocked"
  | "backlog"
  | "done";

export type Project = {
  id: string;
  title: string;
  // A single emoji. Defaults to 📁 at creation.
  icon: string;
  description: string | null;
  state: ProjectState;
  createdAt: string;
  // The capture this project was refined from, or null. Optional so legacy
  // provenance-free rows remain readable.
  sourceCaptureId?: string | null;
};
