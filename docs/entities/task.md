# Task

The first typed entity, and the thing you commit to doing. A Task is a clarified
next-action with a day, distinct from a Capture (a raw, untyped thought). Capture
is the entry point; Task is what a clarified Capture, or any producer, turns into.

Each entity documents how it plugs into every system of the app (the
Minecraft-block philosophy). This file is the source of truth for Task; keep it
current as the entity grows.

## Why Task is its own entity (not a dated Capture)

Capture has one producer (a fast human drop) and one consumer (later clarify). A
dated Capture would hide the intent and erode Capture's untyped, uncommitted
nature. Task has many producers, present and planned: the user, and later the AI,
the email workflow, a Project, a recurring rule, a schedule. That producer set
needs a clean `addTask` verb, which is why Task earns entity status rather than
being a column on Capture. Two verbs, two timestamps: Capture gets `processedAt`
(clarified out of the Inbox); Task gets `completedAt` (done). Do not conflate
them.

The name is `Task`, not the wiki's earlier "Todo" (which collides with the app
name).

## Status: parked (removed from the UI)

Task is **dormant**. The Capture/Task split proved premature — the user works in
one list (Todoist-style) and never adopted the separate Today tab. The Today tab
was removed from both web and mobile; the app is one Captures list again. All
Task machinery below stays in the tree, unreferenced by any UI: the `tasks`
table + migration, `DbTaskStore`, `/api/tasks`, the `@zero/agent-core` Task data
layer (`createTasksApi`, `todayView`, `dueToday`, `localToday`), and both
`tasks-collection.ts`. Nothing is deleted, so re-enabling Task once Projects and
the agent exist should be roughly a one-screen change. The scheduling behavior a
single list still wants (postpone to a day, reorder) is being folded into
Capture instead — see `docs/todo-app.md`. The rest of this file describes Task as
built, for when it returns.

## What it is

A single clarified next-action with a day it should show up: `text`, a
`showUpDate`, and a `completedAt` that flips when it is done. Minimal on purpose;
it does not carry a Project, a priority, or subtasks.

## Vocabulary

- **Task** — the item (table `tasks`, type `Task`).
- **Today** — the list of open Tasks due on or before the local today (UI title,
  empty-state copy). Overdue Tasks roll into Today; future-dated Tasks stay
  hidden until their day.
- **Show-up date** — `showUpDate`, the local `YYYY-MM-DD` day a Task should
  appear in Today. v1 always sets it to today at creation.
- **Complete** — the action that removes a Task from Today (still stored). Column
  `completedAt`, RPC `completeTask`, log `task_completed`.

## Data shape

`tasks` table in the per-user `UserDO` (SQLite). Client-facing `Task`:

- `id` — string id, a UUID the **client mints** and the server persists verbatim
  as the primary key (stable end to end, so the optimistic row never swaps keys,
  and it is the dedupe key: a replayed add re-sends the same id)
- `text` — the action
- `createdAt` — ISO timestamp
- `showUpDate` — local `YYYY-MM-DD` string, minted by the client (see Timezone
  below)
- `completedAt` — nullable ISO timestamp; `null` = still open

The partial index `tasks_today` on `("showUpDate")` `WHERE "completedAt" IS NULL`
serves the open-tasks query (mirrors `captures_inbox`).

### Deferred columns

`projectId` and `sourceCaptureId` are deliberately **not** columns yet. They
arrive with the Project entity and the Capture->Task transition respectively; no
speculative columns before their behavior is designed.

## Behavior

- **Add** a Task. v1 always dates it today, so it appears in Today immediately.
  New Tasks append (ordered by day, then creation).
- **Complete** a Task: it leaves Today (still stored). `completedAt` flips.
- **Today** shows open Tasks with `showUpDate <= localToday`. Overdue rolls in,
  future stays hidden, completed is excluded.

## Interactions (per system)

- **UI** — web `/inbox` (`apps/agent-web`) and the mobile home screen
  (`apps/agent-mobile`) both gained an **Inbox | Today** segmented control. The
  active segment is the entry target: the quick-add mints a Capture on Inbox and
  a Task dated today on Today. Same bar, same speed; the intent is the segment
  you are in. Tap a row's circle to Complete.
- **Storage** — the server domain store is `DbTaskStore` (domain methods
  `add` / `list` = open tasks / `complete`), a sibling of `DbCaptureStore`; the
  duplication is deliberate (Rule of Three: extract a shared base at entity #3).
  See `docs/storage.md` for how data is saved on both the server and the client.
- **API** — per-user isolated:
  - `GET /api/tasks` → `{ tasks }`, all open Tasks (`completedAt IS NULL`),
    oldest-first. No date filter server-side.
  - `POST /api/tasks { id, text, showUpDate }` → `201 { task }`; the client sends
    the UUID `id`, and the server dedupes on it (a replay re-sends the same id and
    gets the stored row back). `400` on empty text, a non-UUID id, or a bad date.
  - `POST /api/tasks/{id}/complete` → `200 { task }`, or `404` when unknown.
  - Logs `task_added` / `task_completed` (mirror `capture_added` /
    `capture_processed`).
- **Data layer** — a TanStack DB collection (`createTasksApi` in
  `@zero/agent-core`). See `docs/storage.md` for how data is saved on both the
  server and the client.
- **Timezone lives on the client.** The server returns every open Task; the
  client live query narrows to `showUpDate <= localToday` (`dueToday` +
  `localToday` in `@zero/agent-core`). This mirrors how the Inbox filters
  `processedAt`, sidesteps the DO having no timezone, and makes "future-dated
  hidden until their day" and "overdue rolls into Today" fall out for free.
- **Other entities** — none wired yet. The Capture->Task transition (Process a
  Capture into a Task) and Project membership are the next interactions to
  design; see Next.

## Shared view rule

The Today list region gates on the row count, not the collection's `isLoading`,
via the shared `todayView` helper in `@zero/agent-core` (same rule as
`inboxView`: rows whenever present; the spinner only when empty and loading). The
persisted collection hydrates the local snapshot before the network sync marks
the collection ready, so gating on `isLoading` would hide a hydrated snapshot
behind a spinner until the network answered.

## Next

- **Capture → Task** — Process a Capture into a Task (adds `sourceCaptureId`).
  The richest data-model slice; supersedes the earlier "scheduled show-up date on
  a Capture" idea (Task is that date, done right).
- **Reschedule** — swipe-to-tomorrow, pick a future date. v1 has no way to change
  `showUpDate` after creation.
- **Project membership** — a Task belongs to a Project (adds `projectId`).
- **Agent `create_task` tool** — let the AI add a Task.
- **Recurring Tasks** — a rule that mints Tasks on a cadence.
- Likely never (not used in Todoist today): subtasks, priorities, labels.
