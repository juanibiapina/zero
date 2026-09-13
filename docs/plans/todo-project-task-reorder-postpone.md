# Reorder and postpone tasks on the mobile project screen

## Bottom line

Give every task on the mobile project screen the same two direct gestures as
Home:

- long-press and drag to reorder it;
- swipe right to set its show-up date to the user's local Tomorrow, including
  when the task currently has no date.

Implement the gesture stack once in a mobile `ReorderableTaskList` module and
use that module from both Home and project detail. The module must own the
fragile interaction between horizontal swipe, long-press drag, vertical scroll,
and Android `RefreshControl`. Convert project detail from a `ScrollView` with
mapped task rows to one `ReorderableList` scroll host with project content in its
header and footer. Reuse the existing `sortKey`, `TasksApi.reorder`, and
`TasksApi.reschedule` interfaces; no server, route, schema, migration, or shared
collection change is required.

This is an `apps/agent-mobile` feature. The web project page is unchanged.

## Goal

On a project's screen, the user can:

1. long-press any open task and drag it above or below another task in that
   project;
2. release and see the new order immediately;
3. leave and return, refresh, or restart and see the order preserved;
4. swipe a task right and reveal `Tomorrow`;
5. commit the swipe and see the task remain in the project with
   `Scheduled · Tomorrow`;
6. swipe an undated task and get a real `showUpDate` for local Tomorrow;
7. scroll vertically from a task row and pull to refresh from a task row without
   starting a reorder or a postpone.

## Current state and constraints

- Home already has the required behavior in
  `apps/agent-mobile/src/app/(signed-in)/index.tsx`. Its task row combines a
  Reanimated horizontal pan, `useReorderableDrag`, and a
  `react-native-reorderable-list` list.
- Project detail in
  `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx` is one `ScrollView`.
  `ProjectTasks` runs a second task live query, orders by `createdAt`, and maps
  static `ListRow` rows. It cannot drag or swipe.
- The parent project-detail module already has every open task. Its
  `projectTasks` array is the correct membership seam for the task editor and the
  new list, but it is not explicitly sorted today.
- Task ordering already persists end to end through the global fractional
  `sortKey`: `compareByOrder`, `orderKeyBetween`, `TasksApi.reorder`,
  `PATCH /api/tasks/{id} { sortKey }`, and `DbTaskStore.reorder` exist and are
  tested.
- Rescheduling already persists optimistically and offline through
  `TasksApi.reschedule` and the existing task PATCH route. Setting an undated
  task to Tomorrow needs no new verb.
- The project's task list includes every open task in that project regardless of
  date. Unlike Home, a postponed row does not leave this list. Its swipe must
  return the row to rest after committing so the updated schedule caption stays
  visible.
- `react-native-reorderable-list` 0.18.1 extends `FlatList`, supports list headers
  and footers, and documents the exact Android refresh mitigation already proven
  on Home: delay its pan with `activateAfterLongPress(520)` and disable the
  `RefreshControl` only while a drag is active.
- `docs/investigations/mobile-home-list-no-scroll.md` records a real Pixel 7
  failure caused by omitting that delayed list pan. A reorderable list with a
  default pan fought Android `SwipeRefreshLayout`, blocking both vertical scroll
  and pulls started on rows.
- The app already has compatible Reanimated, Worklets, Gesture Handler, and
  reorderable-list dependencies. `GestureHandlerRootView` already wraps the app.
  This change adds no native module and needs no new dev-client build.
- Every mobile change must pass on the attached Pixel 7. The development client
  targets production, so device verification must create and later delete one
  throwaway project and only its throwaway tasks.

## Decisions

### One deep mobile list module owns all four gestures

Create `apps/agent-mobile/src/components/reorderable-task-list.tsx` as a deep
module. Its interface accepts the task list, `TasksApi`, local `today`, row
callbacks/metadata, refresh state, and optional list header/footer content. Its
implementation owns:

- the `ReorderableList`;
- the interactive task row;
- horizontal swipe recognition and animation;
- long-press drag startup;
- the delayed list pan;
- Android refresh enable/disable during drag;
- fractional-key creation after a drop;
- optimistic `reschedule` and `reorder` writes plus write-error propagation;
- item layout animation while a Home row exits.

Home and project detail become two callers of one interface. This gives locality
to the gesture constants and arbitration rules. Copying Home's 150-line gesture
stack into project detail is rejected because the next scroll fix would have to
be made and device-verified twice.

No port or adapter is needed. Reanimated, Gesture Handler, and the reorderable
list are in-process mobile dependencies, and both callers use the same
implementation.

### Use one direct reorderable scroll host on project detail

Replace the project detail `ScrollView` and mapped `ProjectTasks` section with the
shared `ReorderableTaskList`:

- Keep `BackRow` outside the list, as it is now.
- Put the error, `ProjectHeader`, `ProjectDescription`, and conditional `Tasks`
  heading in `ListHeaderComponent`.
- Render `projectTasks` as the list data.
- Put `ProjectWaits` in `ListFooterComponent`.
- Keep the editor sheets and quick-add bar outside the list.
- Preserve `keyboardShouldPersistTaps="handled"`, bottom padding, theme colors,
  and the current three-collection pull-to-refresh callback.
- Use `contentContainerStyle.flexGrow = 1` so a short or empty project remains a
  full-height refresh surface.

A `ScrollViewContainer` plus `NestedReorderableList` is rejected. Project detail
has one task list, so a direct virtualized list is simpler, keeps one scroll host,
and avoids nested-list gesture and measurement behavior.

### Preserve one task order, not a project-specific order

Derive `projectTasks` in the parent by filtering the open collection and sorting
with `compareByOrder`. On drop, reorder the project subset, then mint the moved
row's key between its new visible project-task neighbors with
`orderKeyBetween`.

This preserves the existing single manual order on `Task.sortKey`. Hidden tasks
from other projects keep their keys; only the moved row changes. A new
project-task sort column or per-project rank is rejected because the task entity
already defines one order and the existing write is offline-durable.

### “Tomorrow” means local tomorrow

A committed project-row swipe calls
`api.reschedule(task.id, tomorrow(today))` for every task:

- an undated task gains Tomorrow;
- a task dated Today, overdue, or later is set to Tomorrow;
- a task already dated Tomorrow receives an idempotent write and returns to
  rest.

This matches Home's existing `Tomorrow` action and the task vocabulary. It does
not mean “one day after the current date.”

### Retained rows settle back; Home rows still exit

The shared row needs two post-commit presentations behind a small explicit prop:

- **Home / exit:** keep the existing 200 ms full-width ease-out, then run the
  reschedule. Home's visibility rule removes the task and the list closes the
  gap.
- **Project / return:** run the optimistic reschedule once the swipe commits and
  spring the row back to zero with the release velocity. The row stays mounted
  and its schedule caption changes to `Scheduled · Tomorrow`.

Both paths use Reanimated shared values and worklets for every frame.
`scheduleOnRN` is called only at commit, never during `onUpdate`. Reduced-motion
behavior keeps the state change but removes the horizontal travel.

`ReanimatedSwipeable` is rejected because this is swipe-to-commit, not a row that
stays open to reveal tappable action buttons.

## Gesture contract

Keep the tuned Home values as one source of truth in the shared module:

- A right swipe activates after 12 px: `activeOffsetX(12)`.
- More than 6 px of vertical intent fails the row pan before it activates:
  `failOffsetY([-6, 6])`.
- Translation is clamped at zero, so left swipes do nothing.
- Momentum projection decides the commit; projected X must exceed 140 px.
- A cancelled swipe springs to zero with the release velocity.
- The row uses a plain React Native `Pressable.onLongPress` with
  `delayLongPress={500}` to call `useReorderableDrag`.
- The list pan uses `Gesture.Pan().activateAfterLongPress(520)`, slightly after
  the row long-press. It must not use the library default pan.
- On Android, `RefreshControl.enabled` becomes false during an active drag unless
  a refresh is already running, and becomes true again on drag end.
- A drag must not fire the refresh spinner. A normal vertical swipe or pull must
  not move a task.

Keep the row's established visual and semantic behavior:

- opaque task surface over the `Tomorrow` reveal;
- fixed inset divider;
- 22 dp completion circle with its existing hit slop;
- full-row edit target, with the completion circle remaining a distinct action;
- optional project icon for Home;
- optional `Scheduled · <day>` caption and matching accessibility suffix for
  project detail;
- long titles wrap above the caption;
- no gesture-frame React state updates.

## System-wide impact

### Mobile UI

Home moves from its private `TaskRow` and private list wiring to the shared
module without changing behavior. Project detail gains reorder and postpone and
changes its scroll host from `ScrollView` to `ReorderableList`.

### Data and synchronization

No interface changes. Both actions remain optimistic, persist through the
existing offline outbox, reconcile from the server, and surface failures through
the screen's current error state.

A project task postponed to Tomorrow remains on the project screen, appears in
Upcoming, and can change the project's derived status to
`Waiting · until Tomorrow`. It does not appear on Home until its date arrives.

### Web and Worker deployment

No web file, Worker route, Durable Object store, migration, or shared package
changes. A mobile-only push does not redeploy `zero-api` under the current
Cloudflare build watch paths. Shipping the mobile app remains the separate APK
release process.

## Implementation phases

### 1. One module preserves Home's existing behavior

- Add `reorderable-task-list.tsx` and move Home's task-row gesture code, constants,
  reorder callback, refresh arbitration, and list composition into it.
- Give the module enough row metadata to render Home's project icon and project
  detail's optional schedule caption without exposing Reanimated internals.
- Keep persistence errors routed through each caller's `onError` setter.
- Replace Home's private implementation with the module.
- Run the existing Home screen suite before changing project detail. Home's
  render, edit, complete, scheduler, reorder, pull-to-refresh, CTA, and quick-add
  behavior must remain green.

### 2. Project tasks use the existing sort and reschedule writes

- Import `compareByOrder` into project detail.
- Sort the parent's filtered `projectTasks` array with it; use that same array for
  both the list and `useTaskDetail`.
- Add the existing `reorderTask` REST mock to the project-detail test setup.
- Remove `ProjectTasks` and its duplicate live query.
- Render project tasks through `ReorderableTaskList` in return-after-postpone
  mode, with schedule captions enabled and no redundant project icon.

### 3. The whole project page remains one scrollable refresh surface

- Move the current pre-task content into the list header and waiting conditions
  into the footer.
- Hide the `Tasks` heading when `projectTasks` is empty, as today.
- Preserve the fixed Back row, keyboard tap behavior, bottom inset for the FAB
  and tab bar, editor sheets, quick-add bar, and the all-three-collections
  refresh callback.
- Wire the shared delayed reorder pan and Android refresh toggle. Do not ship a
  reorderable list with its default pan, even temporarily.

### 4. Tests and real-device proof cover the conflicts

- Extend project-detail tests through the screen interface.
- Run package checks and an Android Metro export.
- Test the four competing gestures on the Pixel 7 with an overflowing throwaway
  project, then delete that project.
- Add the user-facing changelog and update the entity/tracking documentation in
  the same implementation change.

## Out of scope

- Reordering projects or waiting conditions.
- Dragging a task between projects or from project detail into Home/Upcoming.
- A separate order within each project.
- Swipe-left actions, swipe action buttons, haptics, or an Undo for rescheduling.
- A date-relative “add one day” action. Swipe always chooses local Tomorrow.
- Completed-task history.
- Web project-page gesture or drag parity.
- Server, route, database, migration, or collection-interface changes.
- Redesigning project header, description, waiting conditions, task editor, or
  quick-add.

## Test strategy

### Mobile screen tests

Update
`apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx`:

1. **Existing order is honored.** Return three same-project tasks whose
   `createdAt` order conflicts with `sortKey`; assert the visible task rows follow
   `compareByOrder`.
2. **A drop persists one new key.** Drive the existing reorderable-list test
   adapter with `{ from: 2, to: 0 }`; assert `reorderTask` receives the moved id
   and a key lower than the old first project-task key.
3. **Other projects are excluded.** Include an interleaved task from another
   project; assert it is absent and does not become a drop neighbor.
4. **Schedule presentation remains.** Keep the current Today/Tomorrow caption and
   accessibility assertions. They verify that the retained row exposes the
   reschedule result at its source.
5. **Pull refresh still composes all data.** Strengthen the current test to assert
   that project, task, and waiting-condition fetch counts all increase.
6. **Existing behavior remains.** Keep coverage for empty-section hiding,
   editor open/edit, completion with Undo, quick-add, waiting-condition display,
   icon editing, status actions, delete cascade refetch, and unknown ids.

Keep the current Home reorder test and all existing Home tests. The extraction
must not replace them with internal implementation tests.

Jest does not execute native gesture recognition or animation timing. Do not add
snapshots or test shared-value internals. The Pixel test is the interface test
for swipe angle, long-press timing, velocity, scroll handoff, refresh handoff,
and retained-row settling.

### Package checks

Stop Metro and any local Gradle/EAS build before checks on the constrained host.
Run the touched package serially:

```bash
pnpm --filter @zero/agent-mobile test -- --runInBand
pnpm --filter @zero/agent-mobile lint
pnpm --filter @zero/agent-mobile typecheck
pnpm --filter @zero/agent-mobile exec expo export \
  --platform android \
  --output-dir /tmp/zero-agent-mobile-project-task-gestures
```

`gob run bin/ci` remains the repository-default check, but this NixOS host cannot
complete its untouched `workerd` stages. GitHub Actions supplies the whole-repo
lint, typecheck, test, build, and deploy dry-run coverage.

### Pixel 7 verification

Use the installed **development** client with headless Metro and
`adb reverse tcp:8081 tcp:8081`. Do not install a preview or production APK.
Create a distinct throwaway project; never mutate an existing project or task.

1. Add at least 10 throwaway tasks so project detail overflows the viewport.
   Include undated tasks, one Today task, one Tomorrow task, and one long title.
2. Start a normal upward scroll on the middle of a task row. Confirm the page
   scrolls immediately and no task lifts or moves.
3. Return to the top and pull down starting on a task row. Confirm the refresh
   indicator appears and the list remains responsive.
4. Long-press a middle task, drag it above another task, and release. Confirm the
   row follows the finger, edge autoscroll works when needed, and the refresh
   spinner does not appear.
5. Leave the project, reopen it, pull to refresh, and confirm the moved task keeps
   its position.
6. Swipe an **undated** task right slowly below threshold. Confirm `Tomorrow`
   reveals and the row springs back without a date change.
7. Flick the same task right past the projected threshold. Confirm it gets
   `Scheduled · Tomorrow`, remains on the project screen, and settles back at
   X=0 instead of disappearing or staying offscreen.
8. Open Upcoming and confirm that task appears under Tomorrow. Return to the
   project and confirm its order is still stable.
9. Try a diagonal vertical gesture on another task. Confirm vertical scroll wins
   and no postpone occurs.
10. Tap a task row to open the editor and tap its circle separately to complete
    and Undo. Confirm the new gesture wrapper did not merge those actions.
11. Capture a screenshot and `maestro hierarchy` showing the reordered list and
    Tomorrow caption.
12. Delete the throwaway project so its tasks cascade away. Confirm it is absent
    from Projects and its Tomorrow task is absent from Upcoming.

No native dependency changes are planned, so Metro hot reload is sufficient.

## Documentation strategy

Ship these updates with the implementation:

- Load the `changelog` skill, then add a current-date bullet to
  `apps/agent-mobile/CHANGELOG.md`: project tasks can now be long-pressed to
  reorder and swiped right to schedule for Tomorrow; scrolling and pull-to-refresh
  continue to work from the rows.
- Update `docs/entities/task.md`: project detail is now another reorder/postpone
  surface; both views use the one `sortKey`, and an undated project task gains a
  date when swiped to Tomorrow.
- Update `docs/entities/project.md`: mobile project tasks are reorderable and
  swipe-to-Tomorrow while retaining their schedule caption and editor/completion
  actions.
- Update the top of `docs/todo-app.md` Project tracking after Pixel verification.
  Remove or rewrite its stale `Next: Reschedule a Task` item, because Home
  reschedule already shipped and this change extends it to project detail.
- Update comments in Home, project detail, and `ListRow` so they name the new
  shared module and current callers. Keep mechanism rationale in the shared
  module; do not duplicate the gesture contract in both screens.

No README, storage, REST, or migration documentation changes are needed.

## Skills to use

- `vocabulary` — use module, interface, implementation, seam, and adapter
  consistently in design and review.
- `deep-modules` — extract one gesture/list module with Home and project detail as
  real callers; test through its screen-facing interface.
- `expo-overview` — retain the Expo SDK 57 setup and avoid unnecessary native
  dependency work.
- `expo-animation` — implement the swipe on shared values/worklets, preserve
  reduced motion, and judge gesture handoff on the Pixel.
- `impeccable` — preserve row hierarchy, wrapping, touch targets, caption
  legibility, and task/action separation.
- `tdd` — add project order/reorder and refresh assertions before changing the
  screen structure.
- `testing` — keep semantic screen tests at the module interface and leave native
  gesture physics to device verification.
- `changelog` — write the required mobile user-facing changelog entry.
- `reproducible-locally` — run the package checks and execute the complete
  throwaway-project Pixel walkthrough.
- `git-commit` — commit the module, screens, tests, entity docs, tracking update,
  and changelog together.

## Acceptance criteria

- Project tasks render in `compareByOrder` order.
- A long-press drag changes only the moved task's `sortKey`, updates immediately,
  works offline, and survives refetch/reopen.
- Swiping any project task right past threshold sets `showUpDate` to local
  Tomorrow through `TasksApi.reschedule`.
- An undated task gains a date. A dated task is set to Tomorrow. A task already
  on Tomorrow remains usable and visible.
- A postponed task stays on project detail, returns visually to X=0, and shows
  `Scheduled · Tomorrow`; it also appears in Upcoming and follows the existing
  Home availability rules.
- A below-threshold swipe changes no data and springs back.
- Vertical scrolling starts from task rows without delay once the list overflows.
- Pull-to-refresh starts from a task row and re-pulls projects, tasks, and waiting
  conditions.
- Long-press drag does not start refresh; vertical/diagonal scroll does not
  reorder or postpone.
- Edge autoscroll permits a drag beyond the initial viewport.
- Task edit, complete/Undo, schedule caption, waiting-condition, project header,
  quick-add, Back, keyboard, and delete behavior remain intact.
- Home's existing swipe, reorder, scroll, refresh, edit, complete, and quick-add
  behavior does not change after extraction.
- No server, data-model, route, migration, shared collection, web, or native
  dependency change is made.
- Mobile tests, lint, typecheck, Android export, and the Pixel 7 walkthrough pass;
  screenshot/hierarchy proof is captured; throwaway production data is deleted;
  documentation and changelog ship in the same commit.

## Risks and mitigations

- **The reorder pan can block scroll and refresh.** Preserve the proven 520 ms
  delayed list pan and Android drag-time refresh toggle in the shared module.
  Test pulls and scrolls from a row, not only empty space.
- **The row swipe can steal vertical movement.** Keep the 12 px horizontal
  activation and ±6 px vertical failure range. Test deliberate diagonal drags on
  the Pixel.
- **A postponed project row can remain offscreen.** Project mode must commit and
  spring to zero because project membership does not change with the date. Test
  both undated and already-dated retained rows.
- **A mapped task section inside a ScrollView can create nested gesture bugs.**
  Replace it with one direct `ReorderableList` whose header/footer carry the rest
  of the page.
- **The screen can appear reordered before an offline write later fails.** Keep
  the existing optimistic transaction and route `isPersisted.promise` failures
  into the visible screen error. Reconciliation remains owned by the task data
  layer.
- **Reordering a project subset also affects global task order.** This is the
  existing Task ordering model: all task views are slices of one `sortKey`
  sequence. Document it and do not invent a second rank.
- **The shared extraction can regress Home while adding project behavior.** Land
  the module against Home first, keep Home's screen tests, and repeat Home's four
  gestures during the Pixel pass.
- **Jest can pass while native gesture arbitration fails.** Treat the Pixel 7
  scroll/pull/swipe/drag matrix as required acceptance evidence, not optional
  polish.
