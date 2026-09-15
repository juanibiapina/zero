# Swipe project tasks right to schedule Today

## Bottom line

Change only the mobile project screen's right-swipe action: a committed swipe must
set the task's `showUpDate` to the user's current local day, reveal `Today`, keep
the row on the project screen, and update its caption to `Scheduled · Today`.
Home must keep its existing swipe-to-Tomorrow behavior.

Keep the gesture and write policy inside the existing deep
`ReorderableTaskList` module. Replace its low-level `postponeMode` interface with
a semantic swipe-action union so each caller selects an outcome rather than
assembling a label, date, animation, and toast policy. Reuse
`TasksApi.reschedule`; this change needs no server, schema, migration, shared
collection, dependency, or native-code work.

## Goal

On a project's mobile screen, the user can swipe any open task right and set it
to Today in one gesture. An undated or future-dated task becomes scheduled for
Today; a task already on Today receives an idempotent reschedule. The task stays
visible in the project, and normal project availability rules decide whether it
also appears on Home.

## Current state and decision

- `apps/agent-mobile/src/components/reorderable-task-list.tsx` owns horizontal
  swipe, long-press reorder, vertical-scroll arbitration, Android refresh
  arbitration, animation, and optimistic task writes for both Home and project
  detail.
- Both callers currently use the same Tomorrow target. `postponeMode="exit"` on
  Home animates the row away and shows a destination toast;
  `postponeMode="return"` on project detail writes Tomorrow and springs the
  retained row back.
- Project detail already passes the reactive local day from `useLocalDay`, shows
  every open task in that project regardless of date, and derives its schedule
  caption with `scheduleLabel`.
- The existing `TasksApi.reschedule` interface is optimistic, offline-durable,
  and already accepts the local `YYYY-MM-DD` value needed here.
- The gesture constants and animations are proven on the Pixel 7. Do not retune
  the 12 px horizontal activation, ±6 px vertical failure range, 140 px
  projected commit threshold, spring/timing values, delayed reorder pan, or
  refresh handoff.

Use a semantic interface such as:

```ts
type SwipeAction = 'postpone-tomorrow' | 'schedule-today';
```

The module maps that choice to the target date, reveal label, retained/exiting
animation, and destination feedback. A generic caller-supplied configuration
object is rejected because there are only two real policies and exposing each
mechanical choice would make the interface wider and allow invalid combinations.
Keeping `postponeMode` plus a second date prop is also rejected because project
swipes will no longer postpone anything.

## What to change and why

### 1. The shared list owns two complete swipe policies

Update `apps/agent-mobile/src/components/reorderable-task-list.tsx`:

- Replace `postponeMode` with the semantic swipe-action union at both the list
  and row interfaces.
- Rename internal postpone-only identifiers to schedule/swipe terminology.
- Derive one target date per committed action:
  - `postpone-tomorrow` → `tomorrow(today)`, reveal `Tomorrow`, animate the Home
    row out, then show the existing destination toast;
  - `schedule-today` → `today`, reveal `Today`, write immediately at commit, and
    spring the retained project row back to zero.
- Keep persistence failures routed through the caller's existing `onError`
  interface.
- Rename the `--color-swipe-postpone` token and its class use to a neutral
  schedule-action name while preserving the current light/dark value and visual
  treatment.
- Keep reduced-motion behavior and every per-frame update on the UI runtime;
  call `scheduleOnRN` only at the committed gesture point.

This keeps label, date, settling behavior, and feedback together in one module,
so Home and project detail cannot combine mismatched pieces.

### 2. Each screen selects its intended outcome

- In `apps/agent-mobile/src/app/(signed-in)/index.tsx`, select
  `postpone-tomorrow`; no Home behavior or copy changes.
- In `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx`, select
  `schedule-today`.
- Keep project-task membership, ordering, editor, completion, refresh, and
  schedule-caption derivation unchanged. After the optimistic write, the
  existing presentation must render `Scheduled · Today`; an otherwise available
  project becomes Active, while a blocked project remains Blocked under the
  existing rules.

### 3. Screen tests specify the two distinct outcomes

Update the mobile screen tests through their existing screen interfaces:

- Change the project-detail swipe test to assert that a below-threshold swipe
  performs no write, a committed swipe sends `localToday()`, the retained row
  reads `Scheduled · Today`, and an undated in-play project changes from Next to
  Active.
- Assert that the project row's hidden swipe action reads `Today`.
- Add a Home regression assertion that its hidden swipe action still reads
  `Tomorrow`; keep the existing scheduler-to-Tomorrow test unchanged because the
  task editor is not part of this change.
- Do not test shared values, animation internals, or native gesture recognition
  in Jest. Verify those through the project/Home screen behavior and the Pixel
  walkthrough.

### 4. Current documentation states the split behavior

Ship the user-visible documentation in the same change:

- Load the `changelog` skill and add a `2026-09-15` bullet to
  `apps/agent-mobile/CHANGELOG.md`: project-task swipes now schedule Today, while
  Home swipes still postpone to Tomorrow.
- Update `docs/entities/task.md` so its vocabulary, behavior, and UI sections
  distinguish Home's postpone-to-Tomorrow gesture from a project screen's
  schedule-to-Today commitment gesture.
- Update `docs/entities/project.md` so mobile project tasks swipe to Today and
  retain their Today caption.
- Add the completed and Pixel-verified result to the top of Project tracking in
  `docs/todo-app.md`; mark the older swipe-to-Tomorrow tracking statement as
  superseded so the living document does not present two current behaviors.
- Keep `docs/plans/todo-project-task-reorder-postpone.md` unchanged as the
  historical plan for the originally shipped behavior.

## Out of scope

- Home's swipe target, destination toast, or exit animation.
- Task-editor Today/Tomorrow/calendar controls.
- Web behavior or gesture parity.
- Reorder behavior, gesture thresholds, haptics, Undo, or new swipe directions.
- Project availability, Blocked status, date formatting, or local-day lifecycle
  rules.
- Worker routes, Durable Object stores, task collection interfaces, database
  migrations, package dependencies, or native builds.

## Verification

### Automated checks

Stop Metro and any local Gradle process first on the constrained host, then run:

```bash
pnpm --filter @zero/agent-mobile test -- --runInBand
pnpm --filter @zero/agent-mobile lint
pnpm --filter @zero/agent-mobile typecheck
pnpm --filter @zero/agent-mobile exec expo export \
  --platform android \
  --output-dir /tmp/zero-agent-mobile-project-swipe-today
```

Run `gob run bin/ci` as the repository-default check. Record the documented
NixOS `workerd` failure if the untouched worker stages prevent completion.

### Pixel 7 proof

Use the installed development client, headless Metro, `adb reverse`, and Maestro.
The client targets production, so create only a distinct throwaway project and
its throwaway task; delete the project at the end so its task cascades away.

1. Create a throwaway in-play project and add one undated task on its screen.
2. Drag the task right below threshold. Confirm the reveal says `Today`, the row
   springs back, and no schedule caption appears.
3. Swipe past threshold. Confirm the row settles at zero, remains in the project,
   reads `Scheduled · Today`, and changes the project from Next to Active.
4. Open Home and confirm the task appears under the existing availability rule.
5. Start a below-threshold right swipe on that Home row and confirm its reveal
   still says `Tomorrow` and its date does not change.
6. Return to the project, pull to refresh, and confirm the Today caption persists.
7. Confirm vertical scroll/tap/long-press still hand off correctly around the
   changed row; no gesture constants should have changed.
8. Capture and return a screenshot plus `maestro hierarchy` showing
   `Scheduled · Today`.
9. Delete the throwaway project and confirm the task leaves Home.

No native module changes are planned, so Metro is sufficient and no dev-client
rebuild is required.

## Skills to use

- `vocabulary` — keep module, interface, implementation, seam, and adapter terms
  consistent.
- `deep-modules` — preserve one deep gesture/list module and keep policy details
  out of its callers.
- `documentation` — update each current fact at its source of truth without
  rewriting the historical plan.
- `expo-overview` — retain the Expo SDK 57 setup and avoid unnecessary native
  changes.
- `expo-animation` — preserve UI-runtime gesture work, spring behavior, reduced
  motion, and real-device feel checks.
- `testing` — assert observable screen outcomes rather than worklet internals.
- `tdd` — change the project and Home expectations before changing the swipe
  policy.
- `changelog` — write the required mobile user-facing entry.
- `reproducible-locally` — run package checks and the complete Pixel walkthrough.
- `git-commit` — commit implementation, tests, changelog, and living docs
  together.

## Acceptance criteria

- A committed right swipe on any project task calls `TasksApi.reschedule` with
  the current reactive local `today` value.
- The project reveal says `Today`; the retained row returns to X=0 and shows
  `Scheduled · Today` after the optimistic write.
- A below-threshold project swipe changes no data.
- Home still reveals and schedules Tomorrow, animates the row out, and shows its
  existing destination feedback.
- Existing reorder, scroll, refresh, edit, complete/Undo, and quick-add behavior
  remains unchanged.
- No web, server, schema, collection-interface, dependency, or native-code change
  is made.
- Mobile tests, lint, typecheck, Android export, and Pixel 7 verification pass;
  screenshot/hierarchy proof is captured; throwaway production data is deleted;
  the mobile changelog and current entity/tracking docs ship with the code.
