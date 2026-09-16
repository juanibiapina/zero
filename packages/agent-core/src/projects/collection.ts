import type { Collection, Transaction } from "@tanstack/db";
import type { QueryClient } from "@tanstack/react-query";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";

import {
  createEntityApi,
  createInMemoryEntityApi,
  createPersistedEntityApi,
  entityQueryKey,
  verbsFor,
  type EntityApi,
  type EntityApiDeps,
  type EntitySpec,
  type StartOfflineExecutor,
  type WarnFn,
} from "../collection/base";
import { DEFAULT_ICON } from "./display";
import type { Project, ProjectState } from "./types";

// The Project data layer: the Project verbs (add, setStatus, edit) over the
// shared collection factory in ../collection/base. Everything about offline
// persistence, reconcile and readiness lives there; this file holds only what
// is Project-specific.

// The REST calls the collection needs, already auth-bound by the caller. Web
// injects same-origin cookie closures (no token); mobile injects closures that
// carry the Clerk Bearer token.
export type ProjectsRest = {
  fetchProjects: () => Promise<Project[]>;
  // The client mints the project's id (a stable UUID), so the optimistic row and
  // the server's row share one key and the server dedupes on the id: a retried
  // add (offline outbox replay) re-sends the same id and gets the stored row
  // back, not a second project.
  addProject: (project: {
    id: string;
    title: string;
    sourceCaptureId: string | null;
  }) => Promise<Project>;
  // Persist lifecycle state; Done drops the row from the working list.
  // Idempotent on the id.
  setProjectState: (id: string, state: ProjectState) => Promise<Project>;
  // Undo completion by restoring the Project's prior lifecycle state.
  reopenProject: (id: string, state: Exclude<ProjectState, "done">) => Promise<Project>;
  // Edit a project's title/icon/description (only the present fields). Idempotent
  // on the id, so a replayed offline edit re-applies the same values.
  editProject: (id: string, fields: ProjectEditFields) => Promise<Project>;
  // Permanently delete a project. Idempotent on the id: a replayed delete of an
  // already-removed project resolves without error.
  deleteProject: (id: string) => Promise<void>;
};

// The fields an ordinary edit may change. Lifecycle state has its own verb.
export type ProjectEditFields = {
  title?: string;
  icon?: string;
  description?: string | null;
};

// One handle over the Project data layer. Both Projects screens read
// `collection` through a live query and write with `add` / `setState` / `edit`,
// which return the underlying transaction so the page can surface a write error
// via `tx.isPersisted.promise`.
export type ProjectsApi = {
  collection: Collection<Project, string>;
  add: (title: string, sourceCaptureId?: string | null) => Transaction;
  setState: (id: string, state: ProjectState) => Transaction;
  reopen: (project: Project) => Transaction;
  edit: (id: string, fields: ProjectEditFields) => Transaction;
  remove: (id: string) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

// The react-query key the in-memory collection reads through. Distinct from the
// Capture and Task keys so the collections never share a cache entry.
export const PROJECTS_QUERY_KEY = entityQueryKey("projects");

// Pick the edited fields out of a mutation's changed-field set. Only the fields
// an edit may touch (title/icon/description) are forwarded to the server; state
// has its own verb. Reading `changes` (not the whole row) means an icon-only
// edit sends only `{ icon }`, never clobbering a title with a stale value.
function editFieldsFromChanges(changes: Partial<Project>): ProjectEditFields {
  const fields: ProjectEditFields = {};
  if ("title" in changes && changes.title !== undefined)
    fields.title = changes.title;
  if ("icon" in changes && changes.icon !== undefined)
    fields.icon = changes.icon;
  if ("description" in changes) fields.description = changes.description ?? null;
  return fields;
}

// The verb table. Each key is the outbox mutationFn name. The state refactor
// intentionally starts a new outbox epoch, so the canonical key is renamed too.
export function projectsSpec(rest: ProjectsRest) {
  const v = verbsFor<Project>();
  const verbs = {
    addProject: v.insert<{ title: string; sourceCaptureId: string | null }>({
      row: ({ title, sourceCaptureId }) => ({
        title,
        icon: DEFAULT_ICON,
        description: null,
        state: "in-play",
        sourceCaptureId,
      }),
      persist: (row) =>
        rest.addProject({
          id: row.id,
          title: row.title,
          sourceCaptureId: row.sourceCaptureId ?? null,
        }),
    }),
    setProjectState: v.update<{ id: string; state: ProjectState }>({
      id: ({ id }) => id,
      draft:
        ({ state }) =>
        (draft) => {
          draft.state = state;
        },
      matches: ({ changes }) => "state" in changes,
      persist: (id, { modified }) => rest.setProjectState(id, modified.state),
    }),
    reopenProject: v.revive<Project>({
      id: (project) => project.id,
      row: (project) => ({ ...project }),
      draft: (project) => (draft) => {
        Object.assign(draft, project);
      },
      persist: (id, _mutation, project) => {
        if (!project || project.state === "done") {
          throw new Error("Project Undo is missing its prior lifecycle state");
        }
        return rest.reopenProject(id, project.state);
      },
    }),
    editProject: v.update<{ id: string; fields: ProjectEditFields }>({
      id: ({ id }) => id,
      // Set each present field in place so the sheet and the row reflect the
      // change immediately.
      draft:
        ({ fields }) =>
        (draft) => {
          if (fields.title !== undefined) draft.title = fields.title;
          if (fields.icon !== undefined) draft.icon = fields.icon;
          if (fields.description !== undefined)
            draft.description = fields.description;
        },
      matches: () => true,
      persist: (id, { changes }) =>
        rest.editProject(id, editFieldsFromChanges(changes)),
      // An edit commits on every blur; do not re-pull the list each time.
      refetchAfter: false,
    }),
    deleteProject: v.delete<{ id: string }>({
      id: ({ id }) => id,
      persist: (id) => rest.deleteProject(id),
    }),
  };
  const spec: EntitySpec<Project, typeof verbs> = {
    name: "projects",
    fetch: () => rest.fetchProjects(),
    verbs,
    // A project set to Done leaves the working set the server returns.
    leavesCollection: (p) => p.state === "done",
  };
  return spec;
}

function toProjectsApi(
  api: EntityApi<Project, ReturnType<typeof projectsSpec>["verbs"]>,
): ProjectsApi {
  return {
    collection: api.collection,
    add: (title, sourceCaptureId = null) =>
      api.actions.addProject({ title, sourceCaptureId }),
    setState: (id, state) => api.actions.setProjectState({ id, state }),
    reopen: (project) => api.actions.reopenProject(project),
    edit: (id, fields) => api.actions.editProject({ id, fields }),
    remove: (id) => api.actions.deleteProject({ id }),
    offline: api.offline,
    refetch: api.refetch,
    getLoadError: api.getLoadError,
    subscribeLoadError: api.subscribeLoadError,
  };
}

// In-memory fallback (no durable offline writes); see the shared factory.
export function createInMemoryProjectsApi(deps: {
  queryClient: QueryClient;
  rest: ProjectsRest;
}): ProjectsApi {
  return toProjectsApi(
    createInMemoryEntityApi({
      spec: projectsSpec(deps.rest),
      queryClient: deps.queryClient,
    }),
  );
}

// Durable offline mode; see the shared factory.
export function createPersistedProjectsApi(deps: {
  rest: ProjectsRest;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): ProjectsApi {
  return toProjectsApi(
    createPersistedEntityApi({
      spec: projectsSpec(deps.rest),
      persistence: deps.persistence,
      startOfflineExecutor: deps.startOfflineExecutor,
      onWarn: deps.onWarn,
    }),
  );
}

// Build the Project data layer: durable offline persistence when it can start,
// else the in-memory fallback.
export async function createProjectsApi(
  deps: EntityApiDeps & { rest: ProjectsRest },
): Promise<ProjectsApi> {
  const { rest, ...base } = deps;
  return toProjectsApi(await createEntityApi({ spec: projectsSpec(rest), ...base }));
}
