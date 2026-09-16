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
import type { ProjectAttention } from "./types";

export type AddProjectAttention =
  | {
      projectId: string;
      kind: "free-text";
      text: string;
      refId: null;
      targetStatus: null;
    }
  | {
      projectId: string;
      kind: "project-status";
      text: null;
      refId: string;
      targetStatus: "done";
    };

export type WaitsRest = {
  fetchWaits: () => Promise<ProjectAttention[]>;
  addWaitingCondition: (
    condition: AddProjectAttention & { id: string },
  ) => Promise<ProjectAttention>;
  resolveWaitingCondition: (id: string) => Promise<ProjectAttention>;
  deleteWaitingCondition: (id: string) => Promise<void>;
};

export type WaitsApi = {
  collection: Collection<ProjectAttention, string>;
  addWaiting: (projectId: string, text: string) => Transaction;
  addAfter: (projectId: string, afterProjectId: string) => Transaction;
  resolveWaiting: (id: string) => Transaction;
  remove: (id: string) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

export const WAITS_QUERY_KEY = entityQueryKey("waits");

export function waitsSpec(rest: WaitsRest) {
  const v = verbsFor<ProjectAttention>();
  const verbs = {
    // Keep this durable name so queued free-text and Project-completion writes
    // from the prior client remain readable after the public interface narrows.
    addWaitingCondition: v.insert<AddProjectAttention>({
      row: (args) => {
        const legacy: {
          projectId: string;
          kind: string;
          targetStatus: string | null;
        } = args;
        if (
          legacy.kind !== "free-text" &&
          !(legacy.kind === "project-status" && legacy.targetStatus === "done")
        ) {
          return {
            projectId: legacy.projectId,
            kind: "free-text" as const,
            text: "",
            refId: null,
            targetStatus: null,
            resolvedAt: new Date().toISOString(),
          };
        }
        return { ...args, resolvedAt: null };
      },
      persist: (row) => {
        if (row.resolvedAt != null) return Promise.resolve(row);
        return row.kind === "free-text"
          ? rest.addWaitingCondition({
              id: row.id,
              projectId: row.projectId,
              kind: "free-text",
              text: row.text,
              refId: null,
              targetStatus: null,
            })
          : rest.addWaitingCondition({
              id: row.id,
              projectId: row.projectId,
              kind: "project-status",
              text: null,
              refId: row.refId,
              targetStatus: "done",
            });
      },
    }),
    resolveWaitingCondition: v.update<{ id: string }>({
      id: ({ id }) => id,
      draft: () => (draft) => {
        draft.resolvedAt = new Date().toISOString();
      },
      matches: ({ modified }) => modified.resolvedAt != null,
      persist: (id) => rest.resolveWaitingCondition(id),
    }),
    deleteWaitingCondition: v.delete<{ id: string }>({
      id: ({ id }) => id,
      persist: (id) => rest.deleteWaitingCondition(id),
    }),
  };
  const spec: EntitySpec<ProjectAttention, typeof verbs> = {
    name: "waits",
    fetch: rest.fetchWaits,
    verbs,
    leavesCollection: (condition) => condition.resolvedAt != null,
  };
  return spec;
}

function toWaitsApi(
  api: EntityApi<ProjectAttention, ReturnType<typeof waitsSpec>["verbs"]>,
): WaitsApi {
  return {
    collection: api.collection,
    addWaiting: (projectId, text) =>
      api.actions.addWaitingCondition({
        projectId,
        kind: "free-text",
        text,
        refId: null,
        targetStatus: null,
      }),
    addAfter: (projectId, afterProjectId) =>
      api.actions.addWaitingCondition({
        projectId,
        kind: "project-status",
        text: null,
        refId: afterProjectId,
        targetStatus: "done",
      }),
    resolveWaiting: (id) => api.actions.resolveWaitingCondition({ id }),
    remove: (id) => api.actions.deleteWaitingCondition({ id }),
    offline: api.offline,
    refetch: api.refetch,
    getLoadError: api.getLoadError,
    subscribeLoadError: api.subscribeLoadError,
  };
}

export function createInMemoryWaitsApi(deps: {
  queryClient: QueryClient;
  rest: WaitsRest;
}): WaitsApi {
  return toWaitsApi(
    createInMemoryEntityApi({
      spec: waitsSpec(deps.rest),
      queryClient: deps.queryClient,
    }),
  );
}

export function createPersistedWaitsApi(deps: {
  rest: WaitsRest;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): WaitsApi {
  return toWaitsApi(
    createPersistedEntityApi({
      spec: waitsSpec(deps.rest),
      persistence: deps.persistence,
      startOfflineExecutor: deps.startOfflineExecutor,
      onWarn: deps.onWarn,
    }),
  );
}

export async function createWaitsApi(
  deps: EntityApiDeps & { rest: WaitsRest },
): Promise<WaitsApi> {
  const { rest, ...base } = deps;
  return toWaitsApi(await createEntityApi({ spec: waitsSpec(rest), ...base }));
}
