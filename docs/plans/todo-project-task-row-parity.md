# Bring the project screen's task rows to parity with Home

> **Superseded in part (2026-09-12) by `docs/plans/todo-retire-take-on.md`.**
> Decision A below (keep the take-on/park star on the project screen) is
> reversed: take-on is retired and the project-row trailing control is now a
> **date chip** (pick a date to commit the task to Home), not a star. The rest of
> this plan (tap-to-open detail, postpone, shared row/detail extraction) still
> stands.


> **⚠ Pending rework — do not build as written.** Two things landed after this
> plan and change it:
>
> 1. **`docs/plans/todo-retire-take-on.md` (in progress) deletes the take-on/park
>    star.** This plan's Decision A (keep the star as the project row's trailing
>    control) is **reversed**: the trailing control becomes a **date chip**, and
>    Decision C ("postpone on parked tasks") is moot — there are no parked tasks,
>    only dated/undated, and both the chip and swipe use `reschedule`. The core
>    goal (tap a project task → open the shared detail editor) and the swipe-to-
>    postpone are unchanged. Row extraction may already be done by retire-take-on
>    Phase 2. Rework this plan against the shipped date-gate model.
> 2. **A gesture bug was fixed this session (`docs/investigations/mobile-home-list-no-scroll.md`).**
>    It informs the swipe-to-postpone this plan adds to the project screen:
>    - The Home swipe (hand-rolled `Gesture.Pan`) coexists with scroll — the real
>      Home bug was `ReorderableList` + `RefreshControl` with no custom
>      `panGesture`; the fix is `panGesture={Gesture.Pan().activateAfterLongPress(520)}`.
>    - RNGH's legacy `Swipeable` is a verified-robust swipe pattern that coexists
>      with a gesture-managed list's scroll (fallback if a raw `Gesture.Pan` ever
>      fails to coordinate).
>    - When this plan adds swipe to the project screen: reuse a swipe approach
>      known to coexist with that screen's scroller, and if the project screen ever
>      gains a `RefreshControl` or becomes a `ReorderableList` (e.g. for reorder),
>      apply the `panGesture` pattern. **Device-verify scroll + swipe + pull-to-
>      refresh together on both surfaces** — this session showed how easily the
>      conflict hides from unit tests.

## Bottom line

On both surfaces (`apps/agent-mobile`, `apps/agent-web`) a task on Home is a
full-featured row: tap/click the text to open the detail editor, postpone it to
tomorrow, complete it with Undo, drag to reorder, and (for a project task) park
it with a star. On the **project screen** the same task is an inert row: a
complete circle, a plain non-interactive label, and a take-on/park star. This
plan raises the project screen's rows to Home parity on both surfaces, with one
deliberate difference kept: the project screen's trailing star stays a
**take-on/park toggle**, because that toggle is how a task is pulled onto Home in
the first place — Home's one-way "park" star cannot replace it.

Because the two surfaces mirror each other and the detail editor + row markup are
~200 lines each, parity is delivered by **reusing/extracting shared modules**,
not by copy-pasting Home's markup onto the project screen.

## Background (self-contained)

The todo app is one list of `Task`s. A task has `completedAt`, `showUpDate` (the
day it "shows up" on Home; null = no date), `takenOnAt` (null = parked, set =
taken on / active), `projectId` (null = loose), and `sortKey` (manual order).
Home shows only open, shown-up, *available* tasks (`homeTasks` in
`packages/agent-core/src/tasks/home.ts`), ordered by `sortKey`. The **project
screen** shows *all* open tasks of one project regardless of date or taken-on
state, ordered by `createdAt` asc — this is the grooming surface where you
collect tasks and then "take on" the ones you want on Home.

Shared task verbs (identical on both surfaces, via `TasksApi`): `complete`,
`reopen`, `edit`, `reschedule(id, date)`, `reorder(id, sortKey)`,
`moveToProject(id, projectId)`, `park(id)` (clears `takenOnAt`), `takeOn(id)`
(sets `takenOnAt`). `orderKeyBetween(prev, next)` mints a fractional `sortKey`
between two neighbours (`packages/agent-core/src/tasks/order.ts`).

### What each row does today

Home row (mobile `TaskRow` in `app/(signed-in)/index.tsx`; web `Row` in
`pages/HomePage.tsx`):

- **complete** — the circle (`undoableAction`, single "Completed" Undo toast).
- **open detail** — tapping the text opens the task-detail editor (edit title,
  schedule, move-to-project, complete).
- **postpone to tomorrow** — mobile: swipe-right-to-commit (`Gesture.Pan`);
  web: a hover "Tomorrow" button. Both call `reschedule(id, tomorrow(today))`.
- **reorder** — mobile: long-press drag via `react-native-reorderable-list`
  (`useReorderableDrag`, only valid inside a `ReorderableList`); web: a grip
  handle via `dnd-kit` `useSortable` inside `DndContext`/`SortableContext`.
  Both write a new `sortKey` via `reorder` + `orderKeyBetween`.
- **park star** — only on a project task; one-way `park(id)` (drops it off Home).
  A loose task shows no star.
- **project icon badge** — a project task shows its project's emoji; a loose
  task shows none.

Project-screen row (`ProjectTasks` in mobile `app/(signed-in)/projects/[id].tsx`
and web `pages/ProjectDetailPage.tsx` — structurally identical on both):

- **complete** — the circle (same `undoableAction`).
- **label** — a plain `<Text>` / `<span>`, *not interactive*.
- **take-on/park toggle star** — `☆` (parked) ↔ `★` (taken on): `takeOn(id)` /
  `park(id)`. This is the grooming control; it has no analogue on Home.

### The detail editor

- **Mobile**: already a shared deep module — `useTaskDetail`
  (`components/task-detail.tsx`). Interface: `open(task)`, `complete(task)`,
  `sheets` (render at screen root), `handleBack()` (consume Android Back),
  `active`. Resolves the selected task as `list.find(id)` from the screen's own
  visible list, so an edit that moves the task out of the list closes the sheet.
  Home and Upcoming both consume it.
- **Web**: *not* extracted — the detail sheet, schedule popover, project popover,
  and edit-on-close live inline inside `TaskList` in `HomePage.tsx`
  (`openDetail`, `commitAndClose`, `onPickSchedule`, `onPickProject`, the
  `Sheet` + `ScheduleRow` + `ProjectRow`). Web Upcoming does not open a detail at
  all today (a pre-existing web/mobile gap, noted but out of scope).

## Decisions

These are the product/design choices this plan locks or surfaces. Two (B, C) are
worth explicit sign-off before building.

**A. Keep the take-on/park toggle star on the project screen (locked).** Full
parity does **not** mean an identical row. The project screen's star toggles
`takenOnAt`; Home's star is a one-way `park`. The take-on direction is the only
way to move a parked task onto Home, so it must stay. The shared row is therefore
**parameterized on its trailing control**: Home injects a park star, the project
screen injects the take-on/park toggle.

**B. Reorder — recommend a separate phase, default OUT of the first cut.**
Reasons: (1) it changes the project section's order from `createdAt` to
`sortKey`; (2) on **mobile** the project screen is a `ScrollView` (header +
description + tasks + waiting), and `react-native-reorderable-list` cannot nest
inside a same-axis `ScrollView` — delivering drag here means restructuring the
whole screen into one `ReorderableList` with header/footer slots, a large change
disproportionate to "click + postpone parity". Web (`dnd-kit`) has no such
structural cost. Recommendation: ship click+postpone+complete parity first
(Phases 1–2), then decide reorder (Phase 3) on its own. If reorder is wanted in
the first cut, say so and it folds into Phase 2 on web and forces the mobile
`ReorderableList` restructure.

**C. Postpone applies to every project row uniformly (recommend), with a known
limited effect on parked tasks.** `reschedule(id, tomorrow)` sets `showUpDate`.
For a **taken-on** task this is meaningful (it governs when it returns to Home,
and a future date drives the project's derived "waiting until <day>"). For a
**parked** task it has little visible effect (a parked task is not on Home and
does not drive "waiting until", which requires taken-on). Uniform postpone is
simplest and harmless; the alternative is to expose postpone only on taken-on
rows, which complicates the row for little gain. Recommendation: uniform.

**D. Deliver parity by extracting/reusing shared modules, per surface (locked).**
- Mobile: reuse `useTaskDetail` for the detail (already shared); **extract a
  shared `TaskRow`** from Home so the swipe-postpone + complete + injected
  trailing control live in one place. The drag affordance is injected (a no-op
  on the project screen in Phases 1–2), so the row works both inside and outside
  a `ReorderableList`.
- Web: **extract a shared `useTaskDetail` hook (or `<TaskDetail>` component)**
  from `HomePage`'s `TaskList` mirroring mobile's shape, and **extract the shared
  `Row`**; then consume both on `ProjectDetailPage`. The drag grip is injected so
  the row renders with or without `dnd-kit` context.

Rationale for D: one detail editor and one row per surface means the project
screen inherits every future row/detail change for free (locality), and parity
is not a copy that drifts.

## What to change

### Mobile (`apps/agent-mobile`)

1. **Extract `TaskRow`** into `src/components/` from Home's in-file `TaskRow`.
   Its interface: `item`, `icon` (project badge or null), `onComplete`,
   `onOpen`, `onReschedule`, and a **trailing slot** (injected node/handlers) so
   Home passes its park star and the project screen passes its take-on/park
   toggle. The long-press-drag stays gated behind an injected `drag?` (present on
   Home, absent on the project screen in Phases 1–2). Home switches to consume
   the extracted component (behavior unchanged).
2. **Lift `useTaskDetail` into `ProjectDetail`** (screen root, not `ProjectTasks`)
   — `sheets` render at root, `handleBack` joins the screen's existing
   `BackHandler` (call it first, before the quick-add `adding` branch). Feed
   `list` with `tasks.filter(t => t.projectId === project.id)` (from the already
   loaded `openTasks`; no new query), `projects: list`, `onError: setError`.
   Render `detail.sheets` at root.
3. **Rewrite `ProjectTasks`'s rows to use `TaskRow`**: pass `onOpen = detail.open`
   (label becomes tappable, a11y label `Edit "<text>"`, matching Home/Upcoming),
   `onComplete = detail.complete` (centralizes the Undo, deletes the duplicate
   local `undoableAction`), `onReschedule` = postpone-to-tomorrow, and the
   take-on/park toggle as the injected trailing control. No `drag` in Phases 1–2.
   The section keeps `createdAt` order until Phase 3.

### Web (`apps/agent-web`)

4. **Extract the detail editor** from `TaskList` in `HomePage.tsx` into a shared
   `useTaskDetail` hook (or `<TaskDetail>`), mirroring mobile's interface
   (`open`, `complete`, the `Sheet`/popovers element, `selected`-drop-on-edit).
   Home switches to consume it (behavior unchanged).
5. **Extract the `Row`** from `HomePage.tsx` into a shared component with an
   injected trailing control and an injected drag grip (grip present on Home,
   absent on the project screen in Phases 1–2). Home switches to consume it.
6. **Rewrite web `ProjectTasks`'s rows to use the shared `Row` + detail**: click
   the text opens the detail; add the hover "Tomorrow" postpone button
   (`reschedule(id, tomorrow(today))`); keep the take-on/park toggle as the
   trailing control; complete routes through the shared detail's `complete`.

### Phase 3 (optional — reorder, only if decided in)

7. Web: wrap the project Tasks list in `DndContext`/`SortableContext`, give the
   shared `Row` its grip, order the section by `sortKey`, and reorder via
   `reorder` + `orderKeyBetween` over the project subset.
8. Mobile: restructure the project screen so the Tasks section is a
   `ReorderableList` (header/description above it as a list header, waiting
   section below as a footer, or hoist to a single list) and enable the injected
   `drag`. Order by `sortKey`.

## Out of scope

- Web Upcoming gaining a detail editor (a pre-existing web/mobile gap; separate).
- The project-icon badge on project-screen rows (redundant — you are already
  inside the project; rows show no badge there).
- Changing what the detail editor contains, or the take-on/park semantics.
- Reorder, unless Decision B is answered "in" (then Phase 3 applies).

## Test strategy

Mobile (jest + `@testing-library/react-native`, in
`app/(signed-in)/__tests__/project-detail.test.tsx`; the file already mocks
`@expo/ui`, `expo-router`, `rn-emoji-keyboard`, `@/lib/api`):

- Tapping a task's label opens the detail sheet (assert `task-edit-input` /
  `Set schedule` / `Set project` appear seeded from the task).
- The existing "completes a task and offers Undo" test keeps passing after
  completion routes through `detail.complete`.
- A new test: postponing a project task calls `reschedule` with tomorrow (drive
  the swipe's `onReschedule`, or assert the handler wiring).
- The take-on/park toggle still toggles (`takeOn`/`park`).
- Android Back closes an open detail sheet before it closes the quick-add.
- Add/keep a `TaskRow` unit test at the extracted component's interface (the
  Home-row tests move to it; delete the shallowed originals).

Web (vitest/RTL, in `pages/ProjectDetailPage.test.tsx` + the extracted modules'
own tests):

- Clicking a task's label opens the detail sheet; edits, schedule, move-to-
  project, complete work from it.
- The hover "Tomorrow" button calls `reschedule` with tomorrow.
- The take-on/park toggle still toggles.
- `HomePage.test.tsx` still passes after Home consumes the extracted `Row` +
  detail (behavior unchanged).
- New tests for the extracted `useTaskDetail`/`Row` at their interfaces; delete
  the assertions that only made sense against the inline versions.

Per `deep-modules`: replace, don't layer — old tests bound to the inline Home
markup are deleted once the extracted modules carry the same coverage.

## Device verification (required for mobile)

Verify on the real Pixel 7 (dev client + Metro), per the mobile rule: in a
**throwaway** project you create, tap a task (detail opens), swipe to postpone,
complete with Undo, toggle take-on/park, and confirm Android Back closes the
sheet before the screen; delete the throwaway project after. Never mutate the
user's real production data.

## Documentation

- One user-facing entry in `apps/agent-mobile/CHANGELOG.md` (mobile todo app,
  not the agent changelog), most recent first. E.g.: `- YYYY-MM-DD: A task on a
  project's screen now behaves like one on Home — tap it to open the detail
  editor (rename, schedule, move project, complete with Undo) and swipe it to
  push it to tomorrow, instead of just sitting there. The take-on/park star still
  works as before.`
- One user-facing entry in `apps/agent-web/CHANGELOG.md` for the web surface,
  same shape (click to open the editor; hover "Tomorrow" to postpone).
- If Phase 3 ships reorder, add a line about dragging to reorder a project's
  tasks.
- No `docs/todo-app.md` change required unless you find a claim that the project
  screen intentionally lacks these; if so, update it.

## Skills to use

- `tdd` — write each surface's "tap/click opens detail" and "postpone" tests
  first, then wire.
- `deep-modules` — extracting `TaskRow` (mobile) and `Row` + `useTaskDetail`
  (web); replace shallow tests rather than layer.
- `git-commit` — commit code + tests + both changelogs together.
- `open-pr` — if this ships as a PR.

## Acceptance criteria

- On both surfaces, tapping/clicking a task's label on the project screen opens
  the same detail editor as Home; edit/schedule/move/complete all work from it.
- On both surfaces, a project task can be postponed to tomorrow from its row
  (mobile swipe / web hover "Tomorrow"), calling `reschedule` with tomorrow.
- The take-on/park toggle star is unchanged and still toggles `takenOnAt`.
- Completion shows exactly one "Completed" Undo toast that reopens the task.
- Mobile: Android Back closes an open detail sheet before the quick-add/screen.
- Home behavior is unchanged after it consumes the extracted row + detail.
- `test`, `lint`, `typecheck` pass for `@zero/agent-mobile` and `@zero/agent-web`;
  mobile verified on the Pixel 7.
- A user-facing entry lands in each of `apps/agent-mobile/CHANGELOG.md` and
  `apps/agent-web/CHANGELOG.md` in the same change.
- If Decision B is "in", drag-reorder works on a project's tasks on both
  surfaces, ordered by `sortKey`.

## Risks and dependencies

- **Mobile reorder nesting (Phase 3):** `ReorderableList` inside a same-axis
  `ScrollView` is unsupported; Phase 3 forces a screen restructure. Kept out of
  the first cut for this reason (Decision B).
- **Web detail extraction touches Home:** extracting the inline detail from
  `TaskList` risks a Home regression; `HomePage.test.tsx` is the guard, and Home
  must be re-verified after the swap.
- **Postpone on parked tasks (Decision C):** limited visible effect; documented
  so it is not read as a bug.
