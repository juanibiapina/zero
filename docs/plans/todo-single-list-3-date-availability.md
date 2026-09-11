# Plan 3 — Date-aware availability and derived "waiting until"

Part 3 of the `todo-single-list` series (see `todo-single-list-overview.md`).
Depends on plan 1 (the merge). Self-contained.

## Goal

Make a project's derived status **date-aware**, so postponing a project task has
the right consequences and its round trip closes with no manual steps and no
stored bookkeeping. Specifically:

- A project is `active` only when it has a **shown-up, taken-on** open task. A
  future-dated taken-on task no longer keeps the project active.
- "Waiting until a day" is **derived** from the soonest future-dated taken-on
  task — no `waiting_conditions` row, no auto-resolve write.

After plan 1, `projectDisplayStatus` ignores dates: a taken-on task keeps its
project `active` even when postponed to next year. Plan 3 fixes that.

## The rule (end state)

`takenOnAt` and `showUpDate` are orthogonal and both persist; postpone never
touches `takenOnAt` (established in plan 1). Plan 3 adds the date to the
derivation:

- **Project base `active`** = has an open task with `takenOnAt` set **and**
  shown-up (`showUpDate == null || <= today`). (Today it omits the shown-up
  clause.)
- **Home** (project task) = open ∧ shown-up ∧ taken-on ∧ project displays
  `active`. The shown-up clause already gates plan 1's Home; plan 3 makes the same
  clause gate `active` so the two never disagree.
- **Waiting until `<day>`:** when a project is not `active` and not otherwise
  waiting (no open condition), but holds a future-dated **taken-on** open task,
  it derives **waiting**, and the day it waits until is the soonest such task's
  `showUpDate`. Purely derived from the tasks — completing or re-postponing that
  task changes the derivation for free; the day arriving makes the task shown-up,
  which makes the project `active` again. No row is written or resolved.
- **Not-taken task whose date passed:** shown-up but not taken-on → not `active`,
  not a waiting-until driver → project derives **Next** (come groom it). It lives
  only on the project screen (it is on Home nowhere and has left Upcoming).

## Why derived, not a stored condition

The first framing was a `date`-kind `waiting_conditions` row auto-resolved on its
day. Plan 1 + this derivation make that redundant: the project status is already
computed from tasks, so the waiting reason and its date fall out of the tasks
themselves. A row would be duplicated state that desyncs when the task is
completed or re-postponed, and "which date" is ambiguous with several postponed
tasks. Keep `waiting_conditions` only for reasons that are **not** a task date
(the existing `free-text` / `task-done` / `project-status` kinds).

## Surfaces to change (mostly one pure module)

- **Shared (`packages/agent-core/src/projects/derive.ts`):** add the shown-up
  clause to `projectBaseStatus`'s taken-on test. Add a derived `waitingUntil`
  (soonest future-dated taken-on open task's `showUpDate`, or null) and make
  `projectDisplayStatus` return `waiting` when `waitingUntil` is set and nothing
  is active/otherwise-waiting. Keep the mutually-recursive `conditionSatisfied` /
  base-status structure intact (a `project-status` condition still compares base,
  ignoring waiting, to stay finite).
- **`homeTasks`:** fold the shown-up clause into the project-task gate so it agrees
  with the date-aware `active` (it already filters shown-up for plan 1's Home;
  here it reads the date-aware `projectDisplayStatus`).
- **`waitingSince` / Waiting-section ordering:** a project waiting *only* on a
  derived date has no condition row, so `waitingSince` must also consider
  `waitingUntil`'s basis (or a parallel "waiting since the postpone" instant) so
  the Projects list can label and order it. Decide the label: the badge reads the
  target day ("until Tue") for a date-derived wait, versus elapsed time ("3 days")
  for a condition — they are different phrasings; pick per kind.
- **Project screen Waiting-on section (web + mobile):** render the derived
  "Waiting until <day>" reason alongside real condition rows, tagged as automatic
  (no Resolve button; it clears when the day comes or the task moves). It is not a
  row, so it has no id/delete.

## Interaction with plan 1's interim

Plan 1 shipped a postponed *project* task leaving Home (shown-up gate) while its
project's `active` stayed stale (non-date-aware). Plan 3 removes that staleness:
the same postpone now also drops the project out of `active` and surfaces the
derived waiting-until. No migration or data change — this is derivation only.

## Test strategy

- **Shared (pure, direct):** `projectDisplayStatus` date-aware cases — taken-on
  shown-up → active; taken-on future → not active, derives waiting-until; not-taken
  shown-up → next; taken-on overdue → active again. `waitingUntil` picks the
  soonest of several future taken-on tasks and ignores not-taken ones. `homeTasks`
  agrees with the date-aware status. `waitingSince`/label for a date-only wait.
- **Clients:** project screen shows the derived waiting-until reason; Projects list
  labels/orders a date-only-waiting project. Web page tests + Pixel 7 device check
  (postpone a taken-on project task → it leaves Home, project shows "waiting until
  <day>", the day arrives → it returns to Home and the project is active).

## Documentation

- `docs/entities/waiting-condition.md`: add a "Derived date wait" note — a project
  can display waiting-until from a future-dated taken-on task with no stored
  condition; conditions remain for non-date reasons.
- `docs/entities/task.md` / `docs/entities/project.md`: the date-aware `active`
  rule and the two-paths model (curation vs scheduling-as-timing, not
  scheduling-as-activation).
- Changelog bullet (mobile + web): postponing a taken-on project task now shows
  the project as "waiting until <day>" and returns the task automatically on its
  day.

## Acceptance criteria

- A future-dated taken-on task does not keep its project `active`.
- A project holding only a future-dated taken-on task derives `waiting` with the
  correct target day; the day arriving returns the task to Home and the project to
  `active`, with no writes on either transition.
- A not-taken task whose date passed leaves the project `Next` and appears only on
  the project screen.
- No `date`-kind condition row is ever written.
- Shared unit tests + web page tests pass; mobile Pixel 7 device-verified.
</content>
