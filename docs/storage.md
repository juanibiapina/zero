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
  retries on reconnect. The verb names are the outbox's mutationFn names and the
  entity name is the local table id, so both are part of the durable contract
  and never renamed.
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
- **Offline write outbox.** Web uses `@tanstack/offline-transactions` on
  IndexedDB (unrelated to the SQLite file). Mobile has no IndexedDB, so it keeps
  the outbox in its own SQLite file, `zero-app-outbox.sqlite`, separate from the
  data file so a persistence schema reset never wipes queued writes.
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

## The cache is disposable

Losing the local SQLite cache costs nothing but a one-time re-sync: on the next
open, each collection rebuilds from the server, instant thereafter. So a change
to the cache shape (a new collection id, or merging the old per-entity files
`zero-inbox.sqlite` / `zero-today.sqlite` into `zero-app.sqlite`) orphans the old
local files and re-syncs once on first launch after upgrade. No migration copies
the old cache; it is not worth it.

The **one** thing at risk is an unsynced write still sitting in the mobile
outbox: renaming or resetting the outbox file strands writes made while offline
that never reached the server. The outbox file is therefore treated as more
durable than the data cache and is not renamed casually.
