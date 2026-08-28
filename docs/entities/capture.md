# Capture

The foundational entity and the app's entry point: one fast place to drop any raw
thought and Process it later.

Each entity documents how it plugs into every system of the app (the
Minecraft-block philosophy). This file is the source of truth for Capture; keep
it current as the entity grows.

## What it is

A single raw line of text: a thought, task, idea, a book someone mentioned,
anything. Deliberately UNTYPED and uncommitted — no Project, no type, no priority
at capture time.

## Vocabulary

- **Capture** — the item (table `captures`, type `Capture`).
- **Inbox** — the list of un-processed Captures (UI title, empty-state copy). The
  Inbox is the Captures where `processedAt IS NULL`, oldest first.
- **Process** — GTD Clarify: the action that removes a Capture from the Inbox
  (still stored). Column `processedAt`, RPC `processCapture`, log
  `capture_processed`.

## Data shape

`captures` table in the per-user `UserDO` (SQLite). Client-facing `Capture`:

- `id` — string id, a UUID the **client mints** and the server persists verbatim
  as the primary key (stable end to end, so the optimistic row never swaps keys,
  and it is the dedupe key: a replayed add re-sends the same id)
- `text` — the raw line
- `createdAt` — ISO timestamp
- `processedAt` — nullable ISO timestamp; `null` = still in the Inbox

## Behavior

- **Capture** a raw item into the flat Inbox (untyped, uncommitted). New Captures
  append at the bottom.
- **Process** a Capture: it leaves the Inbox (still stored). Today Process just
  removes it; later it could turn the Capture into a typed entity.
- Ordering is oldest-first by `createdAt`. Hand-reordering (position = priority)
  is a vision, not yet built.

## Interactions (per system)

- **UI** — mobile Inbox screen (`apps/agent-mobile`) and web `/inbox`
  (`apps/agent-web`, unlinked route). Quick-add bar off a FAB; tap a row's circle
  to Process. NativeWind v4 + `@expo/ui` on mobile.
- **Storage** — the `captures` table lives in the existing per-user `UserDO`, not
  a separate worker or DO. do-orm plus a per-entity `DbCaptureStore` (domain
  methods `add` / `list` = open Inbox / `process`), never a generic CRUD bag.
- **API** — per-user isolated:
  - `GET /api/captures` → `{ captures }`, the open Inbox oldest-first.
  - `POST /api/captures { id, text }` → `201 { capture }`; the client sends the
    UUID `id`, and the server dedupes on it (a replay re-sends the same id and
    gets the stored row back). `400` on empty text or a non-UUID id.
  - `POST /api/captures/{id}/process` → `200 { capture }`, or `404` when unknown.
- **Data layer** — a TanStack DB collection persisted to SQLite/OPFS (web) and
  op-sqlite (mobile) for offline reads, with an offline outbox for writes that
  retries on reconnect. See `docs/plans/todo-tanstack-db.md`.
- **Other entities** — none yet. Processing a Capture into a typed entity (Todo,
  …) is the next entity interaction to design.

## Open questions

- What Process does beyond removing the Capture (today it just removes).
- List-view ordering semantics as the Inbox grows.
- Loading semantics: the Inbox list region gates on the row count, not the
  collection's `isLoading`. The persisted collection hydrates the local snapshot
  into the live query before its network sync marks the collection ready, so
  `isLoading` stays true while rows already exist; gating on `isLoading` would
  hide a hydrated snapshot behind a spinner until the network answered. The
  shared `inboxView` helper in `@zero/agent-core` encodes the rule (rows whenever
  present; spinner only when empty and loading).

## Next

- Process into typed entities (the richest data-model slice; not yet designed).
- A scheduled show-up date on a Capture + a "due today" view.
- Recurring capture.
- Likely never (not used in Todoist today): subtasks, priorities, labels.
