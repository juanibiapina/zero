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

The singular/plural pair is intentional; do not "fix" it back to "Inbox".

- **Capture** (singular) — the item (table `captures`, type `Capture`). Unchanged.
- **Captures** (plural) — the list/screen of un-processed Captures (UI title,
  route, empty-state copy). It is the Captures where `processedAt IS NULL`,
  oldest first. This term replaced the earlier "Inbox". It is now the **sole
  list** on both surfaces: the Today tab was removed from the UI (see
  `docs/entities/task.md` and `docs/todo-app.md`), so there is no tab switcher —
  the screen opens straight to Captures.
- **Process** — GTD Clarify: the action that removes a Capture from Captures
  (still stored). Column `processedAt`, RPC `processCapture`, log
  `capture_processed`.
- **Edit** — change a Capture's `text` in place. Same-key idempotent update on
  the stable `id` (no new row, no key swap), so a replayed offline edit just
  re-applies the same text. Store verb `editText`, RPC `editCapture`, log
  `capture_edited`. Only `text` changes; `createdAt`/`processedAt`/order are
  untouched.

The word "Inbox" is reserved for the unrelated Gmail label in the agent's email
tools; it never names this view.

## Data shape

`captures` table in the per-user `UserDO` (SQLite). Client-facing `Capture`:

- `id` — string id, a UUID the **client mints** and the server persists verbatim
  as the primary key (stable end to end, so the optimistic row never swaps keys,
  and it is the dedupe key: a replayed add re-sends the same id)
- `text` — the raw line
- `createdAt` — ISO timestamp
- `processedAt` — nullable ISO timestamp; `null` = still in Captures

## Behavior

- **Capture** a raw item into the flat Captures list (untyped, uncommitted). New
  Captures append at the bottom.
- **Process** a Capture: it leaves Captures (still stored). Today Process just
  removes it; later it could turn the Capture into a typed entity.
- **Edit** a Capture's text in place, on web and mobile: tap the row's text to
  edit inline; an empty or unchanged edit is a no-op. Optimistic and
  offline-durable like add/process.
- Ordering is oldest-first by `createdAt`. Hand-reordering (position = priority)
  is a vision, not yet built.

## Interactions (per system)

- **UI** — mobile Captures screen (`apps/agent-mobile`) and web `/captures`
  (`apps/agent-web`, unlinked route). Quick-add bar off a FAB; tap a row's circle
  to Process. NativeWind v4 + `@expo/ui` on mobile.
- **Storage** — the server domain store is `DbCaptureStore` (domain methods
  `add` / `list` = open Captures / `process` / `editText`). See `docs/storage.md`
  for how data is saved on both the server and the client.
- **API** — per-user isolated:
  - `GET /api/captures` → `{ captures }`, the open Captures oldest-first.
  - `POST /api/captures { id, text }` → `201 { capture }`; the client sends the
    UUID `id`, and the server dedupes on it (a replay re-sends the same id and
    gets the stored row back). `400` on empty text or a non-UUID id.
  - `POST /api/captures/{id}/process` → `200 { capture }`, or `404` when unknown.
  - `PATCH /api/captures/{id} { text }` → `200 { capture }`, `404` when unknown,
    `400` on empty text. PATCH (not a `POST …/edit` action) because editing text
    is a genuine idempotent field update on the capture's stable id.
- **Other entities** — **Task** is the first typed entity (see
  `docs/entities/task.md`). Processing a Capture into a Task (the Capture->Task
  transition, adding a `sourceCaptureId` on Task) is the next entity interaction
  to design; today Process just removes the Capture.

## Open questions

- What Process does beyond removing the Capture (today it just removes).
- List-view ordering semantics as Captures grows.
- Loading semantics: the Captures list region gates on the row count, not the
  collection's `isLoading`. The persisted collection hydrates the local snapshot
  into the live query before its network sync marks the collection ready, so
  `isLoading` stays true while rows already exist; gating on `isLoading` would
  hide a hydrated snapshot behind a spinner until the network answered. The
  shared `capturesView` helper in `@zero/agent-core` encodes the rule (rows whenever
  present; spinner only when empty and loading).

## Next

- Process a Capture into a **Task** (the Capture->Task transition; the richest
  data-model slice, not yet designed). See `docs/entities/task.md`.
- Recurring capture.
- Likely never (not used in Todoist today): subtasks, priorities, labels.

Note: the earlier "scheduled show-up date on a Capture + due-today view" idea is
superseded by the **Task** entity, which is that date done right (a Task carries
a `showUpDate` and feeds the Today view). Do not add a date to Capture.
