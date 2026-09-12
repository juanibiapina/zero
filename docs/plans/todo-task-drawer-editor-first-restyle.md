# Restore the shared task drawer's editor-first layout

## Bottom line

Keep task creation and editing in the shared `TaskEditorSheet`, but make the
former edit presentation the visual authority. The drawer must read as a
structured bottom surface: a visible top grip, a strong title row, and stacked
full-width date and project rows. Replace the current circular mode and metadata
pills with direct, rectangular controls.

The Todoist reference supplied on 2026-09-12 establishes the direction: a broad
rounded drawer with a clear grip, a prominent title region, and separate
rectangular metadata/action regions. Borrow that hierarchy, not Todoist's extra
features. Zero's `Task` remains one line of work with an optional date and
project; do not add description, priority, reminders, labels, subtasks, or
comments.

## Current state and root cause

Commit `6cbe02b22` merged create and edit into
`apps/agent-mobile/src/components/task-editor-sheet.tsx`. The shared module and
the separate write lifecycles are the right architecture, but the merge replaced
the former edit layout with the create composer's presentation:

- `ModePills` renders each add type with `rounded-full` and a 48 dp minimum
  height. Short labels such as “Task” become nearly circular.
- `Chip` renders date and project as `rounded-full` bordered capsules.
- The edit state is now only a title row plus two capsules, with no grip or
  stacked editor rows.
- The pre-merge edit layout is still available for reference at
  `6cbe02b22^:apps/agent-mobile/src/components/task-detail.tsx`: it had a grip,
  completion circle plus title, and full-width schedule/project rows separated
  by hairlines.

A Pixel 7 inspection of current `main` confirmed both failure modes. Creation is
a cluster of four large round controls above the keyboard. Editing is a short
floating strip whose two capsules dominate the task title. The problem is
presentation, not state, persistence, or navigation.

## What to change and why

### 1. The shared drawer looks like an editor in both states

Rework `TaskEditorSheet` once so create and edit cannot drift:

- Restore the top grip and the full-width rounded-top sheet shell.
- Remove horizontal padding from the shell itself. Apply padding inside each
  row so dividers and regions span the drawer cleanly.
- Keep the identity row prominent: edit shows the completion circle and title;
  create shows the title and the existing small submit `+` action.
- Keep the multiline title bounded for long text and preserve the 48 dp touch
  floor for every action.
- Use the existing semantic tokens (`surface`, `divider`, foreground levels,
  accent, scrim, elevation) so light and dark appearance remain automatic. Do
  not add literal colors or restyle the rest of the app.

The completion circle and submit `+` remain circular because they are icon
actions. No label or metadata control in this drawer uses `rounded-full`.

### 2. Add types become tabs, not pills

Replace `ModePills` with an `AddModeSelector` rendered only during creation.
Keep every offered mode directly reachable, but present the labels as a compact
text-tab row:

- Selected mode uses accent text plus a short bottom indicator.
- Unselected modes use secondary text.
- Each label keeps a 48 dp invisible hit target.
- No filled circle, capsule, or no-op decorative pill.
- Preserve `accessibilityRole="button"`, the existing add-mode accessibility
  labels, and `accessibilityState.selected`.

Home still offers Task/Project. A project's screen still offers Task/Waiting.
Changing mode still changes the placeholder and hides date/project controls for
non-task modes.

### 3. Date and project return to stacked editor rows

Replace the metadata capsules with full-width action rows below the identity
row:

- Schedule row: show `No date`, `Today`, `Tomorrow`, or the existing formatted
  date. Use muted text when unset and accent emphasis when set.
- Project row: show `No project` when unset; when selected, show the project's
  own icon and name exactly once. Do not restore a generic folder glyph or add a
  second project icon.
- Keep the latest icon rule from the unification change: no decorative folder
  or calendar emoji is added merely to fill a slot.
- Keep one-line truncation for long project names and full-row tap targets.
- Preserve the current accessibility labels (`Set schedule`, `Set project`) and
  test IDs so screen tests and Maestro selectors remain stable.

Use subtle full-width dividers and spacing, as the former edit drawer did. Do
not copy Todoist's unavailable attribute chips.

### 4. Keep the deep module and persistence lifecycles intact

Concentrate the visual change in
`apps/agent-mobile/src/components/task-editor-sheet.tsx`:

- Replace the private `Chip` implementation with a private editor-action row.
- Rename the exported `ModePills` to `AddModeSelector`.
- Rename presentation-specific props so the interface describes intent rather
  than the discarded visual treatment: `pills` to `modeSelector`, `dateChip` to
  `scheduleAction`, and `projectChip` to `projectAction`.
- Update the two callers, `quick-add-composer.tsx` and `task-detail.tsx`, to the
  renamed interface without moving their state or write logic.

`useQuickAdd` continues to own creation, explicit submit, autofocus, discard
confirmation, picker state, and per-mode writes. `useTaskDetail` continues to
own edit-on-dismiss, completion, reschedule, and project moves. No new seam,
adapter, dependency, or native build is justified; the existing shared module
already provides the needed locality.

Keep the drawer as a plain React Native `Modal` plus `KeyboardStickyView`. Prior
work established that the raw React Native title and rows do not render reliably
inside the native `@expo/ui` bottom sheet. This is a pure JS presentation change,
so the installed development client remains valid.

## Out of scope

- Task fields or behavior: no description, priority, reminders, labels,
  subtasks, comments, recurrence, or time-of-day.
- The scheduler and project picker contents; only their launch rows change.
- Data models, collection verbs, server routes, offline behavior, visibility
  rules, completion Undo, and project filing behavior.
- Web UI.
- The Projects-list project-only quick-add, which still uses `QuickAddBar` and
  was not part of the create/edit merge.
- Drag-to-dismiss. The restored grip identifies the bottom drawer visually;
  scrim tap and Android Back remain the dismissal mechanisms.
- A new global design system or broad token pass.

## Tests and verification

### Automated tests

Update `apps/agent-mobile/src/components/__tests__/task-editor-sheet.test.tsx`
through the drawer interface:

- Date and project rows invoke their handlers and the selected project icon is
  rendered exactly once.
- Unset rows remain visible and creation alone autofocuses.
- The configured add modes remain direct, selectable controls with the existing
  accessibility names and selected state.
- Non-task create modes omit schedule and project rows.

Update screen-test wording and selectors only where the renamed presentation
requires it. Keep the existing Home, Upcoming, and project-detail behavior tests
for create, edit-on-dismiss, scheduling, moving, completion, mode switching,
discard confirmation, and keyboard-hide draft retention. Do not assert exact
class strings as proof of visual quality; Jest cannot prove the on-device
layout.

Before checks on the memory-constrained host, stop Metro. Run:

1. `gob run pnpm --filter @zero/agent-mobile exec jest --runInBand --forceExit`
2. `gob run pnpm --filter @zero/agent-mobile lint`
3. `gob run pnpm --filter @zero/agent-mobile typecheck`
4. `gob run pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-agent-mobile-task-drawer`
5. Run the Impeccable detector once over the changed UI files.

Whole-repo `bin/ci` cannot complete on this NixOS host because its untouched
workers start `workerd`; the package checks and Android export are the local
fallback.

### Pixel 7 verification

Physical-device verification is required before this mobile change is done.
Use the development client, headless Metro, `adb reverse`, and Maestro. The app
points at production, so create one throwaway project and its throwaway task,
then delete the project to cascade-delete all test data. Do not edit an existing
user entity.

Verify and capture screenshots of:

1. Home creation with the keyboard open: Task/Project read as tabs, the title is
   primary, and date/project are stacked rows rather than circles.
2. The project screen's create state: Task/Waiting uses the same selector and
   the project row shows the preset project's icon once.
3. Editing the throwaway task with the keyboard initially closed: grip, complete
   circle, title, date row, and project row read as one proper drawer.
4. Opening each picker and returning preserves the creation draft; Back and
   discard confirmation retain their current order.
5. A long task title and long project name do not overlap the complete/submit
   controls or escape the drawer.
6. Both system light and dark appearance preserve hierarchy and contrast.

Send the final device screenshots as visual proof.

## Documentation

- Load the `changelog` skill, then add a newest-first bullet to
  `apps/agent-mobile/CHANGELOG.md`, for example: “The task drawer has its editor
  layout back: create and edit now use clear date and project rows instead of
  round pills, while your project's own icon still appears once.”
- Update the 2026-09-12 task-editor tracking paragraph in `docs/todo-app.md` so
  it describes the final row-based presentation rather than chips.
- Add a short supersession note to
  `docs/plans/todo-unify-task-editor-drawer.md`: its shared-module and behavior
  decisions remain valid, while this plan replaces its chip-based presentation.
- `docs/entities/task.md` already describes the detail's Project row and needs no
  change unless implementation alters that behavior.

## Skills to use

- `impeccable` — execute the narrow visual refinement and run its detector once
  after implementation.
- `expo-overview` and `expo-native-ui` — preserve Expo SDK 57, native touch
  targets, keyboard docking, safe-area handling, and automatic appearance.
- `expo-ui` — confirm that the existing plain React Native drawer remains the
  correct exception; do not move raw RN rows into a native `BottomSheet`.
- `deep-modules` and `vocabulary` — keep presentation local to the existing
  shared module and retain the separate create/edit implementations behind it.
- `tdd` and `testing` — update behavior tests before changing the shared drawer
  and test through its interface.
- `changelog` — write the required mobile user-facing entry.
- `reproducible-locally` — collect package-check output and Pixel 7 screenshot
  evidence.
- `git-commit` — commit code, tests, changelog, and documentation together.

## Implementation result, 2026-09-12

Implemented as planned. `TaskEditorSheet` now owns the grip, text-tab mode
selector, identity row, and full-width schedule/project rows. Creation and edit
controllers retain their separate write lifecycles.

Follow-up, 2026-09-13: the retained Projects-list `QuickAddBar` used the base
16 px body input while `TaskEditorSheet` used an 18 px semibold title. Both now
request the shared `Input` editor variant, backed by the `text-editor` typography
token in `global.css`.

Verification completed:

- Mobile Jest: 15 suites and 101 tests passed.
- Mobile lint, typecheck, and Android Expo export passed.
- Impeccable detector returned no findings for the changed UI files.
- Pixel 7: verified matching task/project creation typography, Home Task/Project
  and project-screen Task/Waiting creation, schedule-picker draft retention,
  edit with the keyboard initially closed,
  project-picker round trip, long task/project text, discard confirmation, and
  light/dark appearance.
- Device writes used throwaway project `Drawer QA 2229 with a long outcome name`
  and its task. Deleting the project removed both; no existing user entity was
  mutated.

## Acceptance criteria

- Create and edit still use one `TaskEditorSheet`; no duplicate drawer markup is
  introduced.
- The drawer has a visible top grip, a strong identity row, and full-width
  schedule/project rows separated by subtle dividers.
- Task/Project and Task/Waiting are text tabs with 48 dp hit targets, not filled
  circles or capsules.
- No label or metadata control in the shared drawer uses `rounded-full`; only
  the completion and submit icon actions remain circular.
- Date/project actions preserve all existing behavior and accessibility. A
  selected project shows its own icon exactly once and no generic folder icon.
- Creation still autofocuses, submits explicitly, preserves drafts through
  pickers, and confirms discard. Editing still opens without the keyboard and
  saves text on dismissal.
- No task schema, server, collection, visibility, scheduler, picker, web, or
  native dependency changes.
- Mobile tests, lint, typecheck, and Android export pass. The drawer is verified
  in light and dark appearance on the Pixel 7 with throwaway data, and
  screenshots are provided.
- The mobile changelog, `docs/todo-app.md`, and the prior unification plan are
  updated in the same change.
