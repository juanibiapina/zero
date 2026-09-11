# Task

The single entity of the todo app and its entry point. A Task is one line of
work: the loose thing you jot down, and the committed next-action under a
project. After the **single-list merge** (`docs/plans/todo-single-list-1-merge.md`)
Task absorbed the former Capture entity, so there is no separate capture inbox or
Process step — a quick-add with no project creates a **loose task**.

Each entity documents how it plugs into every system of the app (the
Minecraft-block philosophy). This file is the source of truth for Task; keep it
current as the entity grows.

## History (why the merge)

Capture and Task began as structural siblings: a raw untyped Capture you Process
out of an inbox, and a typed dated Task you Complete. The split's one payoff was a
clean `addTask` for many producers; its cost was two lifecycles, two lists, and a
Refine bridge. The Capture/Task split proved premature (the user worked in one
list), so Task now **is** the one list: it owns the nullable date, the manual
drag-reorder, and the Home/Upcoming visibility split that Capture used to own.
Capture data was disposable and dropped; task data was preserved (migration
0051). See `docs/entities/capture.md` (tombstone) and the merge plan.

## What it is

A single line of work: `text`, an optional `showUpDate`, a `completedAt` that
flips when done, an optional `projectId` (loose when null), a `takenOnAt`
curation stamp, a manual-order `sortKey`, and a dormant `sourceCaptureId`.
Minimal on purpose; no priority or subtasks.

## Vocabulary

- **Task** — the item (table `tasks`, type `Task`). A **loose task** has
  `projectId == null`; a **project task** belongs to a project.
- **Home** — the single list of tasks that are open, shown-up, and available (UI
  title). One flat list ordered by `sortKey`.
- **Upcoming** — open, future-dated tasks grouped by day; the complement of Home.
- **Show-up date** — `showUpDate`, the local `YYYY-MM-DD` a task should show up
  on, or `null` for a loose, always-relevant task. A future date parks the task
  in Upcoming; a past/today date is "shown up".
- **Complete** — removes a task from the list (still stored). Column
  `completedAt`, RPC `completeTask`, log `task_completed`; the inverse is
  `reopen` (`reopenTask`), which backs the Undo snackbar.
- **Edit** — change `text` in place. Store verb `editText`, RPC `editTask`, log
  `task_edited`.
- **Postpone / reschedule** — set (or clear, with `null`) `showUpDate`. Swiping a
  row right on mobile (or the web "Tomorrow" button) postpones one day. Store verb
  `reschedule`, RPC `rescheduleTask`, log `task_rescheduled`.
- **Reorder** — set `sortKey` to move a task in the manual order. Long-press-drag
  on mobile, grip-drag on web. Store verb `reorder`, RPC `reorderTask`, log
  `task_reordered`. `sortKey` is a fractional index (see Ordering).
- **Take on / park** — curate a project task onto Home. Column `takenOnAt`, verbs
  `takeOn` / `park` over `PATCH /api/tasks/{id} { takenOnAt }`.
- **Move to project** — set (or clear) `projectId` to file a loose task under a
  project (or send it back to loose). Store verb `setProject`, RPC
  `setTaskProject`, over `PATCH /api/tasks/{id} { projectId }` (uuid or `null`),
  log `task_moved`; collection verb `moveToProject`. This is the replacement for
  the clarify/process step the single-list merge removed. **Moving into a project
  clears `takenOnAt`** (a loose task is always on Home, but a project task must
  obey the project's curation gate, so filing it parks it); **moving back to loose
  leaves `takenOnAt` untouched** (a loose task ignores it). Reachable from the
  task detail's Project row on mobile (Home and Upcoming) and web (Home).

## Data shape

`tasks` table in the per-user `UserDO` (SQLite). Client-facing `Task`:

- `id` — a UUID the **client mints** and the server persists verbatim as the
  primary key (stable end to end; the dedupe key for replayed adds).
- `text` — the line of work.
- `createdAt` — ISO timestamp.
- `showUpDate` — nullable local `YYYY-MM-DD`; `null` = loose/always-relevant.
- `completedAt` — nullable ISO timestamp; `null` = open.
- `projectId` — nullable; the project this task belongs to, else loose
  (migration 0047).
- `takenOnAt` — nullable ISO timestamp; when the user took a project task onto
  Home (migration 0048). Only gates project tasks; a loose task always shows.
- `sourceCaptureId` — nullable; **dormant** provenance kept for a future Refine
  (migration 0050).
- `sortKey` — nullable fractional-index string (base-62) for the manual order;
  `null` sorts **last** (newest-at-bottom). Keyed in practice — `add` mints a
  trailing key, `reorder` mints one between neighbors, and a DO-init backfill keys
  legacy rows — so `null` is only transient. See Ordering.

The partial index `tasks_open` on `("createdAt")` `WHERE "completedAt" IS NULL`
serves the open-tasks query.

## Behavior

- **Add** a task. A quick-add with no project mints a loose task (no day); a
  project-screen add mints a parked task under that project.
- **Complete** a task: it leaves the list at once and a single bottom **Undo**
  snackbar (shared `'undo'` toast id — only one on screen) reopens it. A project
  task's snackbar also names the project and offers an Open deep-link.
- **Home = open ∧ shown-up ∧ available.** Shown-up is `showUpDate == null ||
  showUpDate <= today`; available is loose (always) or a project task that is
  taken-on and whose project displays `active`. Date-visibility is checked before
  availability, so postponing any task (even taken-on) parks it in Upcoming, and
  it returns to Home on its day with no re-take step. The rule lives in the pure
  `homeTasks` seam in `@zero/agent-core`.
- **Upcoming** = open ∧ future-dated (`showUpDate > today`), grouped by day, **no
  other gate** — every postponed task, loose or project, taken-on or not
  (`upcomingSections` in `@zero/agent-core`).
- **Edit / postpone / reschedule** from the row (swipe, grip) or the detail sheet
  (editable title + a Today / Tomorrow / calendar / clear scheduler). Optimistic
  and offline-durable.
- **Ordering.** The list orders by `sortKey` ascending, `createdAt` as the
  tiebreak. `sortKey` is a fractional index (`fractional-indexing`'s
  `generateKeyBetween`): moving a row mints one key strictly between its
  neighbors — O(1), touches only the moved row. Keys compare by **raw codepoint**,
  never `localeCompare`; the server comparator (`DbTaskStore.list`) and the client
  comparator (`compareByOrder` in `@zero/agent-core`) make the identical
  comparison and both sort `null` last. The two are duplicated (agent-api must not
  build-depend on the browser/RN package), so a rule change must touch both;
  `orderKeyBetween` wraps the library behind one tested seam.
- **Sort-key backfill (code, not SQL).** Migration `0051` adds the nullable
  `sortKey`; valid fractional keys can't be produced in SQL. `DbTaskStore.
  backfillSortKeys()` keys any `sortKey IS NULL` row in `createdAt` order, called
  from the `UserDO` init block; idempotent.

## Interactions (per system)

- **UI** — mobile Home + Upcoming tabs (`apps/agent-mobile`) and web `/captures`
  (Home, path unchanged) + `/upcoming` (`apps/agent-web`). Home is one
  reorderable list; tap a row's circle to complete, its text to open the detail
  sheet. Quick-add adds a task by default and can switch to a project.
- **Storage** — the server domain store is `DbTaskStore` (`add` mints the trailing
  `sortKey`; `list` = every open task in manual order, no visibility filter — the
  client splits Home/Upcoming; `complete` / `reopen` / `setTakenOn` / `editText` /
  `reschedule` / `reorder` / `setProject` / `backfillSortKeys`). See
  `docs/storage.md`.
- **API** — per-user isolated:
  - `GET /api/tasks` → `{ tasks }`, every open task in manual order (future-dated
    included); the client splits Home and Upcoming.
  - `POST /api/tasks { id, text, showUpDate?, projectId?, takenOnAt?, sourceCaptureId? }`
    → `201 { task }`; `showUpDate` optional (a loose task omits it). The server
    dedupes on the client `id`. `400` on empty text or a non-UUID id.
  - `POST /api/tasks/{id}/complete` and `/reopen` → `200 { task }`, `404` unknown.
  - `PATCH /api/tasks/{id} { text?, showUpDate?, sortKey?, takenOnAt?, projectId? }`
    → `200 { task }`, `404` unknown, `400` on empty text / malformed date /
    non-UUID projectId / no field. One partial update carries edit, reschedule,
    reorder, take-on, and move-to-project; in practice each PATCH carries one
    intent. `projectId` accepts a uuid or `null` (clear to loose); moving into a
    project clears `takenOnAt` server-side.
  - Logs `task_added` / `task_completed` / `task_reopened` / `task_edited` /
    `task_rescheduled` / `task_reordered` / `task_taken_on` / `task_moved`.
- **Data layer** — a TanStack DB collection (`createTasksApi` in
  `@zero/agent-core`); the update verbs are told apart by their changed field set
  (sortKey → reorder, showUpDate → reschedule, completedAt → complete, projectId →
  move-to-project [before take-on, since a move also clears takenOnAt], takenOnAt →
  take-on, else → edit), and reopen is a `revive` verb (re-inserts an evicted
  row). See `docs/storage.md`.
- **Timezone lives on the client.** The server returns every open task; the
  client splits Home/Upcoming against its own local today (`localToday` in
  `@zero/agent-core`), so the DO needs no timezone.
- **Shared view rule.** The list region gates on the row count, not `isLoading`,
  via the shared `listView` helper, so a hydrated local snapshot paints before the
  network sync marks the collection ready.

## Next

- **Date-aware project status** — postponing a taken-on project task drops its
  project out of `active` and derives "waiting until <day>"
  (`docs/plans/todo-single-list-3-date-availability.md`).
- **Refine returns** over all tasks (the dormant `sourceCaptureId`).
- **Agent `create_task` tool**, recurring tasks.
- Likely never (not used in Todoist today): subtasks, priorities, labels.
