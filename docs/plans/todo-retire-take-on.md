# Retire take-on: the show-up date is the sole commitment gate

## Bottom line

Delete the take-on/park star (`takenOnAt`) and let a task's **show-up date**
carry everything it did. A project task reaches Home only when it has a date that
has arrived; committing a groomed task means dating it (today), not starring it.
This collapses the two orthogonal gates (star + date) the todo app carries today
into one dimension — the date — which is how Todoist already works and what the
single-list merge and date-aware availability were building toward. The change
spans a DB migration (drop the column), the server store/routes, three pure
`@zero/agent-core` seams, and both surfaces' UI, but the model gets *simpler*: one
commitment signal instead of two.

The work also **extends** the Home quick-add into a mini-composer (a date chip and
a project selector), because once the date is the gate the user must be able to
set it — and pick a project — at create time.

## Background (self-contained)

### The todo app today

The app is one list of `Task`s (the Todoist replacement). A `Task` has `text`,
`completedAt` (open when null), `showUpDate` (a local `YYYY-MM-DD`, or null =
loose/always-relevant), `projectId` (null = loose, else belongs to a Project),
`sortKey` (manual order), and **`takenOnAt`** (null = parked, a timestamp = taken
on). A **loose task** (`projectId == null`) is a quick capture; a **project task**
belongs to a Project.

**Home** is the single list, computed by the pure seam `homeTasks`
(`packages/agent-core/src/tasks/home.ts`): open ∧ shown-up ∧ *available*.
- shown-up = `showUpDate == null || showUpDate <= today`.
- available = loose (always) **or** a project task that is **taken-on** *and*
  whose project derives `active`.

**Upcoming** = open ∧ future-dated (`showUpDate > today`), grouped by day, no
other gate (`upcomingSections`).

A Project's display status is **derived** on the client by `projectDisplayStatus`
(`packages/agent-core/src/projects/derive.ts`), not read from the stored column
(only `backlog`/`done` are hand-set):
- `active` = has a **shown-up, taken-on**, open task (`projectBaseStatus` via
  `isShownUpTakenOnOpen`). This overrides an open waiting condition.
- `waiting` = in play, nothing shown-up-and-taken-on, and either an open waiting
  condition **or** a future-dated taken-on task (`waitingUntil` returns the
  soonest such day).
- `next` = in play, nothing taken on, no open condition, no future-dated taken-on
  task.

So **`takenOnAt` is the single commitment gate for project tasks**, orthogonal to
the date. Loose tasks never touch it. `homeCallToAction`
(`packages/agent-core/src/projects/call-to-action.ts`) reflects these derived
statuses in the Home empty state.

### Where the star lives (all references)

- **Schema/DB:** `takenOnAt TEXT` column on `tasks` (added migration `0048`,
  carried through the `0051` table rebuild).
- **Server:** `DbTaskStore.setTakenOn` and the `add` param (`apps/agent-api/src/store/tasks.ts`);
  `DbTaskStore.setProject` clears `takenOnAt` when filing into a project. Route
  `PATCH /api/tasks/{id}` handles `takenOnAt` and logs `task_taken_on`; `POST
  /api/tasks` accepts `takenOnAt` (`apps/agent-api/src/routes/tasks.ts`). `UserDO`
  exposes `setTaskTakenOn` (`apps/agent-api/src/UserDO/index.ts`).
- **Shared (`@zero/agent-core`):** the `Task` type field (`tasks/types.ts`); the
  collection verb `setTakenOn` + `takeOn`/`park` actions and the `addTask`
  insert's `takenOnAt` (`tasks/collection.ts`); `homeTasks` availability gate
  (`tasks/home.ts`); `isShownUpTakenOnOpen`, `projectBaseStatus`, `waitingUntil`
  (`projects/derive.ts`).
- **Web (`apps/agent-web`):** `lib/tasks.ts` REST (`setTaskTakenOn`); the star on
  Home rows (`pages/HomePage.tsx`) and the take-on/park toggle on the project
  screen (`pages/ProjectDetailPage.tsx`); tests in `HomePage.test.tsx`,
  `ProjectsPage.test.tsx`.
- **Mobile (`apps/agent-mobile`):** `lib/api.ts` + `lib/tasks-collection.ts`; the
  star on Home rows (`app/(signed-in)/index.tsx`) and the toggle on the project
  screen (`app/(signed-in)/projects/[id].tsx`); tests under `__tests__/`.

### Why now (the design was interviewed and settled)

The single-list merge (2026-09-12) made Task the one list and the date its native
axis; date-aware availability then made a future-dated task derive "waiting until
<day>" with no stored row. With the date system mature, the star became a second
way to say what a date already says. The full design was worked through and
these decisions are **locked**:

1. **The date is the gate.** A project task reaches Home only when
   `showUpDate <= today`; an undated project task lives only on the project
   screen (groomed).
2. **Date = commitment, everywhere.** A shown-up dated open task makes its project
   `active` (and overrides an open waiting condition). A future-dated open task
   drives "waiting until <day>" and appears in Upcoming. Only undated (groomed)
   tasks leave a project `next`. There is no "scheduled but not committed" state.
3. **Null-date asymmetry (confirmed):** a *loose* null-date task is always on Home
   (unchanged); a *project* null-date task is off Home (groomed). This is the one
   place loose and project tasks differ on null.
4. **Keep the backlog/done gate:** a task under a `backlog`/`done` project stays
   off Home even if dated today. Un-backlog the project to work it.
5. **Park = clear the date; take-on = set the date to today.** Both reuse the
   existing `reschedule` verb — no new verb, no `takenOnAt`.
6. **Home quick-add becomes a mini detail sheet:** an independent **project
   selector** and **full date chip** (reusing the detail scheduler). Defaults: no
   project, **null** date ⇒ a loose Home task. The chips are independent (not
   coupled). Filing to a project with no date lands it groomed and it leaves Home
   — softened by a "Filed to <project>" toast, never a silent vanish.
7. **Home date default = null** (a quick capture asserts no day until you say so;
   overdue styling does not exist, so a null vs today default differs only
   cosmetically, and null is the truer inbox default).
8. **Project screen commit affordance:** each row's star becomes a **date chip**
   ("No date" when groomed); tapping it opens the scheduler, and picking Today
   commits the task to Home and flips the project `active`.

### The create matrix (the model, made concrete)

| project | date | lands |
|---|---|---|
| none | null | loose → **Home** |
| none | Today | loose → **Home** |
| none | Friday | loose → **Upcoming** |
| picked | null | project task → **project screen only (leaves Home)** + toast |
| picked | Today | project task → **Home**, project `active` |
| picked | Friday | project task → **Upcoming**, "waiting until Fri" |

## Relationship to the existing parity plan

`docs/plans/todo-project-task-row-parity.md` (untracked, not yet built) **locks**
in its Decision A that the project-screen row keeps the take-on/park star. This
plan **reverses that**: the star is deleted and the project-screen row's trailing
control becomes a **date chip**. If the parity work has not shipped, fold its
row-extraction ideas in here (a shared row whose trailing slot is the date chip);
if it ships first, this plan removes the star it added. Either way, only one of
the two "trailing control" designs can exist — this plan's date chip wins.

## What to change and why

### 1. Migration `0052` — drop `takenOnAt`, backfill preserved rows

A new migration `apps/agent-api/src/UserDO/db/migrations/0052_drop_taken_on.sql`,
registered in `migrations.ts` (import `m0052`, add to the `migrations` object).
Mirror the `0051` table-rebuild pattern (SQLite can't drop a column's role
cleanly in place, and rebuild is the established idiom here):

- Create `tasks_new` **without** `takenOnAt`.
- `INSERT ... SELECT` every row, applying the backfill in the projection:
  `showUpDate = CASE WHEN "showUpDate" IS NULL AND "takenOnAt" IS NOT NULL THEN
  date("takenOnAt") ELSE "showUpDate" END`. This keeps every previously-on-Home
  taken-on-but-undated project task on Home (a past date is `<= today`, so
  shown-up). **Zero rows match today** (the user has no taken-on tasks), but the
  clause is correct-by-construction and immune to the race where a task is taken
  on in the window before deploy.
- Drop `tasks`, rename `tasks_new` → `tasks`, recreate the `tasks_open` partial
  index.

State the backfill and the column drop loudly in the SQL header comment, as
`0051` does.

### 2. Server: `DbTaskStore`, routes, `UserDO`

- Remove `takenOnAt` from the `Task` interface, `toTask`, `add`'s params, and the
  `setTakenOn` method (`apps/agent-api/src/store/tasks.ts`). In `setProject`, drop
  the "clear `takenOnAt`" branch — it becomes a plain `setProject`.
- Remove `takenOnAt` from `TaskSchema`, the `POST` body, the `PATCH` body, the
  `hasTakenOn` branch, and the `task_taken_on` log (`apps/agent-api/src/routes/tasks.ts`).
- Remove `setTaskTakenOn` from `UserDO` (`apps/agent-api/src/UserDO/index.ts`).
- Update `apps/agent-api/src/store/tasks.test.ts` and `routes/tasks.test.ts`:
  delete take-on assertions; add a test that `setProject` no longer touches the
  date, and (route) that a `takenOnAt` field is rejected/ignored.

### 3. Shared seams (`@zero/agent-core`) — the heart of the change

These are **in-process, pure** modules (dependency category 1): merge/rewrite and
test directly through their interfaces; replace old tests, don't layer.

- **`tasks/types.ts`:** delete the `takenOnAt` field from `Task`.
- **`tasks/home.ts` (`homeTasks`):** rewrite the availability filter to the
  null-date asymmetry:
  - loose (`projectId == null`): `showUpDate == null || showUpDate <= today`
    (unchanged).
  - project task: `showUpDate != null && showUpDate <= today &&
    projectDisplayStatus(project, ...) === "active"`. (Same shape as today, with
    the per-task predicate swapped from `takenOnAt != null` to "has a shown-up
    date".) The date-visibility check stays before availability so postpone still
    parks a task in Upcoming.
- **`projects/derive.ts`:**
  - Replace `isShownUpTakenOnOpen` with a "shown-up dated open task" predicate:
    `completedAt == null && showUpDate != null && showUpDate <= today`. Note the
    change: a **null** date no longer counts as shown-up for a *project* task
    (groomed ≠ committed).
  - `projectBaseStatus`: `active` iff the project has such a shown-up dated open
    task; else `next`. Backlog/done unchanged.
  - `waitingUntil`: soonest future `showUpDate` among the project's **open** tasks
    (drop the `takenOnAt != null` requirement — any future-dated task is now a
    commitment).
  - `projectDisplayStatus`, `waitingSince`, `conditionSatisfied`,
    `unresolvedConditions`: unchanged in shape; they inherit the new base. Confirm
    the "shown-up dated task overrides an open waiting condition" behavior falls
    out (it does, because `base === "active"` short-circuits before the condition
    check).
  - Update the module's header comment (it currently describes the taken-on rule).
- **`tasks/collection.ts`:** remove the `setTakenOn` verb, the `takeOn`/`park`
  actions, and `takenOnAt` from the `addTask` insert/persist and the `TasksApi`
  `add` signature. The verb-disambiguation comment and order simplify (drop the
  "projectId before takenOnAt" note; `moveToProject` no longer clears a date).
- **`projects/call-to-action.ts`:** no logic change (it reads
  `projectDisplayStatus`), but re-read the comments for any "taken-on" wording and
  correct it. Copy strings ("Plan your day", etc.) are unaffected.
- Delete `takenOnAt`/`takeOn`/`park` usage from every agent-core test
  (`tasks/home.test.ts`, `tasks/collection.test.ts`, `tasks/upcoming.test.ts`,
  `projects/derive.test.ts`, `projects/display.test.ts`, `waiting-badge.test.ts`,
  `call-to-action.test.ts`); rewrite the derivation/home tests to drive `active`
  via a shown-up **date** instead of the star.

### 4. Web + mobile REST/data-layer glue

- `apps/agent-web/src/lib/tasks.ts` and `apps/agent-mobile/src/lib/api.ts`:
  remove `setTaskTakenOn` and any `takenOnAt` from the add payload.
- `apps/agent-mobile/src/lib/tasks-collection.ts`: drop the `takeOn`/`park` glue.

### 5. Remove the star UI; add the project-screen date chip (Phase 2)

- **Home rows** (`apps/agent-web/src/pages/HomePage.tsx`,
  `apps/agent-mobile/src/app/(signed-in)/index.tsx`): remove the park star
  entirely (loose tasks never had it; project tasks now use the date, editable via
  the detail sheet / the row's postpone).
- **Project-screen rows** (`apps/agent-web/src/pages/ProjectDetailPage.tsx`,
  `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`): replace the
  take-on/park toggle with a **date chip** reading the task's `showUpDate`
  ("No date" when null). Tapping opens the **existing** scheduler (the detail
  sheet's Today/Tomorrow/calendar/clear) and calls `reschedule(id, date)`. Picking
  Today moves the task to Home and flips the project `active` — no new verb.
- **Task detail sheet** (both surfaces): remove the take-on/park control; the
  scheduler + project row already there do the job.

### 6. Home quick-add mini-composer (Phase 3)

Extend the Home quick-add on both surfaces with two independent controls that
reuse the detail sheet's modules:
- a **date chip** (default label reflecting a **null** default; opens the
  scheduler), and
- a **project selector** (assign an *existing* project — distinct from the
  "Project" mode pill that *creates* a project entity).

Wire the create call to pass `showUpDate` and `projectId` from the chips. When a
project is picked with no date, raise a "Filed to <icon> <title>" toast (the
shared toast primitive, fixed for this action) so the task leaving Home is
explained. Mobile: `QuickAddBar` is presentational; the chips are new slots it
renders and the container (`index.tsx`) owns their state. Web: the quick-add is
inline in `HomePage.tsx`.

## Out of scope

- **An "overdue" visual state** — explicitly deferred; its absence is why the null
  vs today default is only cosmetic. Do not add red/overdue styling here.
- **Web Upcoming gaining a detail editor / move-to-project** — a pre-existing
  web/mobile gap, tracked elsewhere.
- **Reorder on the project screen** — the parity plan's Phase 3; independent of
  this change.
- **Refine (`sourceCaptureId`)** — stays dormant.
- **Agent `create_task` tool** — unaffected; it simply won't set `takenOnAt`.

## Technical approach and alternatives

- **One dimension, not two (chosen).** Swapping the per-task predicate from
  "taken-on" to "has a shown-up date" is a minimal diff to `homeTasks` and
  `derive.ts` and deletes a whole column and verb set. Alternative — keep
  `takenOnAt` dormant (logic removed, column kept) as a hedge — was rejected: the
  star is fully retired (unlike `sourceCaptureId`, which has a planned Refine
  use), so a dormant column is dead weight.
- **Reuse the scheduler as the create-time and row chip (chosen)** over a bespoke
  binary today/undated toggle: the detail sheet already ships a deep scheduler
  module; reusing it means one component and free "add for Friday" / "commit to a
  future day," and avoids immediately wanting the richer control.
- **Independent chips + toast (chosen)** over coupling project→today: keeps the
  model honest (date = commitment) and matches the detail sheet's two independent
  rows; the toast removes the only downside (a silent disappear).
- **Table-rebuild migration (chosen)** over `ALTER TABLE ... DROP COLUMN`: matches
  the `0051` precedent and lets the backfill ride the same `INSERT ... SELECT`.

## System-wide impact

- **Contract change:** `takenOnAt` leaves the `Task` type and the REST payloads.
  Client and server ship together (single-user app), so no phased contract
  migration is needed; the offline outbox holds no in-flight `setTakenOn` writes
  in practice, but note that any queued `takeOn`/`park` mutation would fail to
  replay after deploy — acceptable given zero taken-on rows and the immediate
  device verification.
- **Derivation coupling:** `homeTasks`, `projectDisplayStatus`, `waitingUntil`,
  and `homeCallToAction` all consume the same base; changing the base predicate in
  one place (`derive.ts`) flows to all of them. This is the locality payoff — one
  edit, consistent everywhere — but also means the derive tests are the safety
  net; get them right first (TDD).
- **State risk:** the backfill must run before any client reads, which it does
  (migrations run on DO init, before request handling), and the DO-init
  `backfillSortKeys` is unaffected.

## Implementation phases

1. **Model + server (no UI):** migration `0052`; strip `takenOnAt` from store,
   routes, `UserDO`, and the `Task` type; rewrite the three derive predicates and
   `homeTasks`; update all agent-core + server tests (TDD — derive/home tests
   first). Ship-able and fully unit/route tested without touching screens.
2. **Remove the star, add the project-screen date chip:** delete the star from
   Home rows and the detail sheet; swap the project-screen row's trailing control
   to a date chip over the existing scheduler. Web + mobile screen tests.
3. **Home quick-add mini-composer:** date chip (null default) + project selector +
   "Filed to <project>" toast. Web + mobile screen tests.

Each phase is independently correct; Phase 1 changes behavior (undated project
tasks leave Home), so device-verify after Phase 2 at the latest.

## Test strategy

- **agent-core (Vitest, pure):** rewrite `home.test.ts` and `derive.test.ts` to
  drive `active`/Home membership via a shown-up **date** and to assert the
  null-date asymmetry (loose null ⇒ Home; project null ⇒ off Home; project
  dated-today ⇒ Home; project future ⇒ Upcoming + waiting-until; backlog/done
  project dated-today ⇒ off Home). Confirm a shown-up dated task overrides an open
  waiting condition. Delete star-based cases (replace, don't layer).
- **agent-api (Vitest):** `store/tasks.test.ts` — `setProject` no longer clears a
  date; no `setTakenOn`. `routes/tasks.test.ts` — `POST`/`PATCH` no longer accept
  `takenOnAt`. A migration test if the suite has one, asserting a taken-on-undated
  row gets `showUpDate = date(takenOnAt)`.
- **agent-web (Vitest/RTL):** `HomePage.test.tsx` — no star; the quick-add date
  chip defaults to no date and a project can be selected; filing to a project with
  no date drops the row from Home and shows the toast. `ProjectDetailPage` — the
  row date chip schedules via `reschedule`; picking Today surfaces the task on
  Home.
- **mobile (jest/RTL):** mirror the web screen tests under `__tests__/` (`index`,
  `project-detail`); assert the date chip and project selector, and that the
  take-on toggle is gone.

## Documentation strategy

- **`docs/entities/task.md`** — the source of truth for Task: remove `takenOnAt`
  from the data shape, vocabulary (retire "take on / park"), Home rule, and the
  "take-on and the date are orthogonal" section; state the new single-gate model
  and the null-date asymmetry.
- **`docs/entities/project.md`** — update Derived status to key on shown-up dated
  tasks; drop "taken-on" wording.
- **`docs/entities/waiting-condition.md`** — update any "taken-on overrides
  waiting" phrasing to "shown-up dated task overrides waiting."
- **`docs/plans/todo-availability-model.md`** and
  **`docs/plans/todo-single-list-3-date-availability.md`** — add a note that
  take-on is retired and the date is the sole gate (don't rewrite history; point
  forward to this plan).
- **`docs/plans/todo-project-task-row-parity.md`** — mark Decision A superseded by
  this plan (date chip replaces the star), or drop the plan if it hasn't shipped.
- **`docs/todo-app.md`** — add a "Shipped" tracking entry when it lands.
- **`apps/agent-mobile/CHANGELOG.md`** and **`apps/agent-web/CHANGELOG.md`** — one
  user-facing entry each, same change. E.g.: `- YYYY-MM-DD: A project task now
  shows up on your list when you give it a date, not a separate star — schedule it
  (Today from the project screen) to commit it; leave it undated to keep grooming
  it on the project. You can also set a date and pick a project right when you add
  a task.` (This is the mobile todo app, **not** the agent changelog.)

Every fact has one source of truth: the model lives in `task.md`; the plans point
at it rather than restating the rule.

## Skills to use

- `tdd` — write the agent-core derive/home tests first; they are the safety net
  for the base-predicate swap that flows to every derived status.
- `deep-modules` — the pure seams (`homeTasks`, `derive.ts`) are the test surface;
  replace star-based tests rather than layer. Reuse the scheduler as the create/row
  date chip instead of building a new control.
- `git-commit` — commit code + tests + both changelogs + the doc updates together.
- `open-pr` — if this ships as a PR.

## Acceptance criteria

- The `takenOnAt` column, store verb, route field, `UserDO` method, `Task` field,
  and collection verb/actions are all gone; the repo has **no** `takenOn`/`takeOn`/
  `park`/`taken_on` references except historical changelog/plan text.
- Migration `0052` drops the column and backfills undated taken-on rows to
  `date(takenOnAt)`; it runs clean on a DB with zero taken-on rows.
- Home: a loose null-date task shows; a project task shows **only** with a
  shown-up date; a `backlog`/`done` project's dated-today task stays off Home.
- A project derives `active` from a shown-up dated task, "waiting until <day>"
  from a future-dated task, and `next` when it has only undated tasks; a shown-up
  dated task overrides an open waiting condition.
- The project screen row commits a task via a date chip (pick Today → on Home,
  project `active`); the take-on/park star is gone from every surface.
- Home quick-add can set a date (default: none) and pick an existing project;
  filing to a project with no date drops the row from Home and shows a "Filed to
  <project>" toast.
- `test`, `lint`, `typecheck` pass for `@zero/agent-core`, `@zero/agent-api`,
  `@zero/agent-web`, `@zero/agent-mobile`; mobile verified on the Pixel 7 with a
  throwaway project (add-with-date-and-project, commit a groomed task via the date
  chip, confirm it lands on Home; delete the throwaway after).
- User-facing entries land in both `apps/agent-mobile/CHANGELOG.md` and
  `apps/agent-web/CHANGELOG.md`; `docs/entities/task.md` is updated in the same
  change.

## Risks and dependencies

- **Base-predicate blast radius:** `homeTasks`, `projectDisplayStatus`,
  `waitingUntil`, and `homeCallToAction` all key off the same base; a wrong swap
  silently mis-derives every status. Mitigation: TDD the derive/home tests first.
- **Overlap with the parity plan:** its Decision A must be reversed (see above) to
  avoid two conflicting trailing-control designs on the project row.
- **Migration is destructive** (drops a column via rebuild). Mitigation: the
  rebuild mirrors the tested `0051` pattern; the backfill is a pure projection;
  zero rows match today.
- **Device-only bugs:** past mobile regressions (e.g. the Undo `revive` bug) came
  from persisted-collection paths unit tests don't hit — the Pixel 7 run is
  required, not optional.
