# Storage (how the todo app saves data)

How the todo app persists its entities, across both layers. Entity docs
(`docs/entities/*`) describe an entity's shape and behavior and point here for the
storage mechanics — they do not re-explain how data is saved. This file is the
source of truth for that.

There are two layers: the **server** (authoritative for synchronized accounts)
and the **client**. `TaskDO` is the only server authority for todo data. Mobile
and web open a local TinyBase workspace immediately, including when no account
is signed in. Acknowledged local writes persist offline; after first sign-in,
that guest work merges into the bound account and synchronizes with the server.
Both use the shared replica implementation with platform persistence and
lifecycle adapters.
Older installed clients can still use the code bundled into those builds, but
their REST requests reach the same `TaskDO`.

## TaskDO local-replica path

Every signed-in account uses a separate `TaskDO`, resolved by
`TASK_DO.idFromName(clerkUserId)`. Its TinyBase mergeable store persists to the
Durable Object's SQLite storage. The platform-neutral `TodoModel` in
`@zero/agent-core` operates directly on any TinyBase mergeable store. It owns
row decoding, accepted projections, todo mutations, recurrence, ordering,
cascades, conflict checks, and recovery classification and repair. The
in-process `TaskDomain` is the TaskDO adapter: it rejects erased-account writes,
saves successful typed mutations, and maps canonical conflicts and issues to
the established RPC and REST values. It also runs operation catalog entries for
the MCP server ([`mcp.md`](mcp.md)) with the same erasure and save policy. `TaskDO` retains the Durable Object
lifecycle: SQL persistence, WebSocket synchronization, socket shutdown, and
account purge/erasure protection. Mobile persists its current workspace in Expo
SQLite; web persists an account-named IndexedDB replica. Bound mobile workspaces
and web replicas synchronize through the same authenticated WebSocket. The
shared replica adapter exposes one replica with `tasks`, `projects`, and `waits`
operation groups. It
builds their TanStack collections, publishes query projections, maps
client-facing errors and recovery actions, and waits for local persistence
before reporting a transaction persisted. Current clients do not open retired todo caches or
outboxes, and upgrades leave those legacy files and browser databases untouched.
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
- `UserDO` still owns agent conversations, settings, schedules, and other
  non-todo state. Migration 0057 removes its retired physical todo tables after
  TaskDO became the sole authority.

## Client replicas

The canonical `@zero/agent-core` model owns projection, recovery, and mutation
rules. The shared replica is a TanStack adapter with one screen-facing
interface. Its three entity collections share one store, transaction model,
recovery channel, and replica-level refresh operation. A shared synchronization
lifecycle owns connection-attempt deduplication, TinyBase synchronization,
bounded reconnect backoff, refresh, and race-safe teardown. Web's shared
account-replica owner immediately hides the previous account, serializes its
teardown before opening the next account, and ignores stale opens and events.
Mobile wraps the replica with its device-workspace lifecycle. Platform adapters
own persistence, authentication, WebSocket construction, connection
eligibility, durability reporting, and platform lifecycle events.

- **Mobile:** one saved workspace descriptor selects the current Expo SQLite
  file. A fresh signed-out install creates
  `taskdo-workspace-<device-workspace-id>.sqlite` and uses it locally without a
  server connection. The first sign-in binds that same file to the Clerk
  account and enables TaskDO WebSocket synchronization; it does not copy the
  rows into a second database. Existing account-first installs keep opening
  `taskdo-fixture-<account-id>.sqlite`, preserving the historical filename.
  App foregrounding prompts reconnection; pull-to-refresh requests a TinyBase
  synchronization round or reconnects first. Each SQLite file has one active
  owner, which loads it once on open and automatically saves subsequent changes.
  Refresh keeps the live store intact; reloading disk snapshots during edits can
  overwrite changes and make TinyBase skip saves.
- **Web:** account replicas use `zero-taskdo-replica-<account-id>` in IndexedDB;
  guests use a separate `zero-taskdo-replica-guest-<uuid>` database without a
  server connection. The localStorage registry `zero.todo-workspaces.v1`
  selects the guest and records pending first-account adoptions. A browser-wide
  Web Lock serializes ownership changes. Binding takes the guest persistence
  lock before recording the account; stale guest tabs then reject writes.
  Adoption merges complete TinyBase content into the existing account store
  under its persistence lock before synchronization begins. Only a durable
  destination save retires the adoption record. Failed adoption remains
  retryable for the bound account and never becomes available to another
  account. The retired guest database remains inert.
  Bound replicas open same-origin `/api/task-sync`; Clerk authenticates the
  upgrade from the existing session cookie. No token is placed in the URL.
  Reconnect uses bounded exponential backoff and retries immediately when the
  browser comes online or the document becomes visible. Sync details also
  offer explicit Refresh.
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
- **Durability failures:** a failed local save rejects the transaction's
  persistence acknowledgment, reports unavailable offline storage, and retains
  raw local intent. A successful local retry restores durability.
- **Fallback:** unavailable IndexedDB produces an in-memory replica and a
  durability warning. An account with no guest registry can also synchronize
  in memory when Web Locks are unavailable. Guest ownership and adoption
  require Web Locks and localStorage. Unavailable or contradictory ownership
  information produces a retry state and keeps existing databases intact.
- **Account lifecycle:** mobile owns the device workspace around the shared
  replica. Explicit sign-out first checkpoints acknowledged sync, closes the
  persistence handle, deletes the bound local database and account-only caches,
  and then creates a fresh guest workspace. If Clerk loses authentication
  unexpectedly, the descriptor stays bound and the local rows remain locked;
  signing back into that account unlocks them. A different account cannot open
  or rebind the workspace: the user can sign that account out while retaining
  the locked copy, or explicitly delete the device copy before continuing.
  Web closes one workspace before exposing another and hides stale opens and
  events. Sign-out retains the account database and opens a separate guest
  workspace. Switching accounts opens only that account's replica; guest data
  already bound to another account is excluded. Storage notifications cause
  signed-out sibling tabs to reopen the current guest after adoption.

The retired web OPFS database and IndexedDB outbox are not opened, migrated,
replayed, or deleted. They remain inert in existing browser profiles.

## Medicine and Dose storage

The same TinyBase workspace synchronizes `medicines` and `doses`. Medicine stores validated details as one serialized value and retains a deletion tombstone. Daily slots remain nested configuration. Dose keys encode Medicine, slot, and local date; confirmations store action identity, taken time, and the schedule snapshot together in one cell. Concurrent same-cell writes use the existing last-writer-wins policy. Invalid rows remain raw and appear in recovery; deleted parents suppress late offline children.

Supply lives in its own Medicine cells, separate from `details`: `pillsLeft`, `leadDays`, and `refill` (the last restock amount). A dose time's pills are `amount` inside `details`, and a slot stored without it reads as 1. `MedicineModel.take` and `undo` change `pillsLeft` only when the Dose changes between untaken and taken, in the same transaction as the confirmation. A write that takes the supply from not low to low creates the restock Task in that transaction. Two devices that take different doses offline both write `pillsLeft` from the same value, and last writer wins.

A Task's parent is a typed union in code and separate cells in storage: `projectId` for a Project, or `medicineId` and `role` (`restock`) for a Medicine. Writing a parent clears the other kind's cells. A row with both, left by an older app that moved a restock Task into a Project, reads as the Project's Task. A parent that no longer exists reads as no parent. MCP and the Task REST routes keep `projectId`.

Android also owns a durable native notification store, used by alarm receivers without React. Each source, such as `medicines`, installs its own schedule there. A notification Taken first settles the dose natively and writes a receipt. Import maps the receipts to Doses, applies them with replay markers in `medicineReceipts`, waits for SQLite persistence, acknowledges the receipts, and then installs a schedule whose settled dates come from the shared store. Each install keeps native settlement only for receipts not yet acknowledged, so a winning Undo controls the result and a Taken that arrives during an import stays silent until its own import. In-app Taken uses this same path. Before ordinary sign-out, the store quiesces and receipts import before the existing sync checkpoint and workspace deletion. Explicit discard or account erasure removes native state along with the local workspace. Guest binding retains the database identity and its native receipt ownership. The native store lives outside Android backup, and a workspace that turns reminders on takes over a store another workspace left behind, unless that store still holds settle receipts the other workspace has not imported.

Native delivery state and reminder enablement are device-local implementation state; Medicine and Dose remain the two product models. Product behavior lives in [`Medicine and Dose`](entities/medicine.md), and Android delivery in the [notification module](../apps/agent-mobile/modules/zero-notifications/README.md).

## Recurring Task transitions

A recurring completion is an in-place state transition, not a completed-row
removal. Task stores versioned `recurrence` JSON and a `recurrenceDate` cursor;
`showUpDate` can differ after a one-off postpone. The canonical model calls
`@zeroapps/recurrence.advance`, updates both dates when another occurrence
exists, and sets `completedAt` only when the inclusive end is exhausted.

The canonical model plans and applies completion locally with the user's
`completedOn` date, and the complete TinyBase metadata survives restart. The
same model accepts an occurrence's prior `recurrenceDate` as `scheduledOn` for a
typed TaskDO write and advances only when it still matches the stored cursor. A
repeated or stale write returns current state without advancing again.

Recurring Undo carries the full pre-completion Task snapshot. It conditionally
restores that snapshot only while the server cursor still matches the expected
post-completion cursor. The revive path covers an exhausted series whose row was
reconciled out of the open working set; an in-place update covers an ordinary
advance whose row remained open.

## Replica durability

The current TinyBase workspace is durable local user state, not a disposable
cache. It retains complete merge metadata so offline changes can converge after
restart once it is bound. Recovery projection excludes invalid synchronized
rows from accepted views while retaining their raw intent until the user
chooses a safe repair.
