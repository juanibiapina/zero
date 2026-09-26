export type { Project, ProjectState } from "../taskdo/types";

export type ProjectDisplayStatus =
  | "active"
  | "next"
  | "waiting"
  | "after"
  | "backlog"
  | "done";
