# Rework the mobile Project workspace

## Bottom line

Recompose the mobile Project screen into one compact, native-feeling workspace without changing Project behavior. The identity row leads, the tappable status pill moves directly below it, the editable description follows, and Waiting, After, and Tasks use one consistent section rhythm.

The main floating `+` must stop opening the new **Add to Project** choice sheet. One tap opens the existing create drawer with **Task** selected and four type pills across its top: **Task**, **Waiting**, **After**, and **Project**. Existing section `+` controls continue to bypass the general entry point and open their matching type directly.

The **Waiting for…** action shown after completing a Project Task must stop opening the oversized generic form in the second supplied screenshot. It opens the same four-pill Project add drawer with **Waiting** selected. The drawer must identify the destination Project and ask what that Project is waiting on. Use **Waiting on**, the Project icon and title, and **What needs to happen?** instead of asking the user **What are you waiting for?**

This is an Android Operate-mode redesign inside Zero's established quiet, compact visual system. It changes mobile composition and add interaction only; it does not change entity semantics, persistence, navigation, or the web surface.

## Goal

Make the Project workspace read in this order on the Pixel 7:

```text
‹ Projects

🔑  Purchase House                         ⋯
    [Waiting · for 6 days ▾]
    Receive the keys to the house.

WAITING ON                                  ＋
More bills to pay          Resolve          remove

AFTER                                       ＋
🏠 Sell old house                              ›

TASKS                                       ＋
○ Receive the key

                                             ＋
```

The exact row contents remain data-driven. Empty Waiting, After, and Tasks regions remain absent.

## Current state and cause

- `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx` renders one `ReorderableTaskList` with Project identity and relationship regions in its header. Keeping one scroll host is required for task reordering and pull-to-refresh.
- The current Project header renders **description before status**, which separates the calculated state from the identity it qualifies.
- Vertical spacing is owned by several nested modules (`ProjectHeader`, `ProjectWaits`, and the Tasks heading). Their padding and gaps accumulate, producing the large dead zones visible in the supplied Pixel screenshot.
- Section actions use the same blue `+`, but their headings and rows do not share one alignment or spacing contract.
- Commit `a67aeaf53` introduced `useProjectAdd` in `apps/agent-mobile/src/components/project-add.tsx`. Its main FAB opens an `@expo/ui` action sheet before any editor or picker. This adds a selection step that differs from Home and the Projects list, where a FAB opens the shared create drawer with type pills.
- `useQuickAdd` in `apps/agent-mobile/src/components/quick-add-composer.tsx` already owns the create drawer, mode selector, writes, metadata rows, picker sheets, discard confirmation, and Android Back behavior. Before the latest commit it also supported project-scoped Waiting.
- `useProjectAdd` is the correct seam for Project-context creation, including calls launched from Home or Upcoming after Task completion. Its current implementation is wrong: it layers a choice sheet over separate Task, Project, Waiting, and After surfaces instead of presenting one coherent drawer.
- `WaitingComposer` duplicates the drawer shell with a large title, ambiguous second-person prompt, and detached Cancel/Add footer. It receives only an id, so it cannot show the Project icon or title. The second supplied screenshot demonstrates this failure on Home after **Waiting for…**.
- The checkout is current with `origin/main`. Existing untracked files must remain untouched.

## Selected design direction

Use a **single information spine** rather than cards or decorative containers:

1. **Compact identity cluster.** Keep icon, editable title, and overflow menu on one row with 48 dp targets. Reduce visual competition between the emoji and title. The overflow remains secondary.
2. **Status before explanation.** Put the complete status capsule immediately below the identity row and above the description. Keep it tappable and preserve its current derived label and lifecycle sheet.
3. **Description as quiet supporting text.** Keep the description always editable, but use the established secondary text role and a short, consistent gap below status.
4. **One section rhythm.** Waiting, After, and Tasks use the same heading baseline, trailing-action column, screen edge, and spacing interval. A region owns its internal row spacing; the workspace owns spacing between regions, so gaps cannot stack accidentally.
5. **Flat rows, not cards.** Preserve the app's current flat-list language, semantic colors, dark mode, and restrained blue accent. Do not add panels, gradients, new shadows, or a separate visual language.
6. **One-step primary add.** The FAB opens the familiar drawer immediately. The type pills are visible before the text field, Task is selected by default, and no native choice sheet appears first.

## Technical approach

### 1. Give the Project workspace one layout owner

Refactor the private view modules in `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx` so one workspace-header module controls the order and vertical intervals between identity, status, description, Waiting, After, and Tasks.

- Keep `ReorderableTaskList` as the sole scroll host; do not nest another scroll view or move relationship rows into the task footer.
- Split Project identity from supporting metadata so the rendered order is identity → status → description.
- Remove additive `pb-*`, `pt-*`, and parent `gap-*` combinations. Use existing spacing tokens and assign each interval at one level only.
- Align every section title to `px-screen-x` and every trailing `+` to the same 48 dp action column.
- Keep the full section interval before Tasks, but make it one intentional interval rather than the current sum of unrelated gaps.
- Preserve full wrapping for Waiting text. Keep Resolve and removal as distinct semantic actions, but quiet the removal affordance so it does not compete with Resolve. Use the existing icon/control vocabulary rather than another raw text glyph if the installed native icon path supports it.
- Keep task rendering, dividers, completion, swipe-to-Today, long-press reorder, and scheduled captions inside `ReorderableTaskList` unchanged.
- Use existing named type and color tokens in the touched layout. Add a named token only if a required role is genuinely absent and repeated; do not introduce route-local hex colors, arbitrary type sizes, or a second theme.

### 2. Make one Project add drawer serve every entry point

Remove the Project-only preselection sheet and deepen `useProjectAdd` into the Project-context add module. It composes the existing quick-add drawer and domain writes behind one interface instead of coordinating four unrelated surfaces.

- Extend the shared add-mode registry in `packages/agent-core/src/quick-add/modes.ts` with project-scoped **Waiting** and **After** modes while keeping `ALL_ADD_MODES` equal to `Task, Project`. Home and the Projects list therefore retain their current default types and order.
- `useProjectAdd` owns the ordered Project modes: `Task, Waiting, After, Project`. Its interface accepts a destination Project and an optional initial mode, and can render with or without its own FAB. This lets the Project screen show the FAB while Home and Upcoming mount the same drawer only for contextual launches.
- Extend the underlying quick-add controller so Project context supplies the Waiting adapter, relationship data, and candidate-Project calculation required by Waiting and After. Express this as a typed Project-context configuration rather than optional props that callers could combine incorrectly.
- Main Project FAB behavior: open the drawer directly on Task with all four pills visible. Remove the **Add to {Project}** `@expo/ui` sheet entirely.
- Project-section behavior: Tasks `+` opens the same drawer with Task selected, Waiting `+` opens it with Waiting selected, and After `+` opens it with After selected. The pills remain visible; there is no preceding chooser.
- Task-completion behavior: `useTaskDetail` stops owning `WaitingComposer` and the Waiting write. It reports the selected Project through a callback; Home, Upcoming, and Project detail open their mounted `useProjectAdd` drawer for that Project with Waiting selected. The same module therefore owns the FAB, section, and toast paths.
- Waiting mode shows a compact, non-editable Project context row (`icon + title`), the prompt **What needs to happen?**, and the drawer's existing circular submit action. It hides Task date and assignment rows. Remove the large **Add waiting condition** heading, ambiguous **What are you waiting for?** copy, and detached Cancel/Add footer.
- After mode keeps the four pills visible and opens the existing filtered Project picker. Cancel returns to the drawer with After selected; a successful pick creates the relationship and closes the flow.
- Project mode retains independent Project creation and its existing success feedback. Task mode retains date parsing, date and Project rows, destination feedback, and the destination Project as its default assignment.
- Preserve one draft per text-bearing mode while the drawer is open, so selecting After and cancelling does not reinterpret or erase typed Task, Waiting, or Project text. Closing the drawer clears all drafts and resets the next ordinary FAB open to Task.
- Android Back closes the deepest surface in order: picker or discard confirmation, then drawer, then the current screen.
- Delete `apps/agent-mobile/src/components/waiting-composer.tsx` after all callers use the Project add drawer. Retain `project-add.tsx` as the deep Project-context module; the deletion test now shows that removing it would spread mode, Project-context, picker, and write coordination across three screens.

### 3. Keep accessibility and responsive behavior native

- Preserve at least 48 × 48 dp for icon, status, overflow, section add, Resolve, removal, and task completion targets.
- Give each type pill a distinct accessibility label: **Add a task**, **Add a waiting condition**, **Add an After project**, and **Add a project**. Expose selected state.
- Make the four selectors fit the Pixel 7 at the tested 1.3× font scale without truncation or collision. Use equal flexible widths or a horizontally scrollable selector if needed; do not shrink text below the existing type role.
- Preserve status, section, and action meaning without relying on color.
- Preserve dark mode, system Back, keyboard/IME insets, bottom-tab clearance, and pull-to-refresh.

## Out of scope

- Project state or calculated-status precedence.
- Waiting or After data shapes, validation, persistence, API routes, or offline collection behavior.
- Task rows, completion, scheduling, recurrence, swipe, and reorder semantics.
- The Projects list, Home, Upcoming, tab navigation, icon picker behavior, or status-sheet actions.
- The web Project page.
- Showing empty relationship sections or adding empty-state guidance.
- A new visual identity, global design-system rewrite, animation pass, or native dependency.
- Editing the historical `docs/plans/todo-project-waiting-after.md`; it records the decision that produced the current implementation.

## Test strategy

### Shared and module-level behavior

- Update `packages/agent-core/src/quick-add/modes.test.ts` to prove Waiting and After have labels, placeholders or picker copy, and accessibility labels while the global default remains exactly Task then Project.
- Update `apps/agent-mobile/src/components/__tests__/task-editor-sheet.test.tsx` to cover four visible type selectors, selected state, and a 48 dp interaction row without coupling the test to styling internals.
- Keep existing Home and Projects-list tests proving those surfaces still offer only their current modes.

### Project-screen behavior

Update `apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx` through the rendered screen interface:

- One FAB tap reveals the Task editor and all four type pills; the old **Add to {Project}** action sheet is absent.
- Task is selected by default and retains date/project metadata and current Project assignment.
- Waiting switches the same drawer to **What needs to happen?**, shows the destination Project icon and title, hides Task metadata, and submits one manual condition.
- After opens the eligible-Project picker and creates one After relationship; cancel/Back returns correctly.
- Project mode creates an independent Project and retains existing feedback.
- Tasks, Waiting, and After section `+` controls open the same drawer with their matching pill selected.
- Completing a Project Task and pressing **Waiting for…** opens that same drawer with Waiting selected and the completed Task's Project visible, from Home, Upcoming, and Project detail.
- The old **Add waiting condition** / **What are you waiting for?** form never renders.
- Dismissing a draft still requests discard confirmation, switching through After preserves each text-bearing draft, and reopening resets to Task.
- Existing status, description editing, task gestures, relationship removal, completion, delete, error, and empty-section tests remain green.

Layout order and visual rhythm are device-rendered behavior, so do not add brittle tests that assert Tailwind class strings. Verify those through screenshots and accessibility hierarchy on the real device.

### Checks

Stop Metro and any local Gradle process before package checks on the constrained host, then run:

- `pnpm --filter @zero/agent-core run test`
- `pnpm --filter @zero/agent-core run lint`
- `pnpm --filter @zero/agent-core run typecheck`
- `pnpm --filter @zero/agent-mobile run test`
- `pnpm --filter @zero/agent-mobile run lint`
- `pnpm --filter @zero/agent-mobile run typecheck`
- `pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-project-screen-export`

The repository-wide `bin/ci` cannot complete on this NixOS host because untouched Worker checks require `workerd`; GitHub Actions supplies the cross-package check.

## Physical Pixel 7 verification

Use the development client with headless Metro and `adb reverse tcp:8081 tcp:8081`. Create only throwaway production entities and delete them afterward.

1. Create a throwaway Project with a realistic title, description, Task, manual Waiting condition, and After relationship to a second throwaway Project.
2. Capture the Project workspace in light and dark themes and at 1.3× font scale.
3. Confirm identity → status → description order, consistent section spacing, aligned actions, wrapped Waiting text, and no collisions with the FAB or tab bar.
4. Tap the main FAB and confirm the Task drawer appears immediately with Task, Waiting, After, and Project selectors. Confirm no preselection sheet appears.
5. Exercise each selector, including After picker cancellation, per-mode draft retention, and Android Back ordering.
6. Exercise each visible section `+` and confirm the same drawer opens with the matching pill selected.
7. Complete the throwaway Project Task from Home, press **Waiting for…**, and confirm the same drawer opens with Waiting selected, the Project icon/title visible, and **What needs to happen?** as the prompt.
8. Pull to refresh, reorder a throwaway Task, and swipe it to Today to confirm the retained list host still owns those gestures.
9. Delete both throwaway Projects and restore device theme and font settings.

## Documentation and changelog

- Update `docs/entities/project.md`, the Project behavior source of truth, so workspace order is identity → status → description → Waiting → After → Tasks and the main Add interaction is the four-pill drawer rather than an action sheet.
- Update `docs/entities/waiting-condition.md` so every mobile entry point uses the Project add drawer with Waiting selected, shows the destination Project, and asks **What needs to happen?** Remove its obsolete standalone-form wireframe.
- Update the current-state summary in `docs/todo-app.md` so it does not preserve the superseded action-sheet or standalone Waiting-composer behavior.
- Update `apps/agent-mobile/PRODUCT.md` only where its Project-workspace ordering conflicts with the new source of truth; prefer a reference to `docs/entities/project.md` over duplicating the complete order.
- Update the latest `apps/agent-mobile/CHANGELOG.md` entry in the same change. It must say, from the user's perspective, that Project screens now put status before description, use a tighter workspace layout, open the familiar type selector directly from `+`, and show the destination Project when adding Waiting from task-completion feedback. Remove the stale claim that Add first opens focused action choices.
- Do not change the web or agent changelogs.

## Skills to use during implementation

- `impeccable` — implement the confirmed compact-workspace hierarchy and run one bounded visual inspection pass.
- `expo-overview` and `expo-native-ui` — preserve Expo SDK 57 and Android Material behavior.
- `expo-ui` — retain native sheets, menus, and pickers where they already fit; do not use one for the removed preselection step.
- `expo-design-system` — keep touched typography, spacing, color, radius, and elevation on the existing Uniwind token system.
- `testing` — assert behavior through the quick-add and Project-screen interfaces rather than implementation details.
- `changelog` — update the mobile changelog in the same user-visible change.
- `documentation` — keep Project behavior in its existing source of truth and remove stale duplicate claims.
- `git-commit` — commit the implementation, tests, docs, and changelog together when requested.

## Acceptance criteria

- The Project screen visibly reads identity → status → description → relationship regions → Tasks.
- Status is above the description and still opens the lifecycle sheet with its full derived context.
- Section titles, rows, and trailing actions share one grid and deliberate vertical rhythm; the screenshot's accidental dead zones are gone.
- One tap on the main FAB opens the existing create drawer with Task selected and Task, Waiting, After, and Project selectors visible. No **Add to Project** action sheet appears.
- Every selector completes its existing domain action, and each visible section `+` opens the same drawer with that type selected.
- **Waiting for…** after Task completion opens that drawer with Waiting selected, names the destination Project, and asks **What needs to happen?**; the standalone Waiting form is gone.
- Empty Waiting, After, and Tasks regions stay hidden.
- Existing data, status derivation, offline durability, task gestures, navigation, tabs, dark mode, and error behavior are unchanged.
- Relevant shared/mobile tests, lint, typecheck, and Android export pass.
- Light, dark, and 1.3× layouts and all add paths are verified on the physical Pixel 7 with throwaway entities that are deleted afterward.
- Mobile behavior documentation and changelog match the shipped screen.
