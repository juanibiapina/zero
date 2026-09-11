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

## Concrete interface change: thread `today` into the derivation

The derivation functions in `derive.ts` currently take **no `today`** — they are
date-blind: `projectDisplayStatus(project, tasks, conditions, projects)`,
`conditionSatisfied`, `unresolvedConditions`, `waitingSince`, and the private
`projectBaseStatus`. Making `active` date-aware means the derivation must know the
user's local day, so plan 3 adds a required `today: string` parameter to each of
these (matching `homeTasks`, which already takes `today`).

`today` stays an **explicit required argument**, never a `new Date()` computed
inside agent-core. The module is deliberately timezone-free (the client owns the
local day; the server stores YYYY-MM-DD verbatim), and a hidden clock would both
reintroduce that timezone and make the pure tests non-deterministic. Every call
site already has `localToday()` in hand.

Call sites to update (all pass `localToday()` / the screen's `today`):

- `packages/agent-core/src/tasks/home.ts` — `homeTasks` already has `today`; pass
  it through to `projectDisplayStatus`.
- `packages/agent-core/src/projects/call-to-action.ts` — `homeCallToAction` gains
  a `today` param and passes it down (date-waiting projects now count as Waiting
  in the CTA, which is correct).
- `apps/agent-web`: `ProjectsPage.tsx`, `ProjectDetailPage.tsx`, `HomePage.tsx`
  (CTA).
- `apps/agent-mobile`: `projects/index.tsx`, `projects/[id].tsx`, `index.tsx`
  (CTA).
- Their `.test` files: pass a fixed `today` and add the date-aware cases.

## Surfaces to change (mostly one pure module)

- **Shared (`packages/agent-core/src/projects/derive.ts`):** thread `today`
  through (above). Add the shown-up clause to `projectBaseStatus`'s taken-on test
  (`takenOnAt != null && (showUpDate == null || showUpDate <= today)`). Add a
  derived exported `waitingUntil(project, tasks, today)` — the soonest
  `showUpDate` among the project's open, taken-on, future-dated (`> today`) tasks,
  or null — and make `projectDisplayStatus` return `waiting` when `waitingUntil`
  is set and nothing is active/otherwise-waiting. Order inside
  `projectDisplayStatus`: `base !== 'next'` → base; else unresolved condition →
  `waiting`; else `waitingUntil != null` → `waiting`; else `next`. Keep the
  mutually-recursive `conditionSatisfied` / base-status structure intact (a
  `project-status` condition still compares base, ignoring waiting, to stay
  finite; base is now date-aware, which is consistent).
- **`homeTasks`:** already filters shown-up and reads
  `projectDisplayStatus === 'active'`; passing the now date-aware status keeps the
  two in agreement — a future-dated taken-on task is dropped by the shown-up
  filter *and* no longer makes its project active, so it cannot leak onto Home.
- **One shared waiting-badge seam (resolves the open label/order question).**
  Both the web and mobile Projects lists today duplicate the same three lines:
  group by `projectDisplayStatus`, sort the Waiting section by `waitingSince(p) ??
  createdAt`, and label it `waitingSince ? waitingLabel(since) : null`. A
  date-only wait has **no condition row**, so `waitingSince` returns null and both
  the label and the sort key would be wrong for it. Rather than re-branch this on
  each surface (shallow duplication), add one pure seam in `@zero/agent-core`,
  `waitingBadge(project, tasks, conditions, projects, today, now?)`, returning
  `{ label: string; sortKey: string } | null` (null when the project is not
  waiting). It owns both cases in one tested place:
  - **condition wait:** `label = waitingLabel(since)` (elapsed, e.g. "3 days"),
    `sortKey` orders longest-waited first.
  - **date wait:** `label = "until " + dayLabel(until, today)` (target day, e.g.
    "until Tue"), `sortKey` orders soonest-arriving first.
  A project is exactly one kind at a time (a condition wait wins if any condition
  is open; otherwise a date wait), so the two never collide on one row. `now` is
  injected (default `new Date()`) to keep the elapsed label deterministic in
  tests. Both surfaces then just render `badge.label` and sort by `badge.sortKey`,
  and `projectsByStatus`'s `sortKeyOf` becomes `waitingBadge(...)?.sortKey ??
  createdAt`. This retires the per-surface `labelOf`/`waitingSince(...) ??
  createdAt` idiom. (`waitingSince` stays exported and unchanged as the
  condition-instant primitive `waitingBadge` builds on.)
- **Project screen Waiting-on section (web + mobile):** render the derived
  "Waiting until <day>" reason (from `waitingUntil`) alongside real condition
  rows, tagged as automatic (no Resolve button, no delete/✕). It is **not** a
  stored row, so it has no id — render it as a synthetic leading item, shown only
  when `waitingUntil` is non-null, above the real condition list.

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

## Series closeout (whatever is left after plan 3)

Plan 3 is the last derivation slice; these are the remaining loose ends that
close the `todo-single-list` series. They are separable from the derivation and
can each be its own commit/PR.

- **Deploy + device-verify plans 1 and 2.** Both shipped in code but their
  tracking entries say **"Pixel 7 device verification is pending."** Plan 2's
  merge commit (`559e88bbe`, move-a-task-to-a-project) is **committed on `main`
  locally but not yet pushed** (`main` is ahead of origin by 1), so it is not
  deployed either. Push, let the Cloudflare build finish, then run the on-device
  pass for the merged single-list Home/Upcoming, postpone, drag-reorder, and
  move-to-project. Plan 3's own device check should cover the merged behaviors in
  the same session.
- **Move-to-project from web Upcoming (plan 2's one deferred gap).** Plan 2
  shipped move-to-project on mobile Home + Upcoming and web Home, but **web
  Upcoming has no task detail sheet**, so a web user cannot file a future-dated
  task under a project from Upcoming. Closing this means giving web Upcoming the
  same task-detail affordance Home has (the Project row + picker). UI only — the
  `projectId` field, store `setProject`, RPC, and `moveToProject` collection verb
  already exist. Small, and optional to bundle with plan 3.

## Out of scope

- **Refine (Capture → tasks/projects).** Removed by the merge; returns later over
  all tasks. The dormant `sourceCaptureId` column stays untouched. Not part of
  closing this series.
- **Reschedule-a-Task UX beyond postpone** (a full future-date picker from every
  surface) and **AI Capture → Project** — both are separate "Next" items in
  `docs/todo-app.md`, not series closeout.
- Recurring tasks, subtasks, priorities, labels.
</content>
