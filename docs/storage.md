# Storage (how the todo app saves data)

How the todo app persists its entities, across both layers. Entity docs
(`docs/entities/*`) describe an entity's shape and behavior and point here for the
storage mechanics — they do not re-explain how data is saved. This file is the
source of truth for that.

There are two layers: the **server** (authoritative) and the **client** (an
offline cache). The server owns the data; the client cache is disposable and
re-syncs from the server whenever it is missing or reset.

## Server layer (authoritative)

- Every entity lives in the **per-user `UserDO`** (Durable Object) SQLite
  database. One `UserDO` per user isolates each user's data.
- Access goes through **do-orm** plus **one per-entity domain store** (e.g.
  `DbCaptureStore`) that exposes that entity's DOMAIN methods (`add`, `list`,
  `process`, …). Domain methods keep the storage seam narrow and the intent
  explicit.
- One table per entity (e.g. `captures`). The table shape lives in the entity's
  own doc.

## Client layer (offline cache)

The client keeps a durable local copy so the UI paints instantly offline and
reconciles with the server in the background.

- Each entity is a **TanStack DB collection**, built from the one shared factory
  in `@zero/agent-core` (`src/collection/base.ts`). An entity describes itself
  with a spec — its name, how to fetch its working set, and a **verb table**
  (an insert verb, update verbs each with its optimistic draft, and an optional
  delete verb — each with its REST call) — and the factory supplies everything
  below: reads persist to a local
  SQLite database for offline use; writes go through an **offline outbox** that
  retries on reconnect. Every persisted collection uses the shared
  `ENTITY_CACHE_VERSION` from `src/collection/version.ts`; bumping it resets all
  synchronized entity snapshots and refills them from the server. Verb names are
  the outbox's mutationFn names and remain durable until the separate outbox
  epoch is intentionally bumped.
- **One local database file for the whole app: `zero-app.sqlite`.** TanStack DB
  derives a separate table per collection from its collection id (recorded in a
  `collection_registry` table), so every entity gets its own table inside the one
  file without sharing a table. There is no per-entity database file.
- The app opens the database handle **once** (OPFS on web, op-sqlite on mobile)
  AND builds the persistence object **once**, sharing that single object across
  every collection. One persistence object means one driver with one transaction
  queue, so concurrent transactions from different collections never interleave
  into a nested `BEGIN IMMEDIATE`. Building a persistence object per collection —
  even over the same handle — would create a second queue over the one connection
  and corrupt transactions.
- **Offline write outbox.** Web uses a versioned IndexedDB adapter. Mobile has no
  IndexedDB, so it uses a versioned `zero-app-outbox-v<N>.sqlite` file. Both read
  `<N>` from the shared `OFFLINE_OUTBOX_VERSION`. The outbox version is separate
  from `ENTITY_CACHE_VERSION` because it contains unsent user writes, not cached
  server rows; a normal cache reset must not discard it.
- **Reads are local-first.** A collection is ready from its cached snapshot
  immediately: a custom sync calls `markReady()` as soon as the local hydrate
  finishes, then fetches the server in the background and reconciles the result
  into the synced base (a pure diff: update present, insert new, delete removed).
  A refetch also fires on app-foreground (`AppState` / `visibilitychange`) so a
  returning user sees fresh rows without a cold start. The default persisted
  wrapper instead defers `markReady()` until the network resolves, which would
  hide the cached snapshot behind the network round-trip.
- If durable persistence cannot start (private browsing, older browsers, the
  Metro dev client, which throws `Expected HMRClient.setup() call at startup`),
  the collection falls back to an in-memory Query Collection. The durable path
  only runs on a standalone build, so verify offline/loading behavior on a
  `preview`/`production` build.
- **A delete reconciles the row out of the synced base**, not just the optimistic
  overlay. The overlay is released when the delete transaction confirms, and the
  base still holds the row (optimistic mutations never touch the base), so a
  delete that only issues the server call makes the row reappear until the next
  fetch. The durable path's delete mutationFn therefore removes the row from the
  base after the REST call; the in-memory fallback does not hit this, so a delete
  bug can pass every in-memory test and only show on a real backend.
- **A row can leave the working set and come back — that needs a `revive` verb,
  not an update.** The server returns only the open working set (tasks with
  `completedAt IS NULL`, captures with `processedAt IS NULL`), so completing a
  task or processing a capture makes the row leave: the trailing refetch
  reconciles it out of the collection. The Undo on the complete/process snackbar
  must bring it back, but an **update-by-id cannot** — by the time Undo runs the
  row is gone and `collection.update` throws "key not found". So `reopen` /
  `unprocess` are a fourth verb kind, **`revive`**: the inverse of a write that
  leaves the working set. A revive carries the **full row** (the snackbar has it
  in scope) so it can **re-insert** the row when absent, and updates it in place
  when Undo is tapped before the eviction lands. It re-inserts with the row's own
  id preserved (never a minted one), so it is the same row the server has, and its
  REST call is the idempotent `reopen`/`unprocess` endpoint. Routing: the durable
  outbox routes by the verb's name, but the in-memory builder routes by operation
  type, so a revive tags its optimistic op with `{ verb: name }` metadata and both
  `onInsert`/`onUpdate` route on it. This is the mirror of the delete caveat
  above: an update-by-id Undo passes every in-memory test (the fallback keeps the
  completed row until a refetch) yet fails on the real persisted backend, so it is
  verified on-device. (A future simplification: tag every op with its verb name
  and delete the changed-field `matches` routing entirely.)

## The cache is disposable

Losing synchronized entity snapshots costs one server re-sync. Bump
`ENTITY_CACHE_VERSION` once to invalidate every collection on mobile and web;
each normal fetch then rebuilds its local table. Do not add per-entity versions
or cache-shape migrations.

The outbox is different: it can contain writes that reached no server. A cache
version bump leaves it intact. Bump `OFFLINE_OUTBOX_VERSION` only when a breaking
mutation change makes queued writes unreadable and product policy explicitly
accepts discarding them. The Project state refactor is the first such reset: it
renames the Project row and mutation verb, so both versions move to 2.
