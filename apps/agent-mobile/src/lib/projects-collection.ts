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
import { useTaskDOFixtureContext } from './taskdo-fixture-context';

// The mobile Project data layer: the shared factory bound to the Clerk token,
// as one app-lifetime singleton read by the Projects screen. The mechanics
// (singleton, token ref, offline SQLite + outbox, jest fallback) are in
// ./entity-api.
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

export const getMobileProjectsApi = projects.get;
export const setProjectsTokenGetter = projects.setTokenGetter;
export const resetProjectsApiForTest = projects.resetForTest;
export const useProjectsApi = (): ProjectsApi | null => {
  const taskDO = useTaskDOFixtureContext();
  const legacy = projects.useApi();
  return taskDO?.projectsApi ?? legacy;
};
