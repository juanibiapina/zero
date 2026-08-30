import {
  createCollection,
  safeRandomUUID,
  type Collection,
  type SyncConfig,
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
  fetchCaptures: () => Promise<Capture[]>;
  // The client mints the capture's id (a stable UUID), so the optimistic row and
  // the server's row share one key and never swap. The server persists this id as
  // the primary key and dedupes on it: a retried add (offline outbox replay after
  // a lost ACK) re-sends the same id, persisted verbatim in the outbox, and gets
  // the stored row back, not a second capture. The id is the whole idempotency
  // token, so no separate key is sent.
  addCapture: (capture: { id: string; text: string }) => Promise<Capture>;
  processCapture: (id: string) => Promise<Capture>;
};

// One handle over the Captures data layer. Both Captures screens read
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
  // Re-pull the server captures and reconcile them into the collection. Call on app
  // foreground so a list changed elsewhere (Telegram, another device) refreshes
  // without a cold start.
  refetch: () => Promise<void>;
  // The current captures load (sync) error message, or null. Screens read this to
  // show an error only when there is nothing else on screen. `subscribeLoadError`
  // fires whenever it changes; the callback re-reads `getLoadError`.
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The sync write messages that reconcile the synced base to the server's
// captures list: update each row already present, insert each new one, and
// delete any key the server no longer returns. Pure so the diff (the tricky
// part — no duplicate inserts, processed rows pruned, optimistic-only keys left
// alone by hitting only the synced base) is unit-tested without the persistence stack.
export type CaptureWrite =
  | { type: "insert" | "update"; value: Capture }
  | { type: "delete"; key: string };
export function reconcileCaptureWrites(
  currentKeys: Iterable<string>,
  server: readonly Capture[],
): CaptureWrite[] {
  const present = new Set(currentKeys);
  const serverIds = new Set(server.map((c) => c.id));
  const writes: CaptureWrite[] = [];
  for (const c of server) {
    writes.push({ type: present.has(c.id) ? "update" : "insert", value: c });
  }
  for (const key of present) {
    if (!serverIds.has(key)) writes.push({ type: "delete", key });
  }
  return writes;
}

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

// The optimistic row's id is a client-minted UUID that the server persists
// verbatim, so this id never changes: no temp-to-real swap, no flicker, and any
// later delete/edit by id stays valid. `safeRandomUUID` works on browser and
// React Native (no crypto polyfill).
function optimisticCapture(text: string): Capture {
  return {
    id: safeRandomUUID(),
    text,
    createdAt: new Date().toISOString(),
    processedAt: null,
  };
}

function markProcessed(draft: Capture): void {
  draft.processedAt = new Date().toISOString();
}

// The Query Collection's direct-write utils, which are not on the base
// Collection type; reach them through one narrow accessor shared by every write.
type CaptureWriteUtils = {
  writeUpsert: (data: Capture | Capture[]) => void;
  writeDelete: (keys: string | string[]) => void;
  writeBatch: (cb: () => void) => void;
};
function writeUtils(
  collection: Collection<Capture, string>,
): CaptureWriteUtils | undefined {
  return (collection as { utils?: Partial<CaptureWriteUtils> }).utils as
    | CaptureWriteUtils
    | undefined;
}

// Reconcile the synced base to the server's authoritative result, in place, by
// each row's stable id. Every write handler calls this AFTER its REST call and
// BEFORE it returns (before the optimistic overlay is released), so the base
// already holds the server's row/deletion when the overlay drops. That is what
// prevents flicker: without it, dropping the overlay reverts to the stale base
// for one tick until a trailing full-list refetch lands, and the row blinks.
// Because the capture id is client-minted and stable, add is same-key like
// process (no temp-to-real swap), so a plain upsert lands on the right row and
// a future delete/edit needs no new anti-flicker code. Never rely on the
// trailing refetch for visual correctness.
function reconcile(
  collection: Collection<Capture, string>,
  delta: { upsert?: Capture[]; remove?: string[] },
): void {
  const utils = writeUtils(collection);
  if (!utils) return;
  utils.writeBatch(() => {
    if (delta.upsert?.length) utils.writeUpsert(delta.upsert);
    if (delta.remove?.length) utils.writeDelete(delta.remove);
  });
}

// Fallback: an in-memory Query Collection whose own handlers call the REST API
// and roll back on failure. Used when durable persistence is unavailable
// (private browsing on web, or the jest / no-native-SQLite environment) so the
// Captures list never hard-crashes; offline writes are not durable in this mode.
export function createInMemoryApi(deps: {
  queryClient: QueryClient;
  rest: CapturesRest;
}): CapturesApi {
  const { queryClient, rest } = deps;
  const collection = createCollection(
    queryCollectionOptions({
      queryClient,
      queryKey: CAPTURES_QUERY_KEY,
      queryFn: () => rest.fetchCaptures(),
      getKey: (c: Capture) => c.id,
      onInsert: async ({ transaction }) => {
        // The capture's client-minted id is the server's dedupe key. Reconcile
        // the server's row into the synced base before returning, so releasing
        // the optimistic overlay reveals the same-id row and never blinks; skip
        // the auto-refetch that would otherwise churn the whole list.
        for (const m of transaction.mutations) {
          const real = await rest.addCapture({
            id: m.modified.id,
            text: m.modified.text,
          });
          reconcile(collection, { upsert: [real] });
        }
        return { refetch: false };
      },
      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          if (m.modified.processedAt != null) {
            const updated = await rest.processCapture(String(m.key));
            reconcile(collection, { upsert: [updated] });
          }
        }
        return { refetch: false };
      },
    }),
  );

  const refetchUtil = (
    collection as { utils?: { refetch?: () => Promise<unknown> } }
  ).utils?.refetch;

  return {
    collection,
    add: (text) => collection.insert(optimisticCapture(text)),
    process: (id) => collection.update(id, markProcessed),
    offline: false,
    refetch: async () => {
      if (refetchUtil) {
        await refetchUtil();
      } else {
        await queryClient.invalidateQueries({ queryKey: CAPTURES_QUERY_KEY });
      }
    },
    // The Query Collection records its fetch error in the react-query cache; read
    // it there so the load-error channel is uniform across both API builders.
    getLoadError: () => {
      const state = queryClient.getQueryState(CAPTURES_QUERY_KEY);
      return state?.status === "error" && state.error
        ? messageOf(state.error)
        : null;
    },
    subscribeLoadError: (cb) => queryClient.getQueryCache().subscribe(cb),
  };
}

// Durable offline mode: local-first. The collection is a persisted SQLite
// collection driven by a custom sync that marks ready from the local snapshot
// immediately (the persisted wrapper awaits its hydrate first), then fetches the
// server captures in the background and reconciles them into the synced base. That is
// the whole point: cached rows paint at once and the network updates them in
// place, instead of the live query waiting on the first network fetch. Writes go
// through an offline outbox that retries when the network returns; the
// executor's mutationFns call the REST API and reconcile the server's row.
//
// It is deliberately NOT `queryCollectionOptions` wrapped in persistence: that
// makes the collection `sync-present`, where readiness is gated on the network
// query, so the local snapshot sat behind "Loading…" for the whole round trip
// (see docs/todo-app.md). The custom sync stays sync-present (writes still
// persist) but readiness comes from the cache.
export function createPersistedApi(deps: {
  queryClient: QueryClient;
  rest: CapturesRest;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): CapturesApi {
  const { rest, persistence, startOfflineExecutor, onWarn = noopWarn } = deps;

  // The sync's write controls, captured when the collection starts syncing.
  // reconcile* and refetch write server data through these; null until the first
  // subscription starts the sync, so every use guards on it.
  type SyncStart = Parameters<SyncConfig<Capture, string>["sync"]>[0];
  type Controls = Pick<SyncStart, "begin" | "write" | "commit">;
  let controls: Controls | null = null;

  // Load-error channel: the custom sync has no react-query cache, so surface the
  // fetch error here for the screens to read.
  let loadError: string | null = null;
  const errorListeners = new Set<() => void>();
  const setLoadError = (next: string | null) => {
    if (next === loadError) return;
    loadError = next;
    for (const cb of errorListeners) cb();
  };

  // Assigned before the sync runs (createCollection returns synchronously; the
  // sync fires later on first subscribe), so the reconcile closures can read it.
  // It cannot be `const`: `sync` reads it back through `reconcileList`.
  // eslint-disable-next-line prefer-const
  let collection: Collection<Capture, string>;

  // Upsert one server row into the synced base by its stable id (insert if new,
  // update if present). Used after each write's REST call.
  const reconcileOne = (c: Capture) => {
    if (!controls) return;
    controls.begin();
    controls.write({ type: collection.has(c.id) ? "update" : "insert", value: c });
    void controls.commit();
  };

  // Replace the synced captures with the server's authoritative list: upsert each
  // server row and delete any synced row the server no longer returns (e.g. a
  // processed capture). Deletes hit only the synced base, so a pending optimistic
  // row (not yet in the base) is left untouched.
  const reconcileList = (server: Capture[]) => {
    if (!controls) return;
    controls.begin();
    for (const write of reconcileCaptureWrites(collection.keys(), server)) {
      controls.write(write);
    }
    void controls.commit();
  };

  const fetchAndReconcile = async () => {
    try {
      const rows = await rest.fetchCaptures();
      setLoadError(null);
      reconcileList(rows);
    } catch (err) {
      setLoadError(messageOf(err));
    }
  };

  const sync: SyncConfig<Capture, string> = {
    sync: (params) => {
      controls = {
        begin: params.begin,
        write: params.write,
        commit: params.commit,
      };
      // Ready from the local snapshot at once. The persisted wrapper defers this
      // markReady until its hydrate finishes, so the cached rows are already in
      // the collection when the live query starts emitting — no wait on the
      // network. The background fetch then updates rows in place.
      params.markReady();
      void fetchAndReconcile();
      return () => {
        controls = null;
      };
    },
  };

  collection = createCollection(
    persistedCollectionOptions<Capture, string>({
      // Stable id so the persisted table survives across launches and app
      // versions. (Changing it orphans the old table and forces a one-time
      // re-sync from the server.)
      id: "captures",
      getKey: (c: Capture) => c.id,
      schemaVersion: SCHEMA_VERSION,
      persistence,
      sync,
    }),
  );

  const offline = startOfflineExecutor({
    collections: { captures: collection },
    mutationFns: {
      addCapture: async ({ transaction }) => {
        // The capture's client-minted id is the dedupe key: the outbox persists
        // the whole mutation, so a cold-start replay after a lost ACK re-sends
        // the same id and the server returns the stored row instead of a second
        // capture. The outbox types a mutation's fields as unknown; narrow first.
        for (const m of transaction.mutations) {
          const id = m.modified.id;
          const text = m.modified.text;
          if (typeof id === "string" && typeof text === "string") {
            const real = await rest.addCapture({ id, text });
            reconcileOne(real);
          }
        }
        await fetchAndReconcile();
      },
      processCapture: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          if (m.modified.processedAt != null) {
            const updated = await rest.processCapture(String(m.key));
            reconcileOne(updated);
          }
        }
        await fetchAndReconcile();
      },
    },
    onLeadershipChange: (isLeader) => {
      // Non-leader tabs / instances run online-only; fine for a single-user Captures list.
      if (!isLeader) {
        onWarn("captures: another instance holds the offline outbox; this one is online-only");
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
    refetch: () => fetchAndReconcile(),
    getLoadError: () => loadError,
    subscribeLoadError: (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
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
      onWarn("captures: offline SQL persistence unavailable, using in-memory fallback", err);
    }
  }
  return createInMemoryApi({ queryClient, rest });
}
