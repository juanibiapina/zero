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

A single line of work: `text`, an optional `showUpDate`, an optional normalized
`recurrence` plus its `recurrenceDate` cursor, a `completedAt` that flips when
done, an optional `projectId` (loose when null), a manual-order `sortKey`, and a
dormant `sourceCaptureId`. Minimal on purpose; no priority or subtasks. The show-up date is the **sole commitment gate** for a project task
(the former take-on/park star was retired — see
`docs/plans/todo-retire-take-on.md`).

## Vocabulary

- **Task** — the item (table `tasks`, type `Task`). A **loose task** has
  `projectId == null`; a **project task** belongs to a project.
- **Home** — the single list of tasks that are open, shown-up, and available (UI
  title). One flat list ordered by `sortKey`.
- **Upcoming** — open, future-dated tasks grouped by day; the complement of Home.
- **Show-up date** — `showUpDate`, the local `YYYY-MM-DD` a task should show up
  on, or `null` for a loose, always-relevant task. A future date parks the task
  in Upcoming; a past/today date is "shown up".
- **Recurrence** — versioned normalized date-only schedule JSON. `every` advances
  from the scheduled occurrence and catches up missed dates; `every!` advances
  from the local completion day. `recurrenceDate` is the current occurrence on
  the pattern, while `showUpDate` can differ after a one-off postpone.
- **Complete** — removes an ordinary task from the list. Completing a recurring
  task advances the same row and removes it only when its inclusive end is
  exhausted. Ordinary completion uses column `completedAt`, RPC `completeTask`, log `task_completed`; the inverse is
  `reopen` (`reopenTask`), which backs the Undo snackbar.
- **Edit** — change `text` in place. Store verb `editText`, RPC `editTask`, log
  `task_edited`.
- **Postpone / reschedule** — set (or clear, with `null`) `showUpDate`. Swiping a
  row right on mobile Home postpones it to local Tomorrow. Swiping right on a
  mobile project screen schedules it for local Today, including an undated
  groomed task; the web Home uses its "Tomorrow" button. Store verb `reschedule`,
  RPC `rescheduleTask`, log `task_rescheduled`.
- **Reorder** — set `sortKey` to move a task in the manual order. Long-press-drag
  works on mobile Home and within a project's screen; web uses a grip drag. Store
  verb `reorder`, RPC `reorderTask`, log `task_reordered`. `sortKey` is a
  fractional index (see Ordering).
- **Commit / groom** — a project task reaches Home by having a **date that has
  arrived**; giving it a date (Today) is the commitment, clearing the date keeps
  it groomed on the project screen. The mobile project screen's right swipe is
  the direct Today commitment gesture. There is no separate take-on/park verb —
  this is `reschedule` (set/clear `showUpDate`). This replaced the retired
  take-on/park star (`takenOnAt`, dropped in migration 0052).
- **Deleted with its project** — a task is not orphaned when its project is
  deleted: `DELETE /api/projects/{id}` cascades to every task with that
  `projectId` (open or completed), removing them in the same call
  (`DbTaskStore.deleteByProject`, orchestrated by `UserDO.deleteProject`). A loose
  task (`projectId == null`) is never touched by a project delete. See
  `docs/entities/project.md`.
- **Move to project** — set (or clear) `projectId` to file a loose task under a
  project (or send it back to loose). Store verb `setProject`, RPC
  `setTaskProject`, over `PATCH /api/tasks/{id} { projectId }` (uuid or `null`),
  log `task_moved`; collection verb `moveToProject`. This is the replacement for
  the clarify/process step the single-list merge removed. Filing a task into a
  project changes only `projectId` — the show-up date is the commitment gate, so
  a dated task stays dated (and on Home if arrived) and an undated one is groomed
  on the project screen. Reachable from the task detail's Project row on mobile
  (Home and Upcoming) and web (Home). On mobile, that row opens a title-filterable
  assignment picker; when the task has a project, a separate trailing arrow opens
  that project's screen directly. The arrow is omitted when editing from the
  owning project's screen.

## Data shape

`tasks` table in the per-user `UserDO` (SQLite). Client-facing `Task`:

- `id` — a UUID the **client mints** and the server persists verbatim as the
  primary key (stable end to end; the dedupe key for replayed adds).
- `text` — the line of work.
- `createdAt` — ISO timestamp.
- `showUpDate` — nullable local `YYYY-MM-DD`; `null` = loose/always-relevant.
- `recurrence` — nullable versioned normalized schedule JSON from
  `@zeroapps/recurrence`.
- `recurrenceDate` — nullable local date for the current pattern occurrence;
  non-null with `recurrence`, unchanged by one-off postpone.
- `completedAt` — nullable ISO timestamp; `null` = open.
- `projectId` — nullable; the project this task belongs to, else loose
  (migration 0047).
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
  project-screen add mints a parked task under that project. On parse-enabled
  task quick-adds, the active one-time or recurring schedule phrase appears on
  a colored background and is removed from the stored title. Tapping/clicking it
  keeps that phrase as ordinary title text and activates the previous schedule
  candidate in the same title; dismissing every candidate leaves the task
  unscheduled.
- **Complete** an ordinary task: it leaves the list at once and a single bottom
  **Undo** snackbar reopens it. For a Project Task, the same feedback names and
  links the Project and offers **Waiting for…**, which opens the shared Project
  add drawer on Waiting and identifies the destination without delaying
  completion. A recurring task instead advances the same row:
  scheduled recurrence can remain overdue for catch-up, while `every!` advances
  from the completion day. The row leaves only when the next date is future or
  the series is exhausted. The same single Undo restores the prior occurrence.
- **Home = open ∧ available**, where availability splits loose vs project on the
  date (the date is the sole commitment gate):
  - a **loose** task (projectId null) is available when shown-up: `showUpDate ==
    null` (always relevant) or `showUpDate <= today`. A null date keeps a loose
    task on Home.
  - a **project** task is available only when it has a date that has **arrived**
    (`showUpDate != null && showUpDate <= today`) and its Project is In-play.
    Manual Waiting and After never suppress deliberately dated work. A null date
    means the Task is **groomed** — Project screen only,
    never Home (the loose/project asymmetry on null). Postponing any task parks it
    in Upcoming and it returns to Home on its day. The rule lives in the pure
    `homeTasks` seam in `@zero/agent-core`.
- **The date is the commitment.** A project is `active` only for a **shown-up
  dated** open task; a task postponed to a future day does **not** keep its
  project active — it derives "waiting until <day>" instead, and the day it
  arrives (shown-up) makes the project active again with no write. An **undated**
  project task is groomed: it never reaches Home and leaves the project `next`
  (come groom / schedule one). This date-aware derivation lives in
  `projectDisplayStatus` / `waitingUntil` (see
  `docs/entities/project.md` and `docs/plans/todo-retire-take-on.md`).
- **Upcoming** = open ∧ future-dated (`showUpDate > today`), grouped by day, **no
  other gate** — every postponed task, loose or project, taken-on or not
  (`upcomingSections` in `@zero/agent-core`).
- **Edit / reschedule** through the rows or detail sheet. A mobile Home swipe
  postpones to Tomorrow; a mobile project-screen swipe schedules Today; the
  editor offers Today / Tomorrow / calendar / clear. Writes are optimistic and
  offline-durable.
- **Ordering.** The list orders by `sortKey` ascending, `createdAt` as the
  tiebreak. `sortKey` is a fractional index (`fractional-indexing`'s
  `generateKeyBetween`): moving a row mints one key strictly between its
  neighbors — O(1), touches only the moved row. Keys compare by **raw codepoint**,
  never `localeCompare`; the server comparator (`DbTaskStore.list`) and the client
  comparator (`compareByOrder` in `@zero/agent-core`) make the identical
  comparison and both sort `null` last. The two are duplicated (agent-api must not
  build-depend on the browser/RN package), so a rule change must touch both;
  `orderKeyBetween` wraps the library behind one tested seam. Home and each
  project screen are filtered slices of this same order; reordering in either
  writes the moved task's one global `sortKey`.
- **Sort-key backfill (code, not SQL).** Migration `0051` adds the nullable
  `sortKey`; valid fractional keys can't be produced in SQL. `DbTaskStore.
  backfillSortKeys()` keys any `sortKey IS NULL` row in `createdAt` order, called
  from the `UserDO` init block; idempotent.

## Interactions (per system)

- **UI** — mobile Home + Upcoming tabs and project screens
  (`apps/agent-mobile`), and web `/captures` (Home, path unchanged) + `/upcoming`
  (`apps/agent-web`). Home and project screens are reorderable on both surfaces:
  web uses a drag handle (also keyboard-operable), mobile uses long-press drag.
  A mobile Home row swipes right to Tomorrow; a mobile project row swipes right
  to Today. Both tap the circle to complete and the row to open the detail sheet.
  Home quick-add opens
  on Task and can switch to Project; the mobile Projects-list Add drawer opens on
  Project and can switch to Task.
- **Storage** — the server domain store is `DbTaskStore` (`add` mints the trailing
  `sortKey`; `list` = every open task in manual order, no visibility filter — the
  client splits Home/Upcoming; `complete` / `reopen` / `editText` /
  `reschedule` / `reorder` / `setProject` / `deleteByProject` (the project-delete
  cascade) / `backfillSortKeys`). See `docs/storage.md`.
- **API** — per-user isolated:
  - `GET /api/tasks` → `{ tasks }`, every open task in manual order (future-dated
    included); the client splits Home and Upcoming.
  - `POST /api/tasks { id, text, showUpDate?, projectId?, sourceCaptureId? }`
    → `201 { task }`; `showUpDate` optional (a loose task omits it). The server
    dedupes on the client `id`. `400` on empty text or a non-UUID id.
  - `POST /api/tasks/{id}/complete` and `/reopen` → `200 { task }`, `404` unknown.
  - `PATCH /api/tasks/{id} { text?, showUpDate?, sortKey?, projectId? }`
    → `200 { task }`, `404` unknown, `400` on empty text / malformed date /
    non-UUID projectId / no field. One partial update carries edit, reschedule,
    reorder, and move-to-project; in practice each PATCH carries one intent.
    `projectId` accepts a uuid or `null` (clear to loose).
  - Logs `task_added` / `task_completed` / `task_reopened` / `task_edited` /
    `task_rescheduled` / `task_reordered` / `task_moved`.
- **Data layer** — a TanStack DB collection (`createTasksApi` in
  `@zero/agent-core`); the update verbs are told apart by their changed field set
  (sortKey → reorder, showUpDate → reschedule, completedAt → complete, projectId →
  move-to-project, else → edit), and reopen is a `revive` verb (re-inserts an
  evicted row). See `docs/storage.md`.
- **Timezone lives on the client.** The server returns every open task; the
  client splits Home/Upcoming against its own local today (`localToday` in
  `@zero/agent-core`), so the DO needs no timezone.
- **Shared view rule.** The list region gates on the row count, not `isLoading`,
  via the shared `listView` helper, so a hydrated local snapshot paints before the
  network sync marks the collection ready.

## Next

- **Refine returns** over all tasks (the dormant `sourceCaptureId`).
- **Agent `create_task` tool**, recurring tasks.
- Likely never (not used in Todoist today): subtasks, priorities, labels.
