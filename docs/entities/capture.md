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
- **Postpone / reschedule** — set (or clear) a Capture's `showUpDate` on the
  stable `id`. A future date hides the Capture until that day; clearing it
  (`null`) makes it always visible again. Same-key idempotent update. Store verb
  `reschedule`, RPC `rescheduleCapture`, log `capture_rescheduled`. Swiping a row
  right (or the web "Tomorrow" button) postpones to the next day.
- **Reorder** — set a Capture's `sortKey` on the stable `id` to move it in the
  manual list order (position = priority). Same-key idempotent update. Store verb
  `reorder`, RPC `reorderCapture`, log `capture_reordered`. On mobile, long-press
  a row's text and drag it; on web, drag it by its grip handle (keyboard-
  reorderable too). `sortKey` is a fractional index (see Data shape / Ordering).
  Mobile activation note: the long-press is a plain RN `Pressable onLongPress`
  (JS), NOT a gesture-handler `Gesture.LongPress` — the library tracks the drag
  with one pan on the whole list, and a competing GH gesture in the row would
  block it (row lifts but never follows the finger).

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
- `showUpDate` — nullable local day `YYYY-MM-DD`; `null` = always visible, a
  non-null date hides the Capture until that day arrives (postpone)
- `sortKey` — nullable fractional-index string (base-62) for the manual list
  order; `null` means **unkeyed** and sorts **last** (newest-at-bottom). In
  practice every row is keyed — `add` mints a trailing key, reorder mints a key
  strictly between the drop position's two neighbors, and an init backfill keys
  legacy rows — so `null` is only a transient state: a legacy row before the
  backfill, or the client's optimistic just-added row before the server assigns
  its key on reconcile. The column is nullable by design (`ADD COLUMN` can't be
  `NOT NULL` on a populated table and a valid key can't be minted in SQL); the
  whole stack tolerates `null` (sorts last) rather than depending on its absence.
  See Ordering below.

## Behavior

- **Capture** a raw item into the flat Captures list (untyped, uncommitted). New
  Captures append at the bottom.
- **Process** a Capture: it leaves Captures (still stored). Today Process just
  removes it; later it could turn the Capture into a typed entity.
- **Edit** a Capture's text in place, on web and mobile: tap the row's text to
  edit inline; an empty or unchanged edit is a no-op. Optimistic and
  offline-durable like add/process.
- **Postpone** a Capture to the next day: swipe the row right on mobile, or click
  the "Tomorrow" button on web. It leaves the list at once and comes back on its
  day. Optimistic and offline-durable.
- **Visibility (client-side).** `GET /api/captures` returns **every** open
  Capture (`processedAt IS NULL`), future-dated rows included. The client owns
  the split against its own local day: **Captures** shows the rows that have
  shown up (`showUpDate IS NULL OR showUpDate <= today`, via `visibleCaptures`),
  and **Upcoming** shows the future-dated rows grouped by day (`showUpDate >
  today`, via `upcomingSections`) — both in `@zero/agent-core`. A Capture belongs
  to exactly one of the two views. An overdue date rolls the Capture into today's
  Captures list silently — no red, Things-3 gentle overdue. The client owning the
  day keeps a just-postponed row leaving Captures instant and offline; there is no
  server-side filter to reconcile against.
- **Upcoming.** The complement of Captures: open, future-dated Captures grouped
  into day sections (Tomorrow and beyond), ordered within a day by the same
  manual `sortKey`. Surfaced as the second nav section (mobile Upcoming tab, web
  `/upcoming`). Postponing a Capture moves it out of Captures and into Upcoming's
  Tomorrow section. No calendar strip and no drag-reorder in this view.
- **Reorder** a Capture: drag it to a new position (long-press on mobile, grip
  handle on web). The new order persists, syncs across devices/Telegram, and is
  offline-durable. Optimistic like the other verbs.
- **Ordering.** The list orders by `sortKey` ascending, `createdAt` ascending as
  the tiebreak. `sortKey` is a **fractional index** (via `fractional-indexing`'s
  `generateKeyBetween`): to move a row between two neighbors the client mints one
  key strictly between their keys — an O(1) write that touches only the moved
  row, never a renumber. Keys are compared by **raw codepoint**, never
  `localeCompare` (which folds case and would corrupt the base-62 sequence); the
  server comparator (`DbCaptureStore.list`) and the client comparator
  (`visibleCaptures` / `compareByOrder` in `@zero/agent-core`) make the identical
  codepoint comparison **and both sort a `null` key last**, so they order
  identically and a stray/legacy unkeyed row (or the client's optimistic row)
  falls to the bottom instead of misordering. The two comparators are duplicated
  rather than shared (agent-api must not build-depend on the browser/RN
  `@zero/agent-core` package), so a change to the rule must touch both. The
  shared `orderKeyBetween` helper wraps the library behind one tested seam.
- **Sort-key backfill (code, not SQL).** Migration `0045` only adds the nullable
  `sortKey` column; valid fractional keys cannot be produced in SQL. A one-shot
  `DbCaptureStore.backfillSortKeys()` assigns sequential keys to any `sortKey IS
  NULL` row in `createdAt` order (so the legacy oldest-first order is preserved),
  called from the `UserDO` init block. It is idempotent: once every row has a
  key, a second run is a cheap empty select.

## Interactions (per system)

- **UI** — mobile Captures + Upcoming tabs (`apps/agent-mobile`) and web
  `/captures` + `/upcoming` (`apps/agent-web`, unlinked routes). Quick-add bar off
  a FAB; tap a row's circle to Process. Upcoming groups future-dated Captures by
  day. NativeWind v4 + `@expo/ui` on mobile.
- **Storage** — the server domain store is `DbCaptureStore` (domain methods
  `add` / `list` = all open Captures / `process` / `editText` / `reschedule` /
  `reorder` / `backfillSortKeys`). `add` mints the trailing `sortKey` (reads the
  current max, `generateKeyBetween(max, null)`). `list` returns every open
  Capture sorted by `sortKey` then `createdAt` (nulls last), with no visibility
  filter — the client splits the set into Captures and Upcoming. See
  `docs/storage.md` for how data is saved on both the server and the client.
- **API** — per-user isolated:
  - `GET /api/captures` → `{ captures }`, **every** open Capture in manual order
    (future-dated included); the client splits them into Captures and Upcoming.
  - `POST /api/captures { id, text }` → `201 { capture }`; the client sends the
    UUID `id`, and the server dedupes on it (a replay re-sends the same id and
    gets the stored row back). `400` on empty text or a non-UUID id.
  - `POST /api/captures/{id}/process` → `200 { capture }`, or `404` when unknown.
  - `PATCH /api/captures/{id} { text?, showUpDate?, sortKey? }` → `200 { capture }`,
    `404` when unknown, `400` on empty text, a malformed date, an empty sort key,
    or a body with no field. One partial update carries **edit** (`text`),
    **reschedule** (`showUpDate`, nullable to clear), and **reorder** (`sortKey`);
    PATCH (not a `POST …/edit` action) because each is a genuine idempotent field
    update on the capture's stable id. In practice each PATCH carries exactly one
    intent (reorder is sent alone).
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
  shared `listView` helper in `@zero/agent-core` encodes the rule (rows whenever
  present; spinner only when empty and loading).

## Next

- Process a Capture into a **Task** (the Capture->Task transition; the richest
  data-model slice, not yet designed). See `docs/entities/task.md`.
- Recurring capture.
- Likely never (not used in Todoist today): subtasks, priorities, labels.

Note: Capture now **owns** a `showUpDate` (postpone). This reverses the earlier
rule "Do not add a date to Capture", which held only while the parked **Task**
entity owned the date and fed a separate Today view. Task left the UI (see
`docs/entities/task.md` and `docs/todo-app.md`), so the single Captures list folds
the scheduling behavior back in. It also reverses Task's "the DO has no timezone /
the date filter is client-side" approach: Captures filters **server-side**, with
the DO deriving the user's local day from their timezone, and the client keeping
only a thin optimistic hide.
