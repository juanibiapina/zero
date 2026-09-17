# Waiting drawer context labels

## Goal

Make the mobile Waiting drawer distinguish the Project that owns a waiting condition from the thing that Project is waiting on.

The drawer must read in this order:

```text
Task      Waiting      After      Project

PROJECT
✓  Todo app

WAITING ON
What needs to happen?                 ＋
```

`Project` labels the destination Project. `Waiting on` labels the condition field. The add action is announced as `Add waiting condition to <Project title>`.

This is a presentation and accessibility-copy change. Waiting-condition persistence, Project status, drawer modes, drafts, and submission behavior stay unchanged.

## What to change and why

1. **Clarify the shared Waiting context in `apps/agent-mobile/src/components/quick-add-composer.tsx`.** Replace the misleading `Waiting on` caption above the current Project with `Project`. Keep the icon and title as the destination identity, then add a persistent `Waiting on` caption immediately above the existing `What needs to happen?` field. Change the Project row's accessibility label from `Waiting on project <title>` to `Project <title>`, and make the circular submit action announce `Add waiting condition to <title>`.

2. **Let the drawer caller name its input in `apps/agent-mobile/src/components/task-editor-sheet.tsx`.** Add one optional input-accessibility-label value to the existing module interface, preserving its current default for every caller. The Waiting mode supplies `Waiting on`, so TalkBack receives the same meaning as the visible field label. Do not add a new module or duplicate the input implementation; the existing quick-add module is the locality for mode-specific copy, while the sheet continues to own field rendering.

3. **Preserve established terminology elsewhere.** Keep `Waiting` as the mode name, `What needs to happen?` as the placeholder, and `Waiting on` as the Project-screen section heading. Those uses describe the conditions beneath them and do not imply that the Project is the dependency target.

## Out of scope

- Changing Waiting-condition data, writes, resolution, or Project-status calculation.
- Changing the After flow, Task and Project modes, or the Project workspace section heading.
- Restyling the drawer, changing spacing tokens, or introducing a new reusable module.
- Creating a task, Project, or Waiting condition during device verification.
- Running emulator E2E, a native build, Android export, whole-repository CI, theme permutations, or large-font permutations for this copy-only change.

## Tests to update

Update existing assertions rather than adding another test suite:

- In `apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx`, update the Waiting-drawer expectations to require `Project <title>`, the `Waiting on` input label, and `Add waiting condition to <title>`. Keep the existing submission assertion to prove the text still reaches the unchanged Waiting write.
- In `apps/agent-mobile/src/app/(signed-in)/__tests__/index.test.tsx` and `upcoming.test.tsx`, replace the stale `Waiting on project <title>` expectation with `Project <title>`. Do not repeat all drawer-copy assertions in each route; the shared module and the Project-detail test own that behavior.

Run only the affected checks, with Metro and any Gradle process stopped first:

```bash
pnpm --filter @zero/agent-mobile exec jest --runInBand --runTestsByPath \
  'src/app/(signed-in)/__tests__/project-detail.test.tsx' \
  'src/app/(signed-in)/__tests__/index.test.tsx' \
  'src/app/(signed-in)/__tests__/upcoming.test.tsx'
pnpm --filter @zero/agent-mobile run typecheck
pnpm --filter @zero/agent-mobile exec eslint \
  src/components/quick-add-composer.tsx \
  src/components/task-editor-sheet.tsx \
  'src/app/(signed-in)/__tests__/project-detail.test.tsx' \
  'src/app/(signed-in)/__tests__/index.test.tsx' \
  'src/app/(signed-in)/__tests__/upcoming.test.tsx'
```

## Safe device verification

Use the attached Pixel 7 once because this is a visible mobile change, but keep the check read-only:

1. Run the development client against headless Metro through `adb reverse tcp:8081 tcp:8081`.
2. Open an existing Project without editing it.
3. Open the add drawer and select `Waiting`.
4. Use `maestro hierarchy` to confirm the Project identity is announced as `Project <title>`, the field as `Waiting on`, and the add action as `Add waiting condition to <title>`.
5. Capture one screenshot showing `Project` above the Project identity and `Waiting on` above the field.
6. Dismiss the drawer without typing or pressing add.

This check creates no data and makes no production write. Do not run a broader Maestro flow or install another APK.

## Documentation to update

- Update the Presentation section of `docs/entities/waiting-condition.md`, the source of truth for manual Waiting, so it describes `Project` as the destination label and `Waiting on` as the field label.
- Tighten the completion-feedback sentence in `docs/entities/project.md` only as needed to match those labels. Do not rewrite historical tracking in `docs/todo-app.md`.
- Add a newest-first bullet to `apps/agent-mobile/CHANGELOG.md`: `- 2026-09-16: Adding a Waiting condition now labels the current Project separately from what it is waiting on.`

## Skills to use

- `impeccable` — preserve the existing visual system while clarifying the information hierarchy.
- `expo-overview` and `expo-native-ui` — keep the change consistent with the Expo SDK 57 Android surface and TalkBack semantics.
- `deep-modules` — retain locality in the existing quick-add and editor-sheet modules without adding a shallow abstraction.
- `testing` — update the existing observable-behavior assertions without duplicating route coverage.
- `changelog` — apply the required user-facing mobile changelog entry.
- `git-commit` — commit implementation, tests, documentation, and changelog together when requested.

## Acceptance criteria

- The Waiting drawer no longer reads as though the current Project is what the Project is waiting on.
- `Project` appears above the destination icon and title; `Waiting on` appears above `What needs to happen?`.
- TalkBack-facing labels identify the destination, field, and submit action accurately.
- Waiting-condition submission behavior and all other add modes are unchanged.
- The three targeted test files, mobile typecheck, and touched-file lint pass.
- One Pixel 7 screenshot and hierarchy check prove the layout without creating or changing data.
- The Waiting entity documentation, Project documentation, and mobile changelog match the shipped UI.
