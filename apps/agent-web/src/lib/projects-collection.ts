import { startOfflineExecutor } from "@tanstack/offline-transactions";
import { createProjectsApi, type ProjectsApi } from "@zero/agent-core";

import { queryClient } from "./captures-collection";
import { getAppPersistence } from "./db";
import {
  addProject,
  editProject,
  fetchProjects,
  setProjectStatus,
} from "./projects";

export type { ProjectsApi };

let apiPromise: Promise<ProjectsApi> | null = null;

// Singleton: the OPFS database and outbox are opened once per tab. Falls back to
// the in-memory Query Collection if durable persistence cannot start (private
// browsing, older browsers). Web auth is the same-origin cookie, so the REST
// closures carry no token.
export function getProjectsApi(): Promise<ProjectsApi> {
  if (!apiPromise) {
    apiPromise = createProjectsApi({
      queryClient,
      rest: { fetchProjects, addProject, setProjectStatus, editProject },
      persistence: () => getAppPersistence(),
      startOfflineExecutor,
      onWarn: (message, error) => console.warn(message, error),
    });
  }
  return apiPromise;
}
