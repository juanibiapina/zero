# Storage (how the todo app saves data)

How the todo app persists its entities, across both layers. Entity docs
(`docs/entities/*`) describe an entity's shape and behavior and point here for the
storage mechanics — they do not re-explain how data is saved. This file is the
source of truth for that.

There are two layers: the **server** (authoritative) and the **client**. `TaskDO`
is the only server authority for todo data. Updated mobile clients use a complete
TinyBase replica whose acknowledged local writes persist offline and merge with
the server replica. Web uses the same shared replica implementation with browser
persistence and lifecycle adapters. Older installed clients can still use the
code bundled into those builds, but their REST requests reach the same `TaskDO`.

## TaskDO local-replica path

Every signed-in account uses a separate `TaskDO`, resolved by
`TASK_DO.idFromName(clerkUserId)`. Its TinyBase mergeable store persists to the
Durable Object's SQLite storage. The in-process `TaskDomain` owns row decoding,
todo mutations, recurrence, ordering, cascades, conflict checks, and recovery
projections over that store. `TaskDO` retains the Durable Object lifecycle:
SQLite persistence, WebSocket synchronization, socket shutdown, and account
purge/erasure protection. Mobile persists an account-named Expo SQLite replica;
web persists an account-named IndexedDB replica. Both synchronize through the
same authenticated WebSocket and expose `TasksApi`, `ProjectsApi`, and
`WaitsApi` from the shared `@zero/agent-core` replica. Their screens read one
derived view over the local store; Task, Project, and Waiting/After writes
persist locally before sync. REST uses typed writes to the same TaskDO. Current
clients do not open retired todo caches or outboxes, and upgrades leave those
legacy files and browser databases untouched.
Project deletion tombstones the Project and removes its known children.
REST also edits Projects and creates/resolves/deletes manual Waiting and After
rows. Done/reopen settles/restores Afters. A late offline child or
arbitrary missing-Project reference remains in the raw replica but appears as
loose work in Task REST, with the original relationship listed at
`/api/task-recoveries`. Invalid or cyclic raw After rows remain in the replica
and appear in the same recovery report instead of in the accepted open list.
REST also handles Task dates, ordering, completion/Undo, and recurrence
with retry-safe occurrence cursors. Invalid synced recurrence stays in the raw
replica, appears in the recovery report, and blocks occurrence completion. The
Home lists recovery IDs, work text, reasons, and safe repair actions. A
real-Worker restart/fresh-WebSocket proof retains terminal,
recurring, resolved, and recoverable rows. Concurrent same-field edits use
TinyBase last-writer-wins by decision; a losing value is not retained. Direct
TinyBase sync still accepts arbitrary cells, so invalid relationships remain raw
and are excluded from accepted views until repaired. Old REST clients keep their
existing URLs, so durable queued actions also land in `TaskDO`. Account deletion
retains a marker in `TaskDO` so a stale offline replica cannot repopulate erased
data on reconnect.

## Server layer (authoritative)

- Every signed-in account stores todo entities in its per-account `TaskDO`
  TinyBase mergeable store. Todo REST routes and WebSocket synchronization use
  that same authority.
- `UserDO` still owns agent conversations, settings, captures, and other
  non-todo data. The migrated account's old todo tables remain inert recovery
  data: current code neither reads nor writes them.
- Non-todo entities continue to use **do-orm** plus one per-entity domain store
  (for example `DbCaptureStore`) with explicit domain methods.
- One table per entity (e.g. `captures`). The table shape lives in the entity's
  own doc.

## Client replicas

The shared `@zero/agent-core` replica owns projection, recovery, mutation rules,
and construction of the three screen-facing APIs. Platform adapters own only
persistence, authentication, WebSocket construction, and lifecycle events.

- **Mobile:** one Expo SQLite file per Clerk account, named
  `taskdo-fixture-<account-id>.sqlite`. App foregrounding prompts reconnection.
- **Web:** one TinyBase IndexedDB database per Clerk account, named
  `zero-taskdo-replica-<account-id>`. The adapter loads it before exposing the
  todo owner, then opens same-origin `/api/task-sync`; Clerk authenticates the
  WebSocket upgrade from the existing session cookie. No token is placed in the
  URL. Reconnect uses bounded exponential backoff and retries immediately when
  the browser comes online or the document becomes visible.
- **Local-first:** screens render the persisted replica without waiting for the
  network. A disconnected WebSocket is ordinary offline operation. Mutations
  update the local mergeable store and retain TinyBase merge metadata, including
  terminal rows needed for Undo and recurrence.
- **Multi-tab:** an account-specific Web Lock serializes each persistence
  operation. Before saving, a tab loads persisted mergeable content into a
  temporary store and merges it into its live store; it never replaces live
  content with a stale snapshot. After saving, it notifies sibling tabs through
  an account-specific BroadcastChannel. Visible tabs also refresh every ten
  seconds as a safety net and refresh immediately when they become visible;
  hidden tabs do not poll. This preserves concurrent offline changes and merge
  metadata while allowing every tab to receive current rows promptly.
- **Fallback:** if IndexedDB or Web Locks are unavailable, web uses an in-memory
  replica that still synchronizes online and reports that offline durability is
  unavailable.
- **Account lifecycle:** web closes the synchronizer and persister before it
  exposes another account. Database names include the Clerk account ID, so one
  account cannot hydrate another account's rows.

The retired web OPFS database and IndexedDB outbox are not opened, migrated,
replayed, or deleted. They remain inert in existing browser profiles.

## Recurring Task transitions

A recurring completion is an in-place state transition, not a completed-row
removal. Task stores versioned `recurrence` JSON and a `recurrenceDate` cursor;
`showUpDate` can differ after a one-off postpone. The optimistic complete verb
calls `@zeroapps/recurrence.advance`, updates both dates when another occurrence
exists, and sets `completedAt` only when the inclusive end is exhausted.

The shared replica applies completion locally with the user's `completedOn`
date, and the complete TinyBase metadata survives restart. TaskDO accepts the occurrence's prior
`recurrenceDate` as `scheduledOn` and advances only when it still matches the
stored cursor. A repeated or stale write returns current state without advancing
again.

Recurring Undo carries the full pre-completion Task snapshot. It conditionally
restores that snapshot only while the server cursor still matches the expected
post-completion cursor. The revive path covers an exhausted series whose row was
reconciled out of the open working set; an in-place update covers an ordinary
advance whose row remained open.

## Replica durability

The account-scoped TinyBase replica is durable local user state, not a
disposable cache. It retains complete merge metadata so offline changes can
converge after restart. Recovery projection excludes invalid synchronized rows
from accepted views while retaining their raw intent until the user chooses a
safe repair.
