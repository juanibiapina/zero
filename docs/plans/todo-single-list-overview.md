# One list: collapse Capture into Task (plan series)

## Goal

Make **Task** the single entity and entry point of the todo app. Delete
**Capture**. A quick capture becomes a loose open Task (no project). The app is
one reorderable list of tasks (Home), a future-dated complement (Upcoming), and
Projects — no separate Captures/Inbox, no `process`, no Refine.

This is the index for a three-plan series. Build them in order; each has its own
self-contained plan file.

1. [The merge](https://github.com/juanibiapina/zero/blob/ef8a3dbabe915964907d2dbeb7b6671444d3b322/docs/plans/todo-single-list-1-merge.md) — delete Capture; Task absorbs
   the date + manual reorder + the Captures/Upcoming visibility split, one flat
   Home list, Refine removed. Loose-task postpone works end to end.
2. [Move a loose task to a Project](https://github.com/juanibiapina/zero/blob/ef8a3dbabe915964907d2dbeb7b6671444d3b322/docs/plans/todo-single-list-2-move-to-project.md).
   The replacement for the clarify step the merge removes.
3. [Date-aware availability](https://github.com/juanibiapina/zero/blob/ef8a3dbabe915964907d2dbeb7b6671444d3b322/docs/plans/todo-single-list-3-date-availability.md). A
   project's `active`/`waiting` derivation becomes date-aware, and "waiting until
   a day" is derived (no stored condition), so a postponed project task's round
   trip closes automatically.

## The settled model (applies across the series)

These rules were resolved by design review and are the target end state. Plan 1
ships the parts that do not need date-aware project status; plan 3 finishes it.

- **Two orthogonal, persistent fields on a task:**
  - `takenOnAt` — "I've committed to this" (durable intent; a star). Postpone
    never touches it.
  - `showUpDate` — "when it's relevant." `null` = always relevant; a future day
    parks the task in Upcoming; a past/today day is "shown up."
- **One `sortKey`**, minted trailing at **creation**, shared by the project's
  task list and Home — both are filtered slices of one total order. Reordering in
  either view re-keys the task once; the other view reflects it. Accepted side
  effect: reordering two visible Home tasks can silently reposition a *parked*
  sibling within its own project (benign).
- **Home** = open **and** shown-up (`showUpDate == null || <= today`) **and**
  available. Available = loose (always), or a project task that is **taken-on**
  **and** its project displays `active`. One flat list ordered by `sortKey`.
- **Upcoming** = open **and** future-dated (`showUpDate > today`). **No other
  gate** — every postponed task is there, loose or project, taken-on or not,
  grouped by day.
- **A future date always parks a task in Upcoming, even a taken-on one.**
  Date-visibility is checked before availability; postpone changes relevance, not
  commitment. On the day it arrives, a still-taken-on task returns to Home with no
  re-take step — because the gate requires *shown-up*, not because any flag was
  cleared and restored.
- **Scheduling is not a second path onto Home.** Taken-on is the sole commitment
  gate for a project task; the date only decides *when* a taken-on task counts. A
  project task you dated but never starred does **not** appear on Home on its day.
- **Project `active`** = has a **shown-up, taken-on** open task. A future-dated
  taken-on task does not keep the project active (that is plan 3; plan 1 keeps the
  current non-date-aware `active`).
- **"Waiting until <day>"** is **derived** from the soonest future-dated
  **taken-on** task — no `waiting_conditions` row, no auto-resolve write. When the
  day arrives the task is shown-up and the derivation simply stops reporting
  waiting. (Plan 3.)
- **A not-taken task whose date has passed** is shown-up-but-not-taken: it is on
  Home nowhere and has left Upcoming, so it lives **only on the project screen**,
  and the project derives **Next** (in play, nothing taken-on, no open condition)
  so it surfaces to be groomed. (Plan 3 makes the derivation date-aware; plan 1's
  non-date-aware status is a temporary approximation.)

## Data directive

**Capture data is disposable; task data is not.** The merge drops the `captures`
table outright (no copy) and preserves every `tasks` row through a row-preserving
migration. See plan 1.

## Vocabulary retired

Drop **Capture / Captures / Inbox / Process** from UI and code. Home is your
tasks; the loose open tasks are simply the list. Keep **Upcoming**. Quick-add
loses its `capture` mode; `task` becomes the default
(`ALL_ADD_MODES = ["task", "project"]`).

## What the series deliberately excludes

- **Refine** (Capture → tasks/projects) — removed now; returns later over all
  tasks. Keep the dormant `sourceCaptureId` column.
- **Agent `create_task` tool** — the Telegram/interface agent does not touch these
  entities today (only prose uses of the word "capture" in
  `apps/agent-api/src/agents`), so the series needs no agent change.
- Recurring tasks, subtasks, priorities, labels.

## Skills to use

- `deep-modules` — folding two stores/collections/helpers into one; keep reorder a
  single tested helper (`orderKeyBetween`).
- `tdd` — store/route/helper changes, red-green at each interface.
- `git-commit` — when committing. `open-pr` — one PR per plan, in order.
</content>
