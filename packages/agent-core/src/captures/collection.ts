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
import type { Capture } from "./types";

// The Capture data layer: the Capture verbs (add, process, edit, reschedule,
// reorder) over the shared collection factory in ../collection/base. Everything
// about offline persistence, reconcile and readiness lives there; this file
// holds only what is Capture-specific.

// The REST calls the collection needs, already auth-bound by the caller. Web
// injects same-origin cookie closures (no token); mobile injects closures that
// carry the Clerk Bearer token. agent-core never imports either app's HTTP
// layer, so the auth split stays out of the shared code.
export type CapturesRest = {
  fetchCaptures: () => Promise<Capture[]>;
  // The client mints the capture's id (a stable UUID), so the optimistic row and
  // the server's row share one key and never swap. The server persists this id as
  // the primary key and dedupes on it: a retried add (offline outbox replay after
  // a lost ACK) re-sends the same id, persisted verbatim in the outbox, and gets
  // the stored row back, not a second capture. The id is the whole idempotency
  // token, so no separate key is sent.
  addCapture: (capture: { id: string; text: string }) => Promise<Capture>;
  processCapture: (id: string) => Promise<Capture>;
  // The inverse of process: clears processedAt so the capture returns to the
  // inbox. Backs the capture-complete Undo. Idempotent on the id.
  unprocessCapture: (id: string) => Promise<Capture>;
  // Same-key update: sets the capture's text on its stable id and returns the
  // server row. Idempotent, so a replayed offline edit re-applies the same text.
  editCapture: (id: string, text: string) => Promise<Capture>;
  // Same-key update: sets (or clears, with null) the capture's show-up date on
  // its stable id and returns the server row. Idempotent like editCapture.
  rescheduleCapture: (id: string, showUpDate: string | null) => Promise<Capture>;
  // Same-key update: sets the capture's manual sort key on its stable id and
  // returns the server row. Idempotent like the others.
  reorderCapture: (id: string, sortKey: string) => Promise<Capture>;
};

// One handle over the Captures data layer. Both Captures screens read
// `collection` through a live query and write with the verbs below, which
// return the underlying transaction so the page can surface a write error via
// `tx.isPersisted.promise`.
export type CapturesApi = {
  collection: Collection<Capture, string>;
  add: (text: string) => Transaction;
  process: (id: string) => Transaction;
  // Reverse a process (Undo on the capture-complete snackbar): the capture
  // returns to the inbox.
  unprocess: (id: string) => Transaction;
  // Replace a capture's text optimistically (same-key update on its stable id).
  edit: (id: string, text: string) => Transaction;
  // Set (or clear, with null) a capture's show-up date optimistically. Postpone
  // is reschedule(id, tomorrow); the optimistic hide drops the row at once.
  reschedule: (id: string, showUpDate: string | null) => Transaction;
  // Set a capture's manual sort key optimistically (same-key update). The caller
  // mints the key between the drop position's neighbors with orderKeyBetween.
  reorder: (id: string, sortKey: string) => Transaction;
  // True when writes persist to a durable offline outbox (SQLite + outbox
  // storage); false for the in-memory fallback.
  offline: boolean;
  // Re-pull the server captures and reconcile them into the collection. Call on
  // app foreground so a list changed elsewhere (Telegram, another device)
  // refreshes without a cold start.
  refetch: () => Promise<void>;
  // The current captures load (sync) error message, or null. Screens read this
  // to show an error only when there is nothing else on screen.
  // `subscribeLoadError` fires whenever it changes; the callback re-reads
  // `getLoadError`.
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

// The react-query key the in-memory collection reads through. Exported so a
// consumer can read the underlying load error/status from the same QueryClient
// reactively (useLiveQuery exposes isError but not the error message).
export const CAPTURES_QUERY_KEY = entityQueryKey("captures");

// The verb table. Each key is the outbox mutationFn name (durable: a queued
// offline write replays by it), so the keys never change. One collection.update
// backs process, edit, reschedule and reorder; the in-memory path tells them
// apart by the changed field set, in this order: sortKey changed → reorder;
// showUpDate changed → reschedule; processedAt set → process; else edit. A
// rescheduled/reordered row still carries its old text and null processedAt, so
// only the changed keys tell them apart.
export function capturesSpec(rest: CapturesRest) {
  const v = verbsFor<Capture>();
  const verbs = {
    addCapture: v.insert<{ text: string }>({
      row: ({ text }) => ({
        text,
        processedAt: null,
        showUpDate: null,
        // Null sorts last, so a new capture lands at the bottom of the manual
        // order (newest-at-bottom). The server mints the real trailing key on
        // reconcile, still at the bottom — no jump. So the client never mints a
        // key on add.
        sortKey: null,
      }),
      persist: (row) => rest.addCapture({ id: row.id, text: row.text }),
    }),
    reorderCapture: v.update<{ id: string; sortKey: string }>({
      id: ({ id }) => id,
      draft:
        ({ sortKey }) =>
        (draft) => {
          draft.sortKey = sortKey;
        },
      matches: ({ changes }) => "sortKey" in changes,
      persist: (id, { modified }) => rest.reorderCapture(id, modified.sortKey!),
    }),
    rescheduleCapture: v.update<{ id: string; showUpDate: string | null }>({
      id: ({ id }) => id,
      draft:
        ({ showUpDate }) =>
        (draft) => {
          draft.showUpDate = showUpDate;
        },
      matches: ({ changes }) => "showUpDate" in changes,
      persist: (id, { modified }) =>
        rest.rescheduleCapture(id, modified.showUpDate),
    }),
    processCapture: v.update<{ id: string }>({
      id: ({ id }) => id,
      draft: () => (draft) => {
        draft.processedAt = new Date().toISOString();
      },
      matches: ({ modified }) => modified.processedAt != null,
      persist: (id) => rest.processCapture(id),
    }),
    // Declared before the catch-all editCapture so the in-memory router picks it
    // for a processedAt clear. processCapture matches first when processedAt is
    // set, so a set and a clear route to the right verb.
    unprocessCapture: v.update<{ id: string }>({
      id: ({ id }) => id,
      draft: () => (draft) => {
        draft.processedAt = null;
      },
      matches: ({ changes }) => "processedAt" in changes,
      persist: (id) => rest.unprocessCapture(id),
    }),
    // Catch-all: an update that changed none of the above is a text edit.
    editCapture: v.update<{ id: string; text: string }>({
      id: ({ id }) => id,
      draft:
        ({ text }) =>
        (draft) => {
          draft.text = text;
        },
      matches: () => true,
      persist: (id, { modified }) => rest.editCapture(id, modified.text),
    }),
  };
  const spec: EntitySpec<Capture, typeof verbs> = {
    name: "captures",
    fetch: () => rest.fetchCaptures(),
    verbs,
  };
  return spec;
}

function toCapturesApi(
  api: EntityApi<Capture, ReturnType<typeof capturesSpec>["verbs"]>,
): CapturesApi {
  return {
    collection: api.collection,
    add: (text) => api.actions.addCapture({ text }),
    process: (id) => api.actions.processCapture({ id }),
    unprocess: (id) => api.actions.unprocessCapture({ id }),
    edit: (id, text) => api.actions.editCapture({ id, text }),
    reschedule: (id, showUpDate) =>
      api.actions.rescheduleCapture({ id, showUpDate }),
    reorder: (id, sortKey) => api.actions.reorderCapture({ id, sortKey }),
    offline: api.offline,
    refetch: api.refetch,
    getLoadError: api.getLoadError,
    subscribeLoadError: api.subscribeLoadError,
  };
}

// In-memory fallback (no durable offline writes); see the shared factory.
export function createInMemoryApi(deps: {
  queryClient: QueryClient;
  rest: CapturesRest;
}): CapturesApi {
  return toCapturesApi(
    createInMemoryEntityApi({
      spec: capturesSpec(deps.rest),
      queryClient: deps.queryClient,
    }),
  );
}

// Durable offline mode; see the shared factory.
export function createPersistedApi(deps: {
  rest: CapturesRest;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): CapturesApi {
  return toCapturesApi(
    createPersistedEntityApi({
      spec: capturesSpec(deps.rest),
      persistence: deps.persistence,
      startOfflineExecutor: deps.startOfflineExecutor,
      onWarn: deps.onWarn,
    }),
  );
}

// Build the Capture data layer: durable offline persistence when it can start,
// else the in-memory fallback.
export async function createCapturesApi(
  deps: EntityApiDeps & { rest: CapturesRest },
): Promise<CapturesApi> {
  const { rest, ...base } = deps;
  return toCapturesApi(
    await createEntityApi({ spec: capturesSpec(rest), ...base }),
  );
}
