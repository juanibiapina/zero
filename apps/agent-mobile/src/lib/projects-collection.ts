import type { QueryClient } from '@tanstack/react-query';
import {
  createProjectsApi,
  type ProjectsApi,
  type ProjectsRest,
  type StartOfflineExecutor,
} from '@zero/agent-core';

import {
  addProject,
  editProject,
  fetchProjects,
  setProjectStatus,
  type TokenGetter,
} from './api';
import { getAppOutbox, getAppPersistence } from './db';

// The current Clerk token getter, kept in a module ref so the singleton api is
// built once yet always calls Clerk's latest getToken. The hook updates this on
// every render (see use-projects-api).
let tokenGetter: TokenGetter = async () => null;

export function setProjectsTokenGetter(getToken: TokenGetter): void {
  tokenGetter = getToken;
}

let apiPromise: Promise<ProjectsApi> | null = null;

// Singleton Project data layer, shared across every tab. Building a second
// collection over the same op-sqlite file would run two sync loops on one table
// and corrupt writes, so all screens read this one instance. Never cleaned up: it
// lives for the app's lifetime, like the Captures singleton.
export function getMobileProjectsApi(
  queryClient: QueryClient,
): Promise<ProjectsApi> {
  if (!apiPromise) {
    apiPromise = createMobileProjectsApi({
      queryClient,
      getToken: () => tokenGetter(),
    });
  }
  return apiPromise;
}

// Drop the singleton so the next getMobileProjectsApi builds a fresh collection.
// For tests only: the module-level singleton otherwise leaks rows across renders
// and breaks isolation.
export function resetProjectsApiForTest(): void {
  const pending = apiPromise;
  apiPromise = null;
  if (pending) void pending.then((a) => a.collection.cleanup()).catch(() => {});
}

// Bind the cross-origin REST helpers to the current Clerk token getter so the
// shared factory stays auth-agnostic.
function makeRest(getToken: TokenGetter): ProjectsRest {
  return {
    fetchProjects: () => fetchProjects(getToken),
    addProject: (project) => addProject(getToken, project),
    setProjectStatus: (id, status) => setProjectStatus(getToken, id, status),
    editProject: (id, fields) => editProject(getToken, id, fields),
  };
}

// Build the mobile Project data layer: durable offline SQLite (op-sqlite) plus an
// outbox that retries over the native network detector, both shared with every
// other collection through the single app database and outbox. Falls back to the
// shared in-memory Query Collection when the native modules are unavailable (e.g.
// under jest), so tests need no op-sqlite mock. Sibling of createMobileCapturesApi.
export function createMobileProjectsApi(deps: {
  queryClient: QueryClient;
  getToken: TokenGetter;
}): Promise<ProjectsApi> {
  // Stashed during the async persistence step, then used by the synchronous
  // startOfflineExecutor the shared factory calls (only on the durable path).
  let startExecutor: StartOfflineExecutor | null = null;

  return createProjectsApi({
    queryClient: deps.queryClient,
    rest: makeRest(deps.getToken),
    persistence: async () => {
      const rn = await import('@tanstack/offline-transactions/react-native');
      const { storage, onlineDetector } = await getAppOutbox();
      startExecutor = (config) =>
        rn.startOfflineExecutor({ ...config, storage, onlineDetector });
      return getAppPersistence();
    },
    startOfflineExecutor: (config) => {
      if (!startExecutor) {
        throw new Error('offline executor not initialized before use');
      }
      return startExecutor(config);
    },
    onWarn: (message, error) => console.warn(message, error),
  });
}
