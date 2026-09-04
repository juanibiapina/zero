import { createProjectsApi, type ProjectsApi } from "@zero/agent-core";

import { defineWebEntityApi } from "./entity-api";
import {
  addProject,
  deleteProject,
  editProject,
  fetchProjects,
  setProjectStatus,
} from "./projects";

export type { ProjectsApi };

// The web Project data layer, a per-tab singleton (see ./entity-api).
export const getProjectsApi = defineWebEntityApi((deps) =>
  createProjectsApi({
    ...deps,
    rest: {
      fetchProjects,
      addProject,
      setProjectStatus,
      editProject,
      deleteProject,
    },
  }),
);
