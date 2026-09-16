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
import type {
  OfflineConfig,
  OfflineExecutor,
} from "@tanstack/offline-transactions";

import { ENTITY_CACHE_VERSION } from "./version";

// The shared offline collection factory behind every todo-app entity (Capture,
// Task, Project). An entity describes itself with an EntitySpec — its name, how
// to fetch its working set, and a table of verbs — and gets back a TanStack DB
// collection plus one action per verb. Everything that is the same for every
// entity lives here: the client-minted id / createdAt convention, the in-memory
// Query Collection fallback, the durable persisted collection with its
// local-first sync, the reconcile-after-write rule that prevents flicker, the
// offline outbox wiring, and the load-error channel. Each entity file keeps only
// its types, its optimistic drafts and its REST mapping (the verbs).

// Every entity row carries a stable client-minted UUID and a creation time. The
// id is the primary key on the server, the dedupe key for an offline replay, and
// the reason an optimistic row never swaps keys (no temp-to-real flicker).
export type EntityRow = { id: string; createdAt: string };

// A verb that inserts a row. The entity supplies the domain fields; the base
// mints `id` (safeRandomUUID, works on browser and React Native) and
// `createdAt` (now). `persist` sends the row to the server and returns the
// server's row, which is reconciled into the synced base before the optimistic
// overlay drops.
export type InsertVerb<Row extends EntityRow, Args> = {
  kind: "insert";
  row: (args: Args) => Omit<Row, "id" | "createdAt">;
  persist: (row: Row) => Promise<Row>;
};

// A verb that updates a row in place by its stable id. `draft` mutates the
// optimistic row; `persist` sends the change and returns the server's row.
// New optimistic operations carry `{ verb, args }` metadata, so the in-memory
// path and durable outbox retain the initiating command. `matches` is the legacy
// fallback for queued/pre-metadata collection.update operations: verbs are tried
// in declaration order against `changes`, so a catch-all edit verb stays last.
// The persisted path otherwise routes by the outbox mutation function's name.
export type UpdateVerb<Row extends EntityRow, Args> = {
  kind: "update";
  id: (args: Args) => string;
  draft: (args: Args) => (draft: Row) => void;
  matches: (mutation: { changes: Partial<Row>; modified: Row }) => boolean;
  persist: (
    id: string,
    mutation: { changes: Partial<Row>; modified: Row; original?: Row },
    args: Args | undefined,
  ) => Promise<Row>;
  // Whether the persisted path re-pulls the list after this verb's REST call
  // (default true). Off for a verb that fires on every blur-commit.
  refetchAfter?: boolean;
};

// A verb that permanently removes a row by its stable id. `persist` issues the
// server delete and returns nothing (no row to reconcile). The optimistic path
// drops the row at once and rolls it back if `persist` throws. Distinct from an
// update that leaves the working set (a `done` status): delete hard-removes the
// row, it does not just fall out of a filtered list.
export type DeleteVerb<Args> = {
  kind: "delete";
  id: (args: Args) => string;
  persist: (id: string) => Promise<void>;
};

// A verb that brings a row BACK into the working set — the inverse of a write
// that made it leave (complete/process, whose server list then stops returning
// it, so the collection reconciled it out). An `update` cannot do this: by the
// time it runs the row is gone from the collection and `collection.update`
// throws "key not found". `revive` carries the FULL row (like an insert) so it
// can re-insert when the row is absent, and updates in place when it is still
// present (Undo tapped before the eviction landed). It is routed by per-op
// metadata (`{ verb: name }`), not by the changed-field `matches` heuristic, so
// it needs no `matches`. Screens never see this kind: an entity's public API maps
// its own verb (reopen/unprocess) onto it. `refetchAfter` mirrors UpdateVerb.
export type ReviveVerb<Row extends EntityRow, Args> = {
  kind: "revive";
  id: (args: Args) => string;
  // The full row to re-insert when it is absent (id preserved, field cleared).
  row: (args: Args) => Row;
  // The in-place mutation when the row is still present.
  draft: (args: Args) => (draft: Row) => void;
  persist: (
    id: string,
    mutation: { changes: Partial<Row>; modified: Row; original?: Row },
    args: Args | undefined,
  ) => Promise<Row>;
  refetchAfter?: boolean;
};

export type Verb<Row extends EntityRow, Args> =
  | InsertVerb<Row, Args>
  | ReviveVerb<Row, Args>
  | UpdateVerb<Row, Args>
  | DeleteVerb<Args>;

// Any verb table. `never` as the args bound lets a verb typed with concrete
// args satisfy it (function parameters are contravariant).
export type AnyVerbs<Row extends EntityRow> = Record<string, Verb<Row, never>>;

// Structural match on the one args-carrying member, so a verb typed with a
// concrete Row still yields its Args (a nominal InsertVerb<EntityRow, A> match
// would fail on persist's contravariant row parameter).
export type VerbArgs<V> = V extends { kind: "insert"; row: (args: infer A) => unknown }
  ? A
  : V extends { kind: "update"; id: (args: infer A) => string }
    ? A
    : V extends { kind: "revive"; id: (args: infer A) => string }
      ? A
      : V extends { kind: "delete"; id: (args: infer A) => string }
        ? A
        : never;

// Typed verb constructors for one row type. `const v = verbsFor<Project>()`,
// then `v.insert<{ title: string }>({ ... })` gives each verb its precise Args
// while every callback (`row`, `draft`, `persist`) is contextually typed against
// the Row, so entity files annotate nothing else.
export function verbsFor<Row extends EntityRow>() {
  return {
    insert: <Args>(
      verb: Omit<InsertVerb<Row, Args>, "kind">,
    ): InsertVerb<Row, Args> => ({ kind: "insert", ...verb }),
    update: <Args>(
      verb: Omit<UpdateVerb<Row, Args>, "kind">,
    ): UpdateVerb<Row, Args> => ({ kind: "update", ...verb }),
    revive: <Args>(
      verb: Omit<ReviveVerb<Row, Args>, "kind">,
    ): ReviveVerb<Row, Args> => ({ kind: "revive", ...verb }),
    delete: <Args>(
      verb: Omit<DeleteVerb<Args>, "kind">,
    ): DeleteVerb<Args> => ({ kind: "delete", ...verb }),
  };
}

export type EntitySpec<Row extends EntityRow, Verbs extends AnyVerbs<Row>> = {
  // The entity's stable name ("captures", "tasks", "projects"). It is the
  // persisted collection id (the local table; changing it orphans the cache and
  // forces a one-time re-sync), the react-query key, the outbox `collections`
  // key, and the prefix of every warning. Never rename casually.
  name: string;
  // The working set the server returns. A row the server stops returning is
  // deleted from the synced base on the next reconcile.
  fetch: () => Promise<Row[]>;
  // The verb table. Each key is the outbox mutationFn name, persisted with every
  // queued offline write: a write queued by an old build replays on the new one
  // by this name, so the keys are part of the durable contract. Never rename.
  verbs: Verbs;
  // A server row that has left the working set (e.g. a Project set to `done`).
  // After a write returns such a row it is removed from the synced base instead
  // of upserted, so the row leaves at once rather than on the trailing refetch.
  leavesCollection?: (row: Row) => boolean;
};

// One handle over an entity's data layer. Screens read `collection` through a
// live query and write through `actions`, which return the underlying
// transaction so a page can surface a write error via `tx.isPersisted.promise`.
// Each entity re-wraps this into its own named API (add / process / ...), so
// screens never see the verb table.
export type EntityApi<Row extends EntityRow, Verbs extends AnyVerbs<Row>> = {
  collection: Collection<Row, string>;
  actions: { [K in keyof Verbs]: (args: VerbArgs<Verbs[K]>) => Transaction };
  // True when writes persist to a durable offline outbox; false for the
  // in-memory fallback.
  offline: boolean;
  // Re-pull the server list and reconcile it into the collection. Call on app
  // foreground so a list changed elsewhere refreshes without a cold start.
  refetch: () => Promise<void>;
  // The current load (sync) error message, or null. `subscribeLoadError` fires
  // whenever it changes; the callback re-reads `getLoadError`.
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
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

// The react-query key an entity's in-memory collection reads through.
export function entityQueryKey(name: string): string[] {
  return [name];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The sync write messages that reconcile the synced base to the server's list:
// update each row already present, insert each new one, and delete any key the
// server no longer returns. Pure so the diff (no duplicate inserts, removed rows
// pruned, optimistic-only keys left alone by hitting only the synced base) is
// unit-tested without the persistence stack.
export type Write<Row> =
  | { type: "insert" | "update"; value: Row }
  | { type: "delete"; key: string };
export function reconcileWrites<Row extends { id: string }>(
  currentKeys: Iterable<string>,
  server: readonly Row[],
): Write<Row>[] {
  const present = new Set(currentKeys);
  const serverIds = new Set(server.map((r) => r.id));
  const writes: Write<Row>[] = [];
  for (const r of server) {
    writes.push({ type: present.has(r.id) ? "update" : "insert", value: r });
  }
  for (const key of present) {
    if (!serverIds.has(key)) writes.push({ type: "delete", key });
  }
  return writes;
}

// The verb table with its per-verb argument types erased, for the base's own
// loops. Callers never see this shape.
type LooseVerbs<Row extends EntityRow> = Record<string, Verb<Row, unknown>>;
function looseVerbs<Row extends EntityRow>(
  verbs: AnyVerbs<Row>,
): LooseVerbs<Row> {
  return verbs as unknown as LooseVerbs<Row>;
}

// The optimistic row: the entity's fields plus a client-minted id that the
// server persists verbatim (so it never changes: no temp-to-real swap, no
// flicker) and the creation time.
function mintRow<Row extends EntityRow>(
  fields: Omit<Row, "id" | "createdAt">,
): Row {
  return {
    ...fields,
    id: safeRandomUUID(),
    createdAt: new Date().toISOString(),
  } as Row;
}

// `collection.update` types its draft as WritableDeep<Row>, which does not
// unify with a generic Row; the verb's draft mutates the same object, so widen
// the parameter for the call.
function asDraft<Row extends EntityRow>(
  draft: (draft: Row) => void,
): (draft: unknown) => void {
  return draft as (draft: unknown) => void;
}

// The optimistic op for a revive, shared by both builders: update the row in
// place when it is still present, else re-insert it (id preserved, so it is the
// same row the server has). Both branches tag the op with `{ verb, args }`: the
// in-memory builder routes by name and the durable outbox replays the initiating
// arguments. `collection.insert` keys by `getKey = r.id`, so passing the full row
// preserves the id — do NOT mint a new one here.
function reviveAction<Row extends EntityRow>(
  collection: Collection<Row, string>,
  name: string,
  verb: ReviveVerb<Row, unknown>,
): (args: unknown) => Transaction {
  return (args) => {
    const id = verb.id(args);
    const metadata = { verb: name, args };
    return collection.has(id)
      ? collection.update(id, { metadata }, asDraft(verb.draft(args)))
      : collection.insert(verb.row(args), { metadata });
  };
}

function insertVerbOf<Row extends EntityRow>(
  name: string,
  verbs: LooseVerbs<Row>,
): InsertVerb<Row, unknown> {
  for (const verb of Object.values(verbs)) {
    if (verb.kind === "insert") return verb;
  }
  throw new Error(`${name}: no insert verb`);
}

function deleteVerbOf<Row extends EntityRow>(
  name: string,
  verbs: LooseVerbs<Row>,
): DeleteVerb<unknown> {
  for (const verb of Object.values(verbs)) {
    if (verb.kind === "delete") return verb;
  }
  throw new Error(`${name}: no delete verb`);
}

function routeUpdate<Row extends EntityRow>(
  name: string,
  verbs: LooseVerbs<Row>,
  mutation: { changes: Partial<Row>; modified: Row },
): UpdateVerb<Row, unknown> {
  for (const verb of Object.values(verbs)) {
    if (verb.kind === "update" && verb.matches(mutation)) return verb;
  }
  throw new Error(`${name}: no update verb matches ${Object.keys(mutation.changes).join(",")}`);
}

// Every new update/revive operation carries `{ verb, args }`. The in-memory
// builder routes by the named verb; the durable builder routes by its mutationFn
// and uses the retained args. Revive inserts also need the name because their
// collection operation is an insert while their server command is an Undo.
type OpMetadata = { verb?: string; args?: unknown };
function reviveVerbFromMetadata<Row extends EntityRow>(
  verbs: LooseVerbs<Row>,
  metadata: unknown,
): ReviveVerb<Row, unknown> | undefined {
  const named = (metadata as OpMetadata | undefined)?.verb;
  if (!named) return undefined;
  const verb = verbs[named];
  return verb?.kind === "revive" ? verb : undefined;
}

function updateVerbFromMetadata<Row extends EntityRow>(
  verbs: LooseVerbs<Row>,
  metadata: unknown,
): UpdateVerb<Row, unknown> | ReviveVerb<Row, unknown> | undefined {
  const named = (metadata as OpMetadata | undefined)?.verb;
  if (!named) return undefined;
  const verb = verbs[named];
  return verb?.kind === "update" || verb?.kind === "revive"
    ? verb
    : undefined;
}

// The Query Collection's direct-write utils, which are not on the base
// Collection type; reach them through one narrow accessor shared by every write.
type WriteUtils<Row> = {
  writeUpsert: (data: Row | Row[]) => void;
  writeDelete: (keys: string | string[]) => void;
  writeBatch: (cb: () => void) => void;
};
function writeUtils<Row extends EntityRow>(
  collection: Collection<Row, string>,
): WriteUtils<Row> | undefined {
  return (collection as { utils?: Partial<WriteUtils<Row>> }).utils as
    | WriteUtils<Row>
    | undefined;
}

// Reconcile the synced base to the server's authoritative result, in place, by
// each row's stable id. Every write handler calls this AFTER its REST call and
// BEFORE it returns (before the optimistic overlay is released), so the base
// already holds the server's row/deletion when the overlay drops. That is what
// prevents flicker: without it, dropping the overlay reverts to the stale base
// for one tick until a trailing full-list refetch lands, and the row blinks.
// Because the id is client-minted and stable, insert is same-key like update, so
// a plain upsert lands on the right row. Never rely on the trailing refetch for
// visual correctness.
function reconcile<Row extends EntityRow>(
  collection: Collection<Row, string>,
  delta: { upsert?: Row[]; remove?: string[] },
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
// list never hard-crashes; offline writes are not durable in this mode.
export function createInMemoryEntityApi<
  Row extends EntityRow,
  Verbs extends AnyVerbs<Row>,
>(deps: {
  spec: EntitySpec<Row, Verbs>;
  queryClient: QueryClient;
}): EntityApi<Row, Verbs> {
  const { spec, queryClient } = deps;
  const verbs = looseVerbs<Row>(spec.verbs);
  const queryKey = entityQueryKey(spec.name);

  const collection = createCollection(
    queryCollectionOptions({
      queryClient,
      queryKey,
      queryFn: () => spec.fetch(),
      getKey: (r: Row) => r.id,
      onInsert: async ({ transaction }) => {
        // The client-minted id is the server's dedupe key. Reconcile the
        // server's row into the synced base before returning, so releasing the
        // optimistic overlay reveals the same-id row and never blinks; skip the
        // auto-refetch that would otherwise churn the whole list.
        for (const m of transaction.mutations) {
          // A revive whose row was absent inserts optimistically; route it to the
          // revive persist (reopen/unprocess), NOT the entity's add verb.
          const revive = reviveVerbFromMetadata(verbs, m.metadata);
          if (revive) {
            const updated = await revive.persist(
              String(m.key),
              {
                changes: m.changes,
                modified: m.modified,
                original: "original" in m ? (m.original as Row) : undefined,
              },
              (m.metadata as OpMetadata).args,
            );
            reconcile(
              collection,
              spec.leavesCollection?.(updated)
                ? { remove: [updated.id] }
                : { upsert: [updated] },
            );
            continue;
          }
          const verb = insertVerbOf(spec.name, verbs);
          const real = await verb.persist(m.modified);
          reconcile(collection, { upsert: [real] });
        }
        return { refetch: false };
      },
      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          const mutation = {
            changes: m.changes,
            modified: m.modified,
            original: m.original,
          };
          // A revive whose row was still present updates in place; route by its
          // metadata. Everything else routes by the changed-field heuristic.
          const verb =
            updateVerbFromMetadata(verbs, m.metadata) ??
            routeUpdate(spec.name, verbs, mutation);
          const updated = await verb.persist(
            String(m.key),
            mutation,
            (m.metadata as OpMetadata).args,
          );
          if (spec.leavesCollection?.(updated)) {
            reconcile(collection, { remove: [updated.id] });
          } else {
            reconcile(collection, { upsert: [updated] });
          }
        }
        return { refetch: false };
      },
      onDelete: async ({ transaction }) => {
        // The optimistic overlay already removed the row; issue the server
        // delete and let a failure roll the removal back. Nothing to reconcile.
        const verb = deleteVerbOf(spec.name, verbs);
        for (const m of transaction.mutations) {
          await verb.persist(String(m.key));
        }
        return { refetch: false };
      },
    }),
  );

  const refetchUtil = (
    collection as { utils?: { refetch?: () => Promise<unknown> } }
  ).utils?.refetch;

  const actions = {} as Record<string, (args: unknown) => Transaction>;
  for (const [name, verb] of Object.entries(verbs)) {
    if (verb.kind === "insert") {
      actions[name] = (args) => collection.insert(mintRow<Row>(verb.row(args)));
    } else if (verb.kind === "update") {
      actions[name] = (args) =>
        collection.update(
          verb.id(args),
          { metadata: { verb: name, args } },
          asDraft(verb.draft(args)),
        );
    } else if (verb.kind === "revive") {
      actions[name] = reviveAction(collection, name, verb);
    } else {
      // collection.delete is typed Transaction<any>; narrow to the map's type.
      actions[name] = (args) =>
        collection.delete(verb.id(args)) as Transaction;
    }
  }

  return {
    collection,
    actions: actions as EntityApi<Row, Verbs>["actions"],
    offline: false,
    refetch: async () => {
      if (refetchUtil) {
        await refetchUtil();
      } else {
        await queryClient.invalidateQueries({ queryKey });
      }
    },
    // The Query Collection records its fetch error in the react-query cache; read
    // it there so the load-error channel is uniform across both builders.
    getLoadError: () => {
      const state = queryClient.getQueryState(queryKey);
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
// server list in the background and reconciles it into the synced base. Cached
// rows paint at once and the network updates them in place, instead of the live
// query waiting on the first network fetch. Writes go through an offline outbox
// that retries when the network returns; the executor's mutationFns call the
// REST API and reconcile the server's row.
//
// It is deliberately NOT `queryCollectionOptions` wrapped in persistence: that
// makes the collection `sync-present`, where readiness is gated on the network
// query, so the local snapshot sat behind "Loading…" for the whole round trip
// (see docs/todo-app.md). The custom sync stays sync-present (writes still
// persist) but readiness comes from the cache.
export function createPersistedEntityApi<
  Row extends EntityRow,
  Verbs extends AnyVerbs<Row>,
>(deps: {
  spec: EntitySpec<Row, Verbs>;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): EntityApi<Row, Verbs> {
  const { spec, persistence, startOfflineExecutor, onWarn = noopWarn } = deps;
  const verbs = looseVerbs<Row>(spec.verbs);

  // The sync's write controls, captured when the collection starts syncing.
  // reconcile* and refetch write server data through these; null until the first
  // subscription starts the sync, so every use guards on it.
  type SyncStart = Parameters<SyncConfig<Row, string>["sync"]>[0];
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
  let collection: Collection<Row, string>;

  // Write one server row into the synced base by its stable id: upsert it, or
  // delete it when it has left the working set. Used after each write's REST call.
  const reconcileOne = (row: Row) => {
    if (!controls) return;
    controls.begin();
    if (spec.leavesCollection?.(row)) {
      if (collection.has(row.id)) controls.write({ type: "delete", key: row.id });
    } else {
      controls.write({
        type: collection.has(row.id) ? "update" : "insert",
        value: row,
      });
    }
    void controls.commit();
  };

  // Remove a row from the synced base by id, after a server delete. The delete's
  // optimistic overlay is released when its transaction confirms, and the synced
  // base still holds the row (optimistic mutations never touch the base), so
  // without this the deleted row reappears until the next fetch. Guarded on the
  // base holding the key — but the key is checked against the collection, whose
  // effective state already dropped the row via the optimistic overlay, so the
  // delete is issued unconditionally (a base delete of an absent key is a no-op).
  const reconcileRemove = (id: string) => {
    if (!controls) return;
    controls.begin();
    controls.write({ type: "delete", key: id });
    void controls.commit();
  };

  // Replace the synced rows with the server's authoritative list: upsert each
  // server row and delete any synced row the server no longer returns. Deletes
  // hit only the synced base, so a pending optimistic row (not yet in the base)
  // is left untouched.
  const reconcileList = (server: Row[]) => {
    if (!controls) return;
    controls.begin();
    for (const write of reconcileWrites(collection.keys(), server)) {
      controls.write(write);
    }
    void controls.commit();
  };

  const fetchAndReconcile = async () => {
    try {
      const rows = await spec.fetch();
      setLoadError(null);
      reconcileList(rows);
    } catch (err) {
      setLoadError(messageOf(err));
    }
  };

  const sync: SyncConfig<Row, string> = {
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
    persistedCollectionOptions<Row, string>({
      id: spec.name,
      getKey: (r: Row) => r.id,
      schemaVersion: ENTITY_CACHE_VERSION,
      persistence,
      sync,
    }),
  );

  // One outbox mutationFn per verb, keyed by the verb's name (the durable
  // contract: a queued write replays by this name). The outbox types a
  // mutation's fields as unknown; the verb's persist gets the row as typed.
  const mutationFns: OfflineConfig["mutationFns"] = {};
  for (const [name, verb] of Object.entries(verbs)) {
    mutationFns[name] = async ({ transaction }) => {
      for (const m of transaction.mutations) {
        if (verb.kind === "insert") {
          const real = await verb.persist(m.modified as Row);
          reconcileOne(real);
        } else if (verb.kind === "update" || verb.kind === "revive") {
          // A revive persists exactly like an update (reopen/unprocess by id),
          // whether the optimistic op was an insert (row was evicted) or an
          // update (row still present); reconcileOne re-adds the server's row.
          const updated = await verb.persist(
            String(m.key),
            {
              changes: m.changes as Partial<Row>,
              modified: m.modified as Row,
              original: m.original as Row,
            },
            (m.metadata as OpMetadata).args,
          );
          reconcileOne(updated);
        } else {
          // Delete: issue the server delete, then remove the row from the synced
          // base too. The optimistic overlay drop is released when this
          // transaction confirms and the base still holds the row, so without
          // this reconcile the deleted row reappears until the next fetch.
          await verb.persist(String(m.key));
          reconcileRemove(String(m.key));
        }
      }
      // Re-pull after an insert, or an update/revive that asked for it; a delete
      // has nothing to re-pull (the row is gone). A revive should refetch: the
      // open list now includes the revived row, so it is retained.
      if (
        verb.kind === "insert" ||
        ((verb.kind === "update" || verb.kind === "revive") &&
          verb.refetchAfter !== false)
      ) {
        await fetchAndReconcile();
      }
    };
  }

  const offline = startOfflineExecutor({
    collections: { [spec.name]: collection },
    mutationFns,
    onLeadershipChange: (isLeader) => {
      // Non-leader tabs / instances run online-only; fine for a single-user list.
      if (!isLeader) {
        onWarn(
          `${spec.name}: another instance holds the offline outbox; this one is online-only`,
        );
      }
    },
  });

  const actions = {} as Record<string, (args: unknown) => Transaction>;
  for (const [name, verb] of Object.entries(verbs)) {
    const onMutate =
      verb.kind === "insert"
        ? (args: unknown) => {
            collection.insert(mintRow<Row>(verb.row(args)));
          }
        : verb.kind === "update"
          ? (args: unknown) => {
              collection.update(
                verb.id(args),
                { metadata: { verb: name, args } },
                asDraft(verb.draft(args)),
              );
            }
          : verb.kind === "revive"
            ? (() => {
                // Same optimistic op as in-memory: update-if-present, else
                // re-insert. The outbox routes by this verb's name, not the op.
                const doRevive = reviveAction(collection, name, verb);
                return (args: unknown) => {
                  doRevive(args);
                };
              })()
            : (args: unknown) => {
                collection.delete(verb.id(args));
              };
    actions[name] = offline.createOfflineAction<unknown>({
      mutationFnName: name,
      onMutate,
    });
  }

  return {
    collection,
    actions: actions as EntityApi<Row, Verbs>["actions"],
    offline: true,
    refetch: () => fetchAndReconcile(),
    getLoadError: () => loadError,
    subscribeLoadError: (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
  };
}

// Build an entity's data layer: try durable offline persistence, fall back to
// the in-memory Query Collection if persistence cannot start (private browsing /
// no native SQLite). `persistence` is a thunk because opening the local database
// is async and may throw; centralizing the try/catch keeps both apps' wiring thin.
export async function createEntityApi<
  Row extends EntityRow,
  Verbs extends AnyVerbs<Row>,
>(deps: {
  spec: EntitySpec<Row, Verbs>;
  queryClient: QueryClient;
  persistence?: () =>
    | Promise<PersistedCollectionPersistence>
    | PersistedCollectionPersistence;
  startOfflineExecutor?: StartOfflineExecutor;
  onWarn?: WarnFn;
}): Promise<EntityApi<Row, Verbs>> {
  const {
    spec,
    queryClient,
    persistence,
    startOfflineExecutor,
    onWarn = noopWarn,
  } = deps;
  if (persistence && startOfflineExecutor) {
    try {
      const resolved = await persistence();
      return createPersistedEntityApi({
        spec,
        persistence: resolved,
        startOfflineExecutor,
        onWarn,
      });
    } catch (err) {
      onWarn(
        `${spec.name}: offline SQL persistence unavailable, using in-memory fallback`,
        err,
      );
    }
  }
  return createInMemoryEntityApi({ spec, queryClient });
}

// The deps every entity's public factory accepts, minus the spec. Each entity
// adds its `rest` and re-wraps the result into its own named API.
export type EntityApiDeps = {
  queryClient: QueryClient;
  persistence?: () =>
    | Promise<PersistedCollectionPersistence>
    | PersistedCollectionPersistence;
  startOfflineExecutor?: StartOfflineExecutor;
  onWarn?: WarnFn;
};
