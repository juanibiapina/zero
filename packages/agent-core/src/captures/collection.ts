import {
  createCollection,
  safeRandomUUID,
  type Collection,
  type Transaction,
} from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import type { OfflineConfig, OfflineExecutor } from "@tanstack/offline-transactions";

import type { Capture } from "./types";

// The three REST calls the collection needs, already auth-bound by the caller.
// Web injects same-origin cookie closures (no token); mobile injects closures
// that carry the Clerk Bearer token. agent-core never imports either app's HTTP
// layer, so the auth split stays out of the shared code.
export type CapturesRest = {
  fetchInbox: () => Promise<Capture[]>;
  // idempotencyKey is a per-write key the server dedupes on, so a retried add
  // (offline outbox replay after a lost ACK) cannot create a second capture.
  addCapture: (text: string, idempotencyKey: string) => Promise<Capture>;
  processCapture: (id: string) => Promise<Capture>;
};

// One handle over the Inbox data layer. Both Inbox screens read
// `collection` through a live query and write with `add` / `process`, which
// return the underlying transaction so the page can surface a write error via
// `tx.isPersisted.promise`.
export type CapturesApi = {
  collection: Collection<Capture, string>;
  add: (text: string) => Transaction;
  process: (id: string) => Transaction;
  // True when writes persist to a durable offline outbox (SQLite + outbox
  // storage); false for the in-memory fallback.
  offline: boolean;
};

// The platform's offline-transactions entry point. Injected because web imports
// it from `@tanstack/offline-transactions` and mobile from its `/react-native`
// subpath (which wires native netinfo connectivity); the config shape is shared.
export type StartOfflineExecutor = (config: OfflineConfig) => OfflineExecutor;

// Optional diagnostic sink. agent-core is lib-clean (no DOM), so it does not
// reach for a global `console`; each app passes its own logger if it wants the
// fallback / leadership warnings.
export type WarnFn = (message: string, error?: unknown) => void;
const noopWarn: WarnFn = () => {};

// The react-query key the collection reads through. Exported so a consumer can
// read the underlying load error/status from the same QueryClient reactively
// (useLiveQuery exposes isError but not the error message).
export const CAPTURES_QUERY_KEY = ["captures"];
// Bumping this clears the persisted local copy and re-syncs from the server.
const SCHEMA_VERSION = 1;

// Temp id for the optimistic row; replaced by the server's real id on refetch.
// `safeRandomUUID` works on browser and React Native (no crypto polyfill).
function optimisticCapture(text: string): Capture {
  return {
    id: `temp-${safeRandomUUID()}`,
    text,
    createdAt: new Date().toISOString(),
    processedAt: null,
  };
}

function markProcessed(draft: Capture): void {
  draft.processedAt = new Date().toISOString();
}

// Write the server's post-process row straight into the collection's synced
// base. Without this, processing flickers: the optimistic `markProcessed`
// overlay hides the row, but when that overlay is dropped on completion the
// synced base still holds the row's stale (unprocessed) value for one tick
// before the reconciling refetch's delete lands, so the row reappears and
// vanishes. Upserting the processed row keeps the base filtered out across the
// drop. The Query Collection's write utils are not on the base Collection type,
// so reach them through a narrow cast (same shape as `refresh` below).
function syncProcessed(collection: Collection<Capture, string>, capture: Capture): void {
  const utils = (collection as { utils?: { writeUpsert?: (data: Capture) => void } })
    .utils;
  utils?.writeUpsert?.(capture);
}

// Fallback: an in-memory Query Collection whose own handlers call the REST API
// and roll back on failure. Used when durable persistence is unavailable
// (private browsing on web, or the jest / no-native-SQLite environment) so the
// Inbox never hard-crashes; offline writes are not durable in this mode.
export function createInMemoryApi(deps: {
  queryClient: QueryClient;
  rest: CapturesRest;
}): CapturesApi {
  const { queryClient, rest } = deps;
  const collection = createCollection(
    queryCollectionOptions({
      queryClient,
      queryKey: CAPTURES_QUERY_KEY,
      queryFn: () => rest.fetchInbox(),
      getKey: (c: Capture) => c.id,
      onInsert: async ({ transaction }) => {
        // This fallback has no durable outbox (online-only), so there is no
        // cross-restart replay; a fresh per-write key still gives the server a
        // stable dedupe token within any in-session retry.
        for (const m of transaction.mutations)
          await rest.addCapture(m.modified.text, safeRandomUUID());
      },
      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          if (m.modified.processedAt != null) {
            const updated = await rest.processCapture(String(m.key));
            syncProcessed(collection, updated);
          }
        }
      },
    }),
  );

  return {
    collection,
    add: (text) => collection.insert(optimisticCapture(text)),
    process: (id) => collection.update(id, markProcessed),
    offline: false,
  };
}

// Durable offline mode: the synced Query Collection is persisted to SQLite for
// offline reads, and writes go through an offline outbox that retries when the
// network returns. The collection carries NO server-calling handlers: every
// write flows through the executor's mutationFns below, which call the REST API
// and then invalidate the query to reconcile the optimistic temp-id row with the
// server's real row (mirroring the Query Collection's own auto-refetch).
export function createPersistedApi(deps: {
  queryClient: QueryClient;
  rest: CapturesRest;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): CapturesApi {
  const { queryClient, rest, persistence, startOfflineExecutor, onWarn = noopWarn } = deps;

  const collection = createCollection(
    persistedCollectionOptions<Capture, string>({
      persistence,
      schemaVersion: SCHEMA_VERSION,
      ...queryCollectionOptions({
        queryClient,
        queryKey: CAPTURES_QUERY_KEY,
        queryFn: () => rest.fetchInbox(),
        getKey: (c: Capture) => c.id,
      }),
    }),
  );

  // After a write reaches the server (including an outbox replay on reconnect),
  // refetch the collection so the live view reconciles the optimistic/pending row
  // with the server's real row. A direct collection refetch is what updates the
  // persisted collection's live query; a bare queryClient invalidate does not
  // reliably refresh it.
  const refresh = async () => {
    const utils = (collection as { utils?: { refetch?: () => Promise<unknown> } })
      .utils;
    if (utils?.refetch) {
      await utils.refetch();
    } else {
      await queryClient.invalidateQueries({ queryKey: CAPTURES_QUERY_KEY });
    }
  };

  const offline = startOfflineExecutor({
    collections: { captures: collection },
    mutationFns: {
      addCapture: async ({ transaction, idempotencyKey }) => {
        // `idempotencyKey` is the offline executor's per-write key: generated once
        // per write, persisted in the outbox, and reused verbatim on every retry
        // and cold-start replay. Passing it to the server dedupes a lost-ACK
        // retry (the C3 duplicate). This is the single read site for the field;
        // keep it here so an offline-transactions version bump is one line.
        // The outbox types a mutation's fields as unknown; narrow before sending.
        for (const m of transaction.mutations) {
          const text = m.modified.text;
          if (typeof text === "string") await rest.addCapture(text, idempotencyKey);
        }
        await refresh();
      },
      processCapture: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          if (m.modified.processedAt != null) {
            const updated = await rest.processCapture(String(m.key));
            syncProcessed(collection, updated);
          }
        }
        await refresh();
      },
    },
    onLeadershipChange: (isLeader) => {
      // Non-leader tabs / instances run online-only; fine for a single-user Inbox.
      if (!isLeader) {
        onWarn("inbox: another instance holds the offline outbox; this one is online-only");
      }
    },
  });

  const addAction = offline.createOfflineAction<{ text: string }>({
    mutationFnName: "addCapture",
    onMutate: ({ text }) => {
      collection.insert(optimisticCapture(text));
    },
  });
  const processAction = offline.createOfflineAction<{ id: string }>({
    mutationFnName: "processCapture",
    onMutate: ({ id }) => {
      collection.update(id, markProcessed);
    },
  });

  return {
    collection,
    add: (text) => addAction({ text }),
    process: (id) => processAction({ id }),
    offline: true,
  };
}

// Build the Capture data layer: try durable offline persistence, fall back to the
// in-memory Query Collection if persistence cannot start (private browsing / no
// native SQLite). `persistence` is a thunk because opening the local database is
// async and may throw; centralizing the try/catch keeps both apps' wiring thin.
export async function createCapturesApi(deps: {
  queryClient: QueryClient;
  rest: CapturesRest;
  persistence?: () =>
    | Promise<PersistedCollectionPersistence>
    | PersistedCollectionPersistence;
  startOfflineExecutor?: StartOfflineExecutor;
  onWarn?: WarnFn;
}): Promise<CapturesApi> {
  const { queryClient, rest, persistence, startOfflineExecutor, onWarn = noopWarn } = deps;
  if (persistence && startOfflineExecutor) {
    try {
      const resolved = await persistence();
      return createPersistedApi({
        queryClient,
        rest,
        persistence: resolved,
        startOfflineExecutor,
        onWarn,
      });
    } catch (err) {
      onWarn("inbox: offline SQL persistence unavailable, using in-memory fallback", err);
    }
  }
  return createInMemoryApi({ queryClient, rest });
}
