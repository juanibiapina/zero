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
import type { WaitingCondition, WaitingConditionKind } from "./types";

// The WaitingCondition data layer: the verbs (add, resolve, delete) over the
// shared collection factory. Only what is condition-specific lives here.

export type WaitingConditionFields = {
  text?: string | null;
  refId?: string | null;
  targetStatus?: string | null;
};

export type WaitsRest = {
  fetchWaits: () => Promise<WaitingCondition[]>;
  // The client mints the condition's id, so a retried add re-sends the same id
  // and gets the stored row back, not a duplicate.
  addWaitingCondition: (condition: {
    id: string;
    projectId: string;
    kind: WaitingConditionKind;
    text: string | null;
    refId: string | null;
    targetStatus: string | null;
  }) => Promise<WaitingCondition>;
  resolveWaitingCondition: (id: string) => Promise<WaitingCondition>;
  deleteWaitingCondition: (id: string) => Promise<void>;
};

export type WaitsApi = {
  collection: Collection<WaitingCondition, string>;
  add: (
    projectId: string,
    kind: WaitingConditionKind,
    fields?: WaitingConditionFields,
  ) => Transaction;
  resolve: (id: string) => Transaction;
  remove: (id: string) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

export const WAITS_QUERY_KEY = entityQueryKey("waits");

export function waitsSpec(rest: WaitsRest) {
  const v = verbsFor<WaitingCondition>();
  const verbs = {
    addWaitingCondition: v.insert<{
      projectId: string;
      kind: WaitingConditionKind;
      text: string | null;
      refId: string | null;
      targetStatus: string | null;
    }>({
      row: ({ projectId, kind, text, refId, targetStatus }) => ({
        projectId,
        kind,
        text,
        refId,
        targetStatus,
        resolvedAt: null,
      }),
      persist: (row) =>
        rest.addWaitingCondition({
          id: row.id,
          projectId: row.projectId,
          kind: row.kind,
          text: row.text,
          refId: row.refId,
          targetStatus: row.targetStatus,
        }),
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
  const spec: EntitySpec<WaitingCondition, typeof verbs> = {
    name: "waits",
    fetch: () => rest.fetchWaits(),
    verbs,
    // A resolved free-text condition leaves the open set the server returns.
    leavesCollection: (c) => c.resolvedAt != null,
  };
  return spec;
}

function toWaitsApi(
  api: EntityApi<WaitingCondition, ReturnType<typeof waitsSpec>["verbs"]>,
): WaitsApi {
  return {
    collection: api.collection,
    add: (projectId, kind, fields = {}) =>
      api.actions.addWaitingCondition({
        projectId,
        kind,
        text: fields.text ?? null,
        refId: fields.refId ?? null,
        targetStatus: fields.targetStatus ?? null,
      }),
    resolve: (id) => api.actions.resolveWaitingCondition({ id }),
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
