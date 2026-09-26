import {
  createProjectsApi,
  type ProjectsApi,
  type ProjectsRest,
} from '@zero/agent-core';

import {
  addProject,
  deleteProject,
  editProject,
  fetchProjects,
  setProjectState,
  type TokenGetter,
} from './api';
import { defineMobileEntityApi } from './entity-api';

// REST-backed test adapter for screen tests. Production screens use the
// TinyBase APIs exposed by todo-data-context.
function makeRest(getToken: TokenGetter): ProjectsRest {
  return {
    fetchProjects: () => fetchProjects(getToken),
    addProject: (project) => addProject(getToken, project),
    setProjectState: (id, state) => setProjectState(getToken, id, state),
    reopenProject: (id, state) => setProjectState(getToken, id, state),
    editProject: (id, fields) => editProject(getToken, id, fields),
    deleteProject: (id) => deleteProject(getToken, id),
  };
}

const projects = defineMobileEntityApi<ProjectsApi, ProjectsRest>({
  create: createProjectsApi,
  makeRest,
});

export const resetProjectsApiForTest = projects.resetForTest;
export const useRestProjectsApiForTest = projects.useApi;
