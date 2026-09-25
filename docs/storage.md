# Storage (how the todo app saves data)

How the todo app persists its entities, across both layers. Entity docs
(`docs/entities/*`) describe an entity's shape and behavior and point here for the
storage mechanics — they do not re-explain how data is saved. This file is the
source of truth for that.

There are two layers: the **server** (authoritative) and the **client**. Current
real accounts use a disposable TanStack client cache. The prepared TaskDO path
uses a complete TinyBase client replica whose acknowledged local writes persist
offline and merge with the server replica.

## TaskDO local-replica path (not active for real accounts)

In `ENVIRONMENT=test`, accounts named `taskdo-proof-*` use a separate per-account
`TaskDO`, resolved by `TASK_DO.idFromName(clerkUserId)`. Its TinyBase mergeable
store persists to the Durable Object's SQLite storage; the signed-in mobile Home
fixture persists a separate account-named Expo SQLite replica and synchronizes it
through an authenticated WebSocket. All signed-in fixture todo screens now read
one derived view over that same file; Task, Project, and Waiting/After writes
persist there before sync. REST uses typed writes to the same TaskDO.
Project deletion tombstones the Project and removes its known children.
Fixture REST now also edits Projects and creates/resolves/deletes manual Waiting
and After rows. Done/reopen settles/restores Afters. A late offline child or
arbitrary missing-Project reference remains in the raw replica but appears as
loose work in Task REST, with the original relationship listed at
`/api/task-recoveries`. Invalid or cyclic raw After rows remain in the replica
and appear in the same recovery report instead of in the accepted open list.
Fixture REST also handles Task dates, ordering, completion/Undo, and recurrence
with retry-safe occurrence cursors. Invalid synced recurrence stays in the raw
replica, appears in the recovery report, and blocks occurrence completion. The
Home lists recovery IDs, work text, reasons, and safe repair actions. A
real-Worker restart/fresh-WebSocket proof retains terminal,
recurring, resolved, and recoverable rows. Concurrent same-field edits use
TinyBase last-writer-wins by decision; a losing value is not retained. Direct
TinyBase sync still accepts arbitrary cells, so invalid relationships remain raw
and are excluded from accepted views until repaired.
Normal accounts and web still use the storage path below. The prepared
one-account migration freezes `UserDO`, copies every open and terminal row,
compares every field, activates `TaskDO`, and then changes a durable authority
marker. No real account has been switched. Old REST clients keep their existing
URLs after a switch, so their durable queued actions replay into `TaskDO`.
TaskDO retains a deletion marker after erasing data to reject stale replicas on
reconnect.

## Server layer (authoritative)

- Every live account currently stores todo entities in the **per-user `UserDO`**
  SQLite database. The prepared authority marker can route one explicitly
  switched account's todo entities to its per-account `TaskDO`; no account has
  been switched yet.
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
  REST call is the idempotent `reopen`/`unprocess` endpoint. Every update/revive
  tags its optimistic operation with `{ verb, args }`: the in-memory builder routes
  by verb name, while the durable outbox keeps action arguments for replay. Legacy
  queued updates without metadata still fall back to changed-field matching. This
  is the mirror of the delete caveat above: an update-by-id Undo passes every
  in-memory test yet fails on the real persisted backend, so it is verified
  on-device.

## Recurring Task transitions

A recurring completion is an in-place state transition, not a completed-row
removal. Task stores versioned `recurrence` JSON and a `recurrenceDate` cursor;
`showUpDate` can differ after a one-off postpone. The optimistic complete verb
calls `@zeroapps/recurrence.advance`, updates both dates when another occurrence
exists, and sets `completedAt` only when the inclusive end is exhausted.

Update/revive verbs persist their initiating arguments in TanStack mutation
metadata. The durable outbox therefore retains the user's local `completedOn`
date across restart. The server accepts the occurrence's prior
`recurrenceDate` as `scheduledOn` and advances only when it still matches the
stored cursor. A repeated or stale write returns current state without advancing
again.

Recurring Undo carries the full pre-completion Task snapshot. It conditionally
restores that snapshot only while the server cursor still matches the expected
post-completion cursor. The revive path covers an exhausted series whose row was
reconciled out of the open working set; an in-place update covers an ordinary
advance whose row remained open.

## The cache is disposable

Losing synchronized entity snapshots costs one server re-sync. Bump
`ENTITY_CACHE_VERSION` once to invalidate every collection on mobile and web;
each normal fetch then rebuilds its local table. Do not add per-entity versions
or cache-shape migrations.

The outbox is different: it can contain writes that reached no server. A cache
version bump leaves it intact. Bump `OFFLINE_OUTBOX_VERSION` only when a breaking
mutation change makes queued writes unreadable and product policy explicitly
accepts discarding them. The Project state refactor moved both versions to 2.
The Waiting/After change moves only `ENTITY_CACHE_VERSION` to 3: it clears cached
Task relationships and Blocked presentation, while the existing durable
`addWaitingCondition` payload remains readable for queued manual Waiting and
Project-completion writes. Queued Task or arbitrary-status relationship writes
are acknowledged locally as removed legacy operations and never recreated.
