# Silent task scheduling on mobile

## Goal

Changing a task's date, including choosing Tomorrow or No date, updates the task without a success toast. The same rule applies to every date choice and Home's postpone-to-Tomorrow swipe. Creating a scheduled task without filing it to another project also stays quiet, whether its date comes from a picker, parsed text, or a repeat. Filing a task to another project still shows its project destination toast, even when the task is scheduled. This is a mobile-only feedback change; scheduling still uses the existing optimistic, offline-durable write and reports failures.

## Implementation status (2026-09-23)

The code, changelog, and hermetic flow are updated. The owner chose not to run a Pixel test for this change. All 187 mobile tests, lint, and typecheck passed. Whole-repo CI failed at the known NixOS host `workerd` startup (`EPIPE`).

## What to change and why

- In `apps/agent-mobile/src/components/task-detail.tsx`, keep the changed-date guard, draft commit, reschedule transaction, error handling, and sheet closure, but remove the schedule-success call to `showTaskDestination`. Project moves must continue to show their destination toast.
- In `apps/agent-mobile/src/components/reorderable-task-list.tsx`, keep both swipe policies and their reschedule/error paths; remove the destination toast after the Home postpone swipe. Project-task swipe-to-Today already has no success toast.
- In `apps/agent-mobile/src/components/quick-add-composer.tsx`, stop showing a toast solely because the created task has a future `effectiveDate`. Keep destination feedback when it is filed to a different project than the current context, regardless of whether it also has a date. In that case show `Filed to project`, not `Scheduled for …`. Preserve the create transaction and failure handling.
- Narrow `apps/agent-mobile/src/lib/task-feedback.ts` to project-move and project-filing feedback. Remove the `scheduled` action and schedule-message branch; keep the existing View destination for future-dated project tasks (Upcoming) and other project destinations. Do not add a new seam or change the shared toast controller.

## Out of scope

- Web and Telegram scheduling, schedule labels, date persistence, recurrence, navigation, and failure feedback.
- Project-move, project-created, completion/Undo, and other actionable toasts.
- A new native build or broad manual visual testing: this is a JavaScript feedback change.

## Tests and verification

- Replace the obsolete scheduled-toast assertion in `apps/agent-mobile/src/lib/__tests__/task-feedback.test.ts` with project feedback cases, including a future-dated task moved/filed to a project routing View to Upcoming.
- Extend the existing mobile screen tests to assert that Tomorrow and No date selections still reschedule but add no toast, and that a Home postpone swipe adds no toast. Cover scheduled quick-add with a date chip and a parsed date/repeat: both create the right task without a toast when no other project is selected. Cover a scheduled task filed to another project: it creates the right task and shows `Filed to project` with View, not `Scheduled for …`. Retain an assertion that undated filing to another project still shows its View toast. Assert on the toast controller immediately after the action; do not use a timed absence check as the sole proof.
- Update the existing behavior-named `apps/agent-mobile/.maestro/hermetic/01-add-task.yaml` flow: create `E2E loose task` with Tomorrow (for example through parsed text), check Upcoming without a success toast, clear its date without a success toast, and check Home plus the existing restart assertion. Keep exactly one task at the end so the runner's postcondition remains valid. The flow is available for an optional `pnpm --filter @zero/agent-mobile e2e:pixel` run; it was not run for this change. Jest covers other schedule paths and toast absence.
- With Metro stopped on the memory-limited host, run the relevant Jest suites, mobile lint and typecheck. Attempt `gob run bin/ci` as required; if host `workerd` hits the documented NixOS failure, report it and retain the package-level results. Do not run checks concurrently with Metro or a local Gradle build.

## Documentation

- Add a user-facing bullet at the top of `apps/agent-mobile/CHANGELOG.md` in the same code change: creating a scheduled task without filing it elsewhere, rescheduling, clearing a date, and postponing no longer show a success snackbar; filing to another project still does. Use the implementation date and the changelog skill's format.
- Update the present-behavior sentence in `docs/todo-app.md` that says Home's Tomorrow swipe shows destination feedback. Leave historical beta-plan records as history.

## Skills to use

- `vocabulary` and `deep-modules` — keep the existing task-feedback module focused on project destinations without inventing a seam.
- `documentation` — maintain this plan and update the todo product record.
- `testing` — assert observable scheduling and feedback through the screen and helper interfaces.
- `expo-overview` — follow the Expo SDK 57 and dev-client constraints.
- `changelog` — write the mobile user-facing changelog entry before editing that file.

## Acceptance criteria

- Tomorrow, another date, Today, and No date never create a schedule-success toast from the task editor; Home's Tomorrow swipe is also silent. Creating a scheduled task without filing it to another project is silent.
- Scheduling and clearing still persist, move tasks between the correct lists, close the editor as before, and surface write failures.
- Moving an existing task or filing a new task to another project still shows its destination/View toast, even when the task has a date; no schedule toast replaces it. Unrelated toasts remain unchanged.
- Mobile tests, lint, and typecheck pass; report any whole-repo CI blocker. The hermetic Pixel flow remains available but is not required for this change.
