# Direct project status and cleaner project settings on mobile

## Bottom line

Make the status pill on the mobile project screen the status-change control. Move the existing manual status actions into a dedicated status sheet, and replace the `⋯` settings sheet with a compact native menu containing the destructive action. Preserve the current project model, inline editing, persistence behavior, and web interface.

## Goal

A user can tap a project's visible status and immediately choose a valid manual transition. Opening `⋯` shows a focused project-settings menu instead of the current uneven stack of outlined buttons.

## What to change and why

1. **The status pill opens status choices.** In `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`, make the complete status capsule a `Pressable` with a 44 dp effective target, button semantics, and the existing contextual label. Tapping it opens a short sheet titled **Project status**.
2. **The status sheet preserves derived-status semantics.** Move the existing actions out of `Project settings`: an in-play project offers **Move to backlog** and **Mark done**; a backlog project offers **Put in play** and **Mark done**. Keep `active`, `next`, and `waiting` derived from tasks, dates, and waits; do not add a five-state picker or new writes. Each choice dismisses the sheet and calls the existing `onStatus` path, including returning to Projects after **Mark done**.
3. **Project settings becomes one compact native menu.** Keep the `⋯` trigger, relabel its accessibility interface as **Project settings**, and retain only **Delete project** in an anchored native menu. This avoids wasting a half-height sheet on one action and gives deletion the native destructive treatment. Keep deletion immediate, preserve the existing cascade/refetch behavior, and return to Projects as today.
4. **Keep the implementation local.** `ProjectHeader` already owns the status and icon presentation state. Reuse the existing `Sheet` module for status and the installed native menu for settings; do not add another external seam or change shared data modules.
5. **Increase description contrast.** Render both entered description text and its empty prompt with the existing secondary-foreground token instead of the faint muted/placeholder tokens. Keep editing and persistence unchanged.
6. **Record the user-visible change.** Add `2026-09-13` bullets to `apps/agent-mobile/CHANGELOG.md`. Update `docs/entities/project.md` and the shipped tracking section in `docs/todo-app.md` so they no longer call the status pill read-only or place status moves in the overflow menu.

## Out of scope

- Web project detail.
- Project-list rows.
- Title, icon, description, task, waiting-condition, or quick-add behavior.
- Project status derivation, collection verbs, server routes, storage, or migrations.
- New confirmation or Undo behavior for Done or Delete.
- A new app-wide sheet or settings framework.

## Tests

- Update `apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx` so tapping **Project status: Next** reveals status actions and **Move to backlog** persists `backlog`.
- Cover the backlog branch: tapping **Project status: Backlog** reveals **Put in play**, which persists `next`.
- Move the terminal-status test through the status pill and verify **Mark done** persists `done` and returns to Projects.
- Verify the **Project settings** menu contains **Delete project**, does not contain status actions, and deletion still persists, returns, and refetches tasks and waits.
- Verify the contextual status text remains intact for derived waits and the status control remains accessible by its full label.
- Run the mobile package lint, typecheck, and Jest suite serially after stopping Metro. Run `expo export --platform android` for the bundle check.
- Verify on the attached Pixel 7 with Maestro using one throwaway project only: open the status sheet, move it to Backlog and back into play, inspect the settings menu, then delete the throwaway project. Do not edit an existing project. Capture and send screenshots of the status sheet and settings menu.

## Skills to use

- `impeccable` — implement and inspect the short Operate-mode sheet and menu hierarchy.
- `expo-overview`, `expo-native-ui`, and `expo-ui` — use Expo SDK 57-compatible native controls and the installed `@expo/ui` interfaces.
- `testing` — update behavior tests through the screen's visible interface.
- `changelog` — write the required mobile changelog bullet.
- `documentation` — update the Project source of truth and todo tracking without duplicating facts.
- `git-commit` and `open-pr` — commit the complete user-visible change and send it for review when requested.

## Acceptance criteria

- Tapping the visible project status opens the valid manual status actions directly.
- The status label still reflects derived Active, Next, and Waiting states and their wait context.
- `⋯` opens a compact native Project settings menu with Delete project and no status controls.
- Project description text and its empty prompt use the stronger secondary foreground color.
- Status changes and deletion retain their current offline-durable writes, navigation, cascade, and error handling.
- No web, server, shared-core, schema, or unrelated mobile behavior changes.
- Mobile tests, lint, typecheck, Android export, and Pixel 7 verification pass.
- The mobile changelog and Project documentation ship with the code.
