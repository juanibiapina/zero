# Create a project from inside a project on mobile

## Bottom line

The project-detail add drawer must offer **Task / Waiting / Project**. **Task**
remains selected whenever the drawer opens. Selecting **Project** and submitting
an outcome name creates an independent project through the existing project
write path, keeps the current project open, and shows the existing **Project
created** toast with a **View** action.

This is a narrow mobile wiring change. The shared `useQuickAdd` module already
owns project creation, optimistic/offline persistence, icon-suggestion warming,
the toast, and navigation. The project-detail screen currently excludes that
capability only because it passes `modes: ['task', 'waiting']`. Widen that caller
configuration instead of adding another project-create implementation or a new
seam.

## Current state

- `apps/agent-mobile/src/components/quick-add-composer.tsx` is the deep quick-add
  module used by Home and project detail. Its interface accepts an ordered
  `modes` list. Its existing `project` branch calls `projectsApi.add`, warms icon
  suggestions, closes the drawer, and raises a toast whose **View** action opens
  `/projects/{id}`.
- The module initializes and resets its selected mode to `modes[0]`. Keeping
  `task` first therefore preserves Task as the default on first open and every
  reopen.
- Home passes `['task', 'project']`. Project detail passes
  `['task', 'waiting']`, which is the only behavior preventing project creation
  from inside a project.
- `AddModeSelector` and the shared add-mode registry already support Project's
  label, accessibility name, and `Name an outcome` placeholder. Its module test
  already renders all three modes. No shared type, control, dependency, server
  route, or native build change is required.
- A project created from another project's screen is not a subproject. The data
  model has no parent-project relationship; this change adds an access path to
  ordinary project creation.

## What to change and why

### 1. The project-detail drawer exposes the existing Project mode

In `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`, pass
`['task', 'waiting', 'project']` to `useQuickAdd` in that order. Update the
adjacent comments to describe all three tabs and state that Task is the default.

Do not branch project creation in the screen. The existing `useQuickAdd`
implementation is the interface for this behavior and already has two callers;
reusing its project branch preserves locality for persistence, error handling,
toasts, icon suggestions, and navigation.

Keep `projectId` semantics unchanged:

- Task starts preset to the open project and remains changeable.
- Waiting creates a condition on the open project.
- Project creates a separate project and does not alter either the open project
  or its tasks and waiting conditions.

Update stale examples in `quick-add-composer.tsx` and
`packages/agent-core/src/quick-add/modes.ts` that describe the project screen as
Task/Waiting-only. Do not change `ALL_ADD_MODES`; Waiting remains excluded from
global, context-free mode sets.

### 2. The project-detail screen test proves the new path and the default

Update
`apps/agent-mobile/src/app/(signed-in)/__tests__/project-detail.test.tsx` through
the screen interface:

- Replace the Task/Waiting-only assertion with all three direct tabs and assert
  that Task is selected with the `Add a task` placeholder when the drawer opens.
- Add a project adapter mock and, if the toast action is exercised, expose the
  `expo-router` singleton's `navigate` method in the existing router mock.
- Select **Add a project**, assert the placeholder changes to
  `Name an outcome`, submit a title, and assert `addProject` receives that title
  while `addTask` and `addWaitingCondition` are not called.
- Assert the drawer closes and the existing `Project created` toast names the
  new project. Exercise **View** to prove its client-minted id is used for the
  destination without popping or mutating the original project.
- Reopen the drawer and assert Task is selected again. This makes “Task still
  default” an observable invariant rather than an incidental array order.

Retain the existing task-create and waiting-condition tests. They guard the two
existing branches while the offered mode set changes. No new
`TaskEditorSheet` test is needed because that module already covers a three-mode
selector.

### 3. User documentation describes the reachable behavior

During implementation, load the `changelog` skill before editing the changelog.
Then:

- Add a newest-first entry to `apps/agent-mobile/CHANGELOG.md`: users can create
  a project from another project's add drawer by selecting Project, while Task
  still opens by default.
- Update the mobile UI paragraph in `docs/entities/project.md`, the Project
  entity source of truth, from a Task/Waiting drawer to a
  Task/Waiting/Project drawer. State that newly created projects are independent,
  not children of the open project.
- Add the shipped result and Pixel 7 evidence to the current Project tracking
  section in `docs/todo-app.md`.
- Treat this plan as superseding the Task/Waiting-only mode-set statements in
  older implementation plans; do not rewrite their historical implementation
  bodies.

## Out of scope

- Web behavior. The web project page does not use this tabbed mobile editor.
- Subprojects, parent/child project links, or any new project relationship.
- The Projects-list project-only add form and Home's Task/Project drawer.
- Task defaults, task date/project rows, Waiting behavior, project icon
  suggestions, and toast presentation.
- Project/task/waiting types, collection verbs, REST routes, Durable Object
  stores, migrations, or offline reconciliation.
- New controls, styling primitives, animations, or native dependencies.

## Verification

### Automated checks

Write the project-detail screen test first, observe it fail while Project is
absent, then widen the mode list. Stop Metro before checks on the constrained
host. Run the local package checks instead of whole-repo `bin/ci`, which cannot
start `workerd` on this NixOS host:

1. `gob run pnpm --filter @zero/agent-core test`
2. `gob run pnpm --filter @zero/agent-core lint`
3. `gob run pnpm --filter @zero/agent-core typecheck`
4. `gob run pnpm --filter @zero/agent-mobile test`
5. `gob run pnpm --filter @zero/agent-mobile lint`
6. `gob run pnpm --filter @zero/agent-mobile typecheck`
7. `gob run pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-agent-mobile-project-from-project`

GitHub Actions supplies the whole-repo checks and deploy dry-run. This change is
pure TypeScript/React Native wiring, so the installed development client remains
valid and no EAS build is needed.

### Pixel 7 proof

Physical-device verification is mandatory for every mobile change. Use the
development client, `adb reverse tcp:8081 tcp:8081`, headless Metro, and Maestro.
The dev client targets production, so use only throwaway entities:

1. Create a throwaway parent project from the Projects list and enter it.
2. Open its add drawer. Capture a screenshot showing Task, Waiting, and Project,
   with Task selected and the task metadata rows visible.
3. Tap Project, create a throwaway project, and confirm the drawer closes while
   the current parent project remains open and the **Project created** toast
   appears.
4. Return to the Projects list and confirm the new project exists. Reopen the
   parent and its drawer, then confirm Task is selected again.
5. Delete both throwaway projects. Do not edit or delete any existing user
   entity.

Send the three-tab screenshot as the visual proof.

## Skills to use

- `tdd` — add the failing project-detail screen behavior before changing the
  caller configuration.
- `testing` — assert through the project screen and shared quick-add interface,
  not hook internals.
- `deep-modules` and `vocabulary` — preserve `useQuickAdd` as the one project
  creation module and avoid a duplicate implementation.
- `expo-overview`, `expo-native-ui`, and `expo-ui` — preserve Expo SDK 57,
  keyboard behavior, touch targets, and the existing plain React Native drawer.
- `expo-router` — verify the toast's nested project destination without changing
  the route structure.
- `impeccable` — inspect the three-tab row on the Pixel for fit and hierarchy;
  no visual redesign is intended.
- `changelog` and `documentation` — update the mobile release note and Project
  source of truth in the same change.
- `reproducible-locally` — collect package-check output and Pixel 7 screenshot
  evidence.
- `git-commit` — commit behavior, tests, changelog, and documentation together.

## Implementation result

Implemented as planned on 2026-09-13. Project detail now passes
`['task', 'waiting', 'project']` to the existing `useQuickAdd` module. The screen
test was added first and failed because **Add a project** was absent; widening
the caller's mode list made the full create/default/toast path pass without a
second project-create implementation.

Verification completed:

- Agent-core: 20 test files and 146 tests passed; lint and typecheck passed.
- Mobile: 16 suites and 108 tests passed; lint and typecheck passed.
- Android Expo export passed, producing the expected Hermes bundle.
- The Impeccable detector returned no findings for the changed UI files.
- Pixel 7: a throwaway parent project showed Task / Waiting / Project above the
  keyboard with Task selected; Project mode created a throwaway child while the
  parent remained open and raised the Project-created toast. The child persisted
  in the Projects list, and reopening the drawer selected Task again. Both
  throwaway projects were deleted; no existing entity was changed.

## Acceptance criteria

- A project's add drawer presents Task, Waiting, and Project as direct tabs in
  that order.
- Task is selected on every drawer open, including after creating a project.
- Project mode prompts `Name an outcome` and creates an ordinary independent
  project through the existing optimistic/offline project write path.
- Creating the project leaves the current project open and shows the existing
  toast; **View** opens the newly created project's route.
- Task creation still defaults to the open project, and Waiting still creates a
  condition on it.
- Home, the Projects list, web, persistence contracts, and global add modes do
  not change.
- Agent-core and mobile checks plus Android export pass. The Pixel 7 walkthrough
  passes, the screenshot is provided, and all throwaway production data is
  deleted.
- The mobile changelog, `docs/entities/project.md`, and `docs/todo-app.md` ship
  with the code.
