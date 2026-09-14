# Open a task's project and filter project assignments

## Bottom line

Improve the mobile todo task editor in two connected ways:

1. When an edited task belongs to a project, keep the Project row as the assignment control and add a trailing icon-only **↗** action that jumps to that project's screen.
2. Add a title filter to the shared project picker, so assigning an existing or new task stays fast with a long project list.

Keep both behaviors inside the existing deep editor and picker modules. This is a pure mobile UI change: no task model, collection verb, transport, server route, or native build changes. Use `@expo/ui` `Icon` with the official `@expo/material-symbols` arrow asset on Android and the matching SF Symbol on iOS; the asset package adds no native module.

## Current state and constraints

- The target is the Expo SDK 57 app in `apps/agent-mobile`.
- `useTaskDetail` in `src/components/task-detail.tsx` owns task editing for Home, Upcoming, and a project's own screen.
- `TaskEditorSheet` in `src/components/task-editor-sheet.tsx` owns the shared create/edit drawer and its full-width schedule/project action rows.
- The Project row currently has one action: open `ProjectPickerSheet` and change `projectId` through the existing offline-durable `moveToProject` verb.
- `ProjectPickerSheet` is already one shared, bounded, virtualized picker used by task editing and `useQuickAdd`; improving it once gives both assignment paths the filter.
- Cross-tab project navigation is already proven: `/projects/{id}` with `{ withAnchor: true }` keeps the Projects list under the detail screen, keeps the tabs visible, and makes Back return to the list. The Projects stack already declares `initialRouteName: 'index'`.
- Mobile changes are done only after real Pixel 7 verification. The development client targets production data, so verification must create and delete throwaway projects and tasks.
- The checkout is current with `origin/main`. The unrelated untracked `docs/plans/todo-project-completion-dependency.md` must remain untouched.

## What to change and why

### 1. The selected project row offers assignment and navigation as separate actions

Deepen `TaskEditorSheet`'s existing action-row interface instead of adding project-specific drawer markup in a caller:

- Extend an editor action with an optional trailing icon action containing its glyph, accessibility label, and callback.
- Render the main row action and trailing icon as sibling press targets, not nested `Pressable` elements, so tapping the icon cannot also open the assignment picker.
- Keep each target at least 48 dp and retain the existing semantic colors, dividers, large-text behavior, and Project-row accessibility value.
- The main Project row remains **Set project**. The trailing control displays only **↗**, styled as a quiet secondary action, with a full spoken label such as **Open project Diploma**. Do not add a visible “Open” label.

In `useTaskDetail`:

- Show the **↗** jump icon only when the selected task's `projectId` resolves to a current project.
- Before navigation, commit any changed task title through the existing optimistic/offline-durable edit path, mark the editor as closing, and clear its selected task. Closing first prevents the retained Home or Upcoming tab from leaving its modal over the destination.
- Navigate with `router.navigate(`/projects/${project.id}`, { withAnchor: true })`.
- Add a semantic `currentProjectId` option to the hook. The project-detail screen passes its own id, so a task already being edited on its owning project's screen does not offer a redundant self-navigation action. Home and Upcoming omit it and receive the action.
- Do not change the assignment behavior: tapping the main row still opens the picker, and moving a task still closes the editor and shows the existing destination feedback.

This keeps navigation and editor lifecycle behavior in the existing `useTaskDetail` deep module. Callers supply only route context; they do not duplicate save/close/navigate orchestration.

### 2. The shared project picker filters by title

Add local filter state inside `ProjectPickerSheet` in `task-detail.tsx`:

- Put a non-autofocused text input under the picker title with visible placeholder and accessibility label **Filter projects**.
- Filter project titles by a trimmed, case-insensitive substring. Preserve the collection's existing order; filtering must not re-sort results.
- Keep **No project** pinned outside the filtered `FlatList`, always visible and selectable, because it clears an assignment rather than naming a project.
- Show **No matching projects** when a non-empty filter has no matches.
- Keep `keyboardShouldPersistTaps="handled"`, the bounded panel, virtualization, selected check marks, and selected accessibility state.
- Reset the filter whenever the picker closes and reopens. Follow the scheduler's existing mounted-only-while-open shape so one picker session cannot leak its query into another task or into quick-add.
- Reuse the app's `Input` module and semantic Uniwind tokens. Keep the plain React Native `Modal` plus `FlatList`; `@expo/ui` `List` is not virtualized and is unsuitable for an unknown project count.

Do not extract a new file or introduce a new seam. The picker already centralizes both callers, and adding filtering there increases its depth and leverage without widening its interface.

## Out of scope

- The web task detail and web quick-add project menus. This plan targets the mobile drawer and Expo Router navigation only.
- Creating a project from the assignment picker.
- Filtering by project status, icon, description, or task count; the filter matches title text only.
- Showing Done projects. The picker continues to receive the existing working project collection.
- Changes to assignment persistence, destination toasts, project ordering, Home/Upcoming visibility, or project status derivation.
- A broad drawer redesign or new navigation route.
- Generalizing the picker for project dependencies. If concurrent dependency work lands first, add this filter to its generalized picker rather than forking another picker.

## Tests and verification

### Automated tests

Update tests through the existing UI interfaces:

1. `src/components/__tests__/task-editor-sheet.test.tsx`
   - A Project row with a trailing **↗** icon exposes two independent 48 dp press targets.
   - Pressing **↗** calls only its callback; pressing the Project row calls only the assignment callback.
   - The icon has the full accessible name **Open project <title>**; rows without a trailing action retain current behavior.

2. `src/components/__tests__/task-pickers.test.tsx`
   - Typing a mixed-case title fragment leaves only matching projects while **No project** stays visible.
   - Selecting a filtered result returns its id and preserves selected semantics.
   - A miss shows **No matching projects**.
   - Closing and reopening clears the prior filter.

3. Home and Upcoming screen tests
   - Editing a project task exposes the **↗** icon, closes the editor, and navigates to the exact `/projects/{id}` with `{ withAnchor: true }`.
   - A changed title is queued before the jump.
   - A loose task has no project-navigation action.
   - Upcoming uses the same behavior, proving both external callers of `useTaskDetail`.

4. Project-detail screen test
   - Editing a task on its own project screen does not show the redundant **↗** action; assignment remains available.

Keep existing create/edit, project assignment, picker scrolling, draft preservation, destination feedback, and Android Back tests green.

Before package checks, stop Metro and any local Gradle process on the memory-constrained host. Run:

1. `gob run pnpm --filter @zero/agent-mobile test`
2. `gob run pnpm --filter @zero/agent-mobile lint`
3. `gob run pnpm --filter @zero/agent-mobile typecheck`
4. `gob run pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-agent-mobile-project-jump`
5. Run the Impeccable detector once over the changed UI files.

Whole-repo `bin/ci` cannot complete on this NixOS host because untouched Worker checks start `workerd`; GitHub Actions covers the full pipeline.

### Pixel 7 proof

Use the development client, headless Metro, `adb reverse`, and Maestro. Create uniquely named throwaway projects and tasks only, then delete the projects so their tasks cascade-delete.

Verify:

1. Open a throwaway project task from Home, change its title, tap **↗**, and confirm the exact owner project opens with tabs visible and Back returning to Projects.
2. Open a future-dated throwaway project task from Upcoming and confirm the same jump.
3. Edit a task while already on its project screen and confirm no redundant **↗** action appears.
4. Open assignment for a throwaway task, filter to one uniquely named project, confirm nonmatches disappear and **No project** remains, then assign the task.
5. Close and reopen the picker and confirm the filter is empty.
6. Increase Android font scale for one pass and confirm the Project/↗ row and filtered picker remain usable; restore the original setting.
7. Capture and provide screenshots of the Project row with **↗** and the filtered picker.

## Documentation

- Load the `changelog` skill, then add one newest-first dated bullet to `apps/agent-mobile/CHANGELOG.md`, for example: “Open a task's project straight from its editor, and filter projects by name when assigning a task.”
- Update `docs/entities/task.md`, the Task source of truth, so its mobile UI behavior states that an assigned project can be opened or changed and that assignment supports title filtering.
- Update `docs/todo-app.md` only with implementation status, Pixel proof, and a link to this plan; keep detailed behavior in `docs/entities/task.md`.

## Skills to use

- `vocabulary` — use module, interface, seam, adapter, depth, leverage, and locality consistently.
- `deep-modules` — deepen `TaskEditorSheet`, `useTaskDetail`, and `ProjectPickerSheet` without duplicating drawer or picker behavior.
- `documentation` — keep behavior in the Task entity source of truth and structure updates bottom-line first.
- `expo-overview`, `expo-native-ui`, and `expo-ui` — preserve Expo SDK 57 conventions, accessible targets, keyboard resizing, and the virtualized RN picker.
- `expo-router` — implement and verify the anchored cross-tab project jump.
- `impeccable` — refine the two-action row and filter layout within the incumbent visual system, then run one detector pass.
- `tdd` and `testing` — add behavior-first tests through drawer, picker, and screen interfaces.
- `changelog` — write the required mobile user-facing entry.
- `reproducible-locally` — record package checks and Pixel 7 behavioral evidence.
- `git-commit` — commit code, tests, changelog, entity documentation, and tracking update together.

## Implementation result, 2026-09-14

Implemented as planned with a real platform icon: `@expo/ui` renders
`arrow_outward` from `@expo/material-symbols` on Android and `arrow.up.right` on
iOS. The Project row and arrow are sibling 56 dp press targets. Home and Upcoming
show the arrow for project-owned tasks; a project's own screen and loose tasks do
not.

The shared picker now filters titles case-insensitively, keeps No project pinned,
shows an empty result, and resets by mounting its state only while open. Pixel 7
verification found and fixed two defects that Jest could not reproduce: the
native icon host intercepted the surrounding press until its hit testing was
disabled, and the Android keyboard covered the filter panel until the bounded
list used `KeyboardStickyView` plus keyboard-height measurement. The final device
pass opened the exact project from both Home and Upcoming, kept the tab stack
anchored, filtered and selected a unique project above the keyboard, and
confirmed reset on reopening. Four throwaway projects and their two tasks were
deleted after the check.

## Acceptance criteria

- From Home or Upcoming, a project-owned task's editor has a distinct icon-only **↗** action that saves any title edit, closes the drawer, and opens the exact project with the tab bar visible and Back returning to Projects.
- The Project row still opens assignment; **↗** never opens the picker, and assignment never navigates.
- The visible control has no “Open” text, but TalkBack receives **Open project <title>**.
- Loose tasks and tasks edited on their owning project screen do not show a redundant **↗** action.
- The shared assignment picker filters project titles case-insensitively, preserves order, keeps **No project** pinned, reports no matches, and resets between openings.
- The filter works for both existing-task assignment and task quick-add because both use the same picker module.
- No model, data-layer, transport, backend, or native-build change is introduced; the only added package is the native-module-free Material Symbols asset set used by `@expo/ui`.
- Mobile tests, lint, typecheck, Android export, and the Pixel 7 walkthrough pass; screenshots and the mobile changelog ship with the implementation.
