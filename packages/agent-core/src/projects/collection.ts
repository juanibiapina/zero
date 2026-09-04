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
import type { Project, ProjectStatus } from "./types";

// The Project data layer: the Project verbs (add, setStatus, edit) over the
// shared collection factory in ../collection/base. Everything about offline
// persistence, reconcile and readiness lives there; this file holds only what
// is Project-specific.

// The name-only creation defaults, matching what the server fills. Kept here so
// the optimistic row is identical to the server row (no temp-to-real swap).
const DEFAULT_ICON = "📁";

// The REST calls the collection needs, already auth-bound by the caller. Web
// injects same-origin cookie closures (no token); mobile injects closures that
// carry the Clerk Bearer token.
export type ProjectsRest = {
  fetchProjects: () => Promise<Project[]>;
  // The client mints the project's id (a stable UUID), so the optimistic row and
  // the server's row share one key and the server dedupes on the id: a retried
  // add (offline outbox replay) re-sends the same id and gets the stored row
  // back, not a second project.
  addProject: (project: { id: string; title: string }) => Promise<Project>;
  // Move a project to another status (including the terminal 'done', which drops
  // it from the working list). Idempotent on the id.
  setProjectStatus: (id: string, status: ProjectStatus) => Promise<Project>;
  // Edit a project's title/icon/description (only the present fields). Idempotent
  // on the id, so a replayed offline edit re-applies the same values.
  editProject: (id: string, fields: ProjectEditFields) => Promise<Project>;
};

// The fields a detail-sheet edit may change. Status is a separate verb
// (setStatus) because 'done' drops the row from the list.
export type ProjectEditFields = {
  title?: string;
  icon?: string;
  description?: string | null;
};

// One handle over the Project data layer. Both Projects screens read
// `collection` through a live query and write with `add` / `setStatus` / `edit`,
// which return the underlying transaction so the page can surface a write error
// via `tx.isPersisted.promise`.
export type ProjectsApi = {
  collection: Collection<Project, string>;
  add: (title: string) => Transaction;
  setStatus: (id: string, status: ProjectStatus) => Transaction;
  edit: (id: string, fields: ProjectEditFields) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

// The react-query key the in-memory collection reads through. Distinct from the
// Capture and Task keys so the collections never share a cache entry.
export const PROJECTS_QUERY_KEY = entityQueryKey("projects");

// Pick the edited fields out of a mutation's changed-field set. Only the fields
// an edit may touch (title/icon/description) are forwarded to the server; status
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

// The verb table. Each key is the outbox mutationFn name (durable: a queued
// offline write replays by it), so the keys never change. One collection.update
// backs both setStatus and edit; the in-memory path tells them apart by the
// changed field set: status changed → setProjectStatus, else editProject.
export function projectsSpec(rest: ProjectsRest) {
  const v = verbsFor<Project>();
  const verbs = {
    addProject: v.insert<{ title: string }>({
      // The other fields match the server's creation defaults (icon 📁,
      // description null, status next), so the optimistic row is the server row.
      row: ({ title }) => ({
        title,
        icon: DEFAULT_ICON,
        description: null,
        status: "next",
      }),
      persist: (row) => rest.addProject({ id: row.id, title: row.title }),
    }),
    setProjectStatus: v.update<{ id: string; status: ProjectStatus }>({
      id: ({ id }) => id,
      // Set the status in place so the list re-groups immediately (a move to
      // 'done' drops the row once the server confirms).
      draft:
        ({ status }) =>
        (draft) => {
          draft.status = status;
        },
      matches: ({ changes }) => "status" in changes,
      persist: (id, { modified }) => rest.setProjectStatus(id, modified.status),
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
  };
  const spec: EntitySpec<Project, typeof verbs> = {
    name: "projects",
    fetch: () => rest.fetchProjects(),
    verbs,
    // A project set to 'done' leaves the working set the server returns.
    leavesCollection: (p) => p.status === "done",
  };
  return spec;
}

function toProjectsApi(
  api: EntityApi<Project, ReturnType<typeof projectsSpec>["verbs"]>,
): ProjectsApi {
  return {
    collection: api.collection,
    add: (title) => api.actions.addProject({ title }),
    setStatus: (id, status) => api.actions.setProjectStatus({ id, status }),
    edit: (id, fields) => api.actions.editProject({ id, fields }),
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
