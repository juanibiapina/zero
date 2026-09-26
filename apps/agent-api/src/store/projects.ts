export type ProjectState = "in-play" | "backlog" | "done";

export interface Project {
  id: string;
  title: string;
  icon: string;
  description: string | null;
  state: ProjectState;
  createdAt: string;
  sourceCaptureId: string | null;
}

export type ProjectDefaults = {
  icon?: string;
  description?: string | null;
  state?: ProjectState;
  sourceCaptureId?: string | null;
};
