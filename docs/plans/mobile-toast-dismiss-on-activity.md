# Dismiss mobile toasts on activity

## Goal and policy

A mobile toast is feedback for the action that just finished, not a reminder that follows the user. A live toast disappears when the user starts a different in-app interaction, changes route (including native tabs and Back), opens the + drawer, or the app leaves the foreground. It never reappears on return. Ordinary and actionable toasts use a four-second lifetime instead of extending actions to eight seconds; Android's recommended accessibility timeout may extend that lifetime. The existing sticky project-failure notice remains an exception until dismissal or activity. Pressing a control *inside* the toast must still run that control's action before dismissing it. A new result of the user's next action may raise a new toast; clearing the old one must not suppress that result (for example, filing a new task to a Project may still show its destination).

Scope: `apps/agent-mobile` only. Web uses the same headless `@zero/agent-core` toast controller in a separate runtime; do not change web defaults or the controller's public interface for a mobile interaction rule.

## Current state and constraints

- `packages/agent-core/src/toast/controller.ts` owns a three-toast queue, default four-second timer, replacement by id (`undo`, `task-destination`, `project-error`), and snapshot subscriptions. `undoableAction` commits immediately and raises the one replaceable Undo toast; dismissal never reverses a write.
- `apps/agent-mobile/src/components/toaster.tsx` is mounted once in the root layout. Its row currently extends actionable toasts to at least eight seconds, asks Android for an accessibility-recommended timeout, and pauses the timer while the app is inactive/backgrounded. It already dismisses after a toast action or a horizontal swipe. Navigation does not dismiss it.
- `apps/agent-mobile/src/components/quick-add-composer.tsx` owns creation from Home, Projects, and Project detail. Creating a loose task raises no toast and currently leaves old ones visible; filing to another Project raises a destination toast. Creating a Project outside the Projects list raises a View toast. The Projects-list path navigates directly with no creation toast.
- `apps/agent-mobile/src/app/(signed-in)/projects/[id].tsx` raises a non-expiring global `project-error` toast for asynchronous completion/deletion failures after the screen may have gone away. Retain this exception so recovery instructions are not lost solely to a timer; interaction and app departure will still dismiss it.
- Navigation includes Expo Router native tabs plus a nested Projects stack. The root toaster is a sibling of the route stack, so screen unmount is not a dismissal signal. Gestures may be delivered through native screens rather than a single React view. Test on device instead of assuming a root touch listener sees every touch.
- Keep the Android recommended accessibility timeout and screen-reader announcements. The new four-second base replaces only the unconditional eight-second minimum for actionable toasts; Android may recommend more time.

## Implementation steps

1. **Ordinary mobile toasts use a four-second base.** In the mobile toast adapter, remove the unconditional eight-second minimum and the background pause/resume behavior. Keep Android's `getRecommendedTimeoutMillis` and honor its value when longer; keep `project-error` at Infinity until dismissed by the user/activity. The headless controller already starts a four-second default timer when ordinary toasts are shown (and restarts it on id replacement). A late accessibility response or stale row cleanup must not extend or restore a toast dismissed on activity. Keep the existing action, swipe, and exit animation semantics.
2. **Leaving the app or route clears live toasts.** At the root-mounted mobile adapter, dismiss all on `inactive`/`background` and on a genuine Expo Router location change, including tab changes, pushes, Back, and gestures. Avoid dismissing on the initial route observation or on re-renders. Clear on an already-backgrounded mount, and ensure a late timeout or asynchronous producer cannot restore an old toast on foreground. Do not suppress a new error raised after navigation by an asynchronous failed write.
3. **Starting another interaction clears old feedback.** Use one mobile interaction seam near the root for ordinary content touches/gestures, without claiming the responder or preventing scrolling, keyboard focus, or native navigation. Exclude interactions on the toast itself so Undo/View/Dismiss still execute. Explicitly dismiss in `useQuickAdd.open` for the + button, including accessibility activation and routes whose native touch events bypass the root seam. Cover creation submission as a fallback so adding a task from any drawer removes older feedback before any new destination toast is shown. Do not scatter dismissal through every screen action. Prove the seam actually receives list touches and native tab presses on the Pixel; if not, rely on route observation for tabs and add only the missing entry points rather than a brittle gesture interception layer.
4. **Tests and device proof demonstrate the policy.** Update `apps/agent-mobile/src/components/__tests__/toaster.test.tsx`: four-second expiry for an action toast with the ordinary platform timeout, longer expiry when Android recommends it, background/inactive dismissal (including a sticky error) with no return, route change versus initial render, normal content interaction, toast action still firing, and no stale timer revival. Test the shared quick-add path with an existing Undo toast: pressing + and adding a loose task clear it; filing a task replaces old feedback with only the new destination toast. Preserve the one-Undo replacement and completion/Undo tests. Extend `.maestro/hermetic/01-add-task.yaml` rather than adding another flow. Keep its existing open task for the runner's postcondition; create and complete disposable tasks within that flow to prove Undo clears on +, native tab change, and background/reopen without blocking the next action. Use package tests for timing and edge cases. Keep the hermetic Pixel runner's production-data isolation.
5. **User-facing documentation agrees.** Add one most-recent-first, dated user-perspective bullet to `apps/agent-mobile/CHANGELOG.md` in the same change. Update the relevant implemented-behavior record in `docs/todo-app.md` if it still describes the former paused/eight-second lifetime. Historical plans remain historical.

## Verification

Run `gob run bin/ci` after stopping Metro and local Gradle. On the documented NixOS host, whole-repo checks may stop at host `workerd` EPIPE; report that limitation and run mobile Jest in-band, lint, typecheck, and build/export checks directly. Run `pnpm --filter @zero/agent-mobile e2e:pixel` for native tab, gesture, and background proof. Verify the production-storage checksums and cleanup reported by the harness. No server or shared-controller behavior should change.

## Out of scope

- Web toast timing and tab-visibility behavior.
- Changes to task persistence, Undo semantics, the three-toast queue, or the messages/actions shown by new feedback.
- Changing the sticky project-failure notice or Android's accessibility-recommended timeout.

## Skills for implementation

- `expo-overview` and `expo-router` — use SDK 57 route and native-tab conventions before wiring route observation.
- `testing` — test observable dismissal and action behavior at the mobile adapter and quick-add interfaces.
- `changelog` — write the mobile user-facing entry in the same change.
- `documentation` — update the living todo-app record without rewriting historical plans.
- `reproducible-locally` — prove native lifecycle and navigation behavior with the hermetic Pixel flow.

## Acceptance criteria

Ordinary and actionable mobile toasts use a four-second base, with longer time only when Android recommends it for accessibility. Project-failure notices remain sticky until dismissed. No toast survives an in-app interaction, route change, or leaving the foreground. Tapping a toast action still executes it; a new action can present fresh feedback after clearing old feedback. Android and iOS mobile behavior is covered by package tests, and the extended existing Pixel add-task flow proves native +, tab, and background dismissal. Web remains unchanged.
