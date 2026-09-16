# Plan: Swipe-dismissable mobile toast above the add button

## Conclusion

Make the existing mobile toast row dismiss with a horizontal swipe in either
direction, and raise the toast host so its lower edge stays 16 dp above the
56 dp add FAB. Keep both changes inside the mobile renderer adapter. The shared
headless toast controller, web renderer, callers, and native dependencies do not
change.

Verification stays bounded: run one focused Jest file while implementing, run
the three mobile package checks once at the end, and complete the one Today task
the user prepares in one Pixel 7 pass. Do not run an EAS build, emulator suite, full-repo
CI, or repeated visual-polish loops for this pure-JavaScript change.

## Goal

A user can dismiss any mobile toast or Undo snackbar with a deliberate
horizontal drag or flick. A short drag returns the toast to rest. While the
toast is visible, it sits above the circular plus button instead of covering the
button or intercepting its taps.

The existing behavior remains intact:

- toast actions such as Undo, Waiting for…, Open, View, and Dismiss remain
  tappable;
- actionable toasts retain their accessible timeout and pause while the app is
  backgrounded;
- announcements, replacement by toast id, safe-area handling, tab clearance,
  and enter/exit animation continue to work;
- the shared controller remains framework- and gesture-independent.

## Current state and design decisions

- `apps/agent-mobile/src/components/toaster.tsx` is the mobile renderer adapter
  over `defaultToastController`. It is mounted once under
  `GestureHandlerRootView` and `SafeAreaProvider`, so the required gesture and
  inset providers already exist.
- Expo SDK 57 already includes `react-native-gesture-handler`, Reanimated 4, and
  `react-native-worklets`. This change adds no package and needs no new dev
  client.
- The toast host currently clears only the safe-area inset and the approximately
  80 dp native tab bar. The medium FAB is 56 dp tall and sits 24 dp above its
  screen content bottom, so the toast and FAB occupy the same vertical lane.
- The swipe belongs in the mobile renderer adapter, not in
  `packages/agent-core/src/toast/controller.ts`. Gesture recognition and motion
  are platform implementation details; the controller already exposes the
  required `dismiss`/`deferDismiss` behavior through its interface.
- Reserve the FAB lane globally instead of coordinating every screen with the
  root toast host. Dynamic coordination would add route state, toast-height
  measurement, and coupling to `QuickAdd` and `useProjectAdd`. A fixed clearance
  keeps the root renderer independent and also protects Home, Projects, and a
  Project screen with one change. Toasts will sit slightly higher on screens
  without a FAB; that is the deliberate simplicity tradeoff.

## What to change and why

### 1. A committed horizontal swipe dismisses the rendered toast

Update `ToastRow` in `apps/agent-mobile/src/components/toaster.tsx`:

- Wrap the animated card in a `GestureDetector` with a memoized `Gesture.Pan()`.
- Require horizontal intent with `activeOffsetX` and fail early on vertical
  travel so a toast never makes the list below it feel hard to scroll.
- Store horizontal translation in Reanimated shared values. Capture the current
  translation when a drag starts so an interrupted spring does not jump.
- Apply only `translateX` while dragging. Keep per-frame work on the UI runtime;
  do not call React state setters or schedule work on the React Native runtime
  from `onUpdate`.
- On release, combine distance and projected velocity. A sufficient drag or a
  short fast flick commits in either direction, continues off-screen with a
  short ease-out timing animation, and then schedules
  `defaultToastController.deferDismiss(toast, 0)` on the React Native runtime.
  Passing the exact toast snapshot prevents a late completion from dismissing a
  newer toast that reused the same id.
- A noncommitted drag springs back to zero with velocity handoff and no haptic.
- Pass `ReduceMotion.System` to the settle and dismissal animations. The root
  already honors the Android Remove animations setting.
- Preserve the existing FadeIn/FadeOut, timer effects, accessibility
  announcement, action layout, and `dismissAfter` behavior.

Use the existing swipe implementation in
`apps/agent-mobile/src/components/reorderable-task-list.tsx` as local prior art
for `project`, `Gesture.Pan`, shared-value access, velocity handoff,
`scheduleOnRN`, and reduced motion. Do not extract another gesture module: the
row and toast gestures have different direction, thresholds, and outcomes, so a
new seam would be hypothetical and shallow.

### 2. The toast host reserves the FAB lane

Keep the position calculation in
`apps/agent-mobile/src/components/toaster.tsx`, but replace the current tab-only
offset with named terms for:

- bottom safe-area inset;
- 80 dp native tab bar content;
- 24 dp FAB bottom spacing (`pb-6` in the FAB wrappers);
- 56 dp medium FAB diameter (`h-14` in `Fab`);
- 16 dp visual gap between the FAB top and toast bottom.

The resulting lower edge is
`safe area + tab bar + FAB bottom spacing + FAB diameter + 16 dp`. The card can
grow upward for long text or multiple actions without crossing the FAB.

Do not move the FAB, shrink the toast, or add per-screen offset props. Those
options either move the primary action when feedback appears, reduce readable
space, or spread toast placement knowledge across callers.

### 3. Add one renderer-level swipe test

Extend `apps/agent-mobile/src/components/__tests__/toaster.test.tsx` with one
observable behavior test through the renderer interface:

1. Seed a sticky toast before rendering.
2. Drive the registered pan callbacks through the existing gesture-handler
   mock.
3. Confirm a committed horizontal swipe removes that toast from the controller
   snapshot.

If the off-screen animation completion must run in Jest, make the minimal update
to the existing Reanimated mock in `apps/agent-mobile/jest.setup.js` so
`withTiming` invokes its completion callback synchronously. Keep the existing
button/action tests as the regression coverage that the gesture wrapper does not
replace normal presses.

Do not add tests for projection arithmetic, easing values, every direction, or
pixel coordinates. Those are implementation details or physical-device
behavior. Do not change or add controller tests because the controller
implementation and interface do not change.

## Out of scope

- Web toast swipe behavior or web toast placement.
- Changes to toast queueing, duration, replacement, action order, copy, or
  controller types.
- A close button, vertical swipe, haptic feedback, drag background, or new toast
  visual treatment.
- Dynamic per-route toast placement or moving the FAB while a toast is visible.
- A new native package, EAS build, preview APK, emulator run, or broad mobile E2E
  suite.

## Simplified verification

Use three bounded passes.

### Pass 1: focused feedback while implementing

Run only the toaster test file after the gesture works:

```bash
pnpm --filter @zero/agent-mobile exec jest \
  src/components/__tests__/toaster.test.tsx --runInBand
```

Do not rerun unrelated screen suites during iteration.

### Pass 2: one final package check

Stop Metro and any Gradle process first. Run the touched package's checks once,
sequentially, because the `mini` host swaps when Metro, Jest, and TypeScript
compete:

```bash
pnpm --filter @zero/agent-mobile lint
pnpm --filter @zero/agent-mobile typecheck
pnpm --filter @zero/agent-mobile test
```

Do not run `bin/ci` on this NixOS box; its unrelated `workerd` checks cannot
start locally. GitHub Actions covers the whole-repository pipeline.

### Pass 3: one Pixel 7 scenario

Restart headless Metro, connect the installed development client through
`adb reverse`, and perform one short pass on the attached Pixel 7. The user will
prepare one disposable Task due Today.

1. Complete the prepared Task from Home to remove it and raise the Undo toast.
2. Capture one screenshot with the toast and plus FAB visible. Confirm a 16 dp
   gap separates them and neither clips the other.
3. Swipe the toast horizontally and confirm it leaves and does not return.

Use `maestro hierarchy` for live bounds and `adb shell input swipe` for the one
continuous gesture if Maestro resolves stale overlay bounds. Save and send the
screenshot as visual proof. The completed disposable Task needs no restoration.
Stop after this scenario; no canceled-drag pass, FAB tap, cleanup navigation,
light/dark sweep, release E2E run, or EAS build is needed.

## Documentation

- Add a most-recent bullet to `apps/agent-mobile/CHANGELOG.md` in the same change:
  users can swipe a snackbar away, and it now stays clear of the plus button.
- Add a concise shipped note to `docs/todo-app.md` that links this plan and
  records the Pixel 7 proof and throwaway-data cleanup. Keep implementation
  details in this plan rather than duplicating them there.

## Skills to use

- `expo-animation` — implement the UI-thread pan, velocity projection, spring,
  timing animation, and reduced-motion behavior.
- `impeccable` — keep the toast/FAB spacing and motion consistent with the
  incumbent Android Operate surface; use one bounded visual pass.
- `deep-modules` — keep the gesture in the mobile adapter and preserve the deep
  controller interface.
- `testing` — test observable renderer behavior without mocking internal
  collaborators or testing easing arithmetic.
- `changelog` — load before editing the mobile changelog and write the entry from
  the user's perspective.
- `git-commit` — commit code, test, changelog, and todo-app record together.

## Acceptance criteria

- A deliberate horizontal swipe or flick in either direction dismisses a mobile
  toast; a short swipe returns it to center.
- Swiping runs through Gesture Handler and Reanimated on the UI runtime, with one
  React Native runtime call only after a committed dismissal.
- A late swipe completion cannot dismiss a replacement toast with the same id.
- Toast action buttons still fire and dismiss exactly once, accessible timing
  and announcements remain intact, and vertical scrolling is not captured.
- On the Pixel 7, the toast's lower edge is 16 dp above the visible 56 dp plus
  FAB, above the native tabs and bottom safe area.
- The focused toaster test and the final mobile lint, typecheck, and test commands
  pass.
- One Pixel 7 pass completes the prepared Today task and proves placement plus
  committed dismissal; its screenshot is retained and the task stays completed.
- The mobile changelog and `docs/todo-app.md` ship with the code.

## Outcome

Implemented on 2026-09-16 as planned. The mobile renderer owns the bidirectional
horizontal pan, velocity projection, spring-back, reduced-motion timing, and
snapshot-safe dismissal. Its fixed bottom offset now reserves the native tabs,
safe area, 24dp FAB spacing, 56dp FAB, and a 16dp gap. The shared controller and
web renderer did not change.

The focused renderer test and the final mobile lint, typecheck, and 163-test
suite passed. On the Pixel 7, completing the user-prepared “Delete this task”
row showed the Undo snackbar above the unobscured plus FAB. A continuous
horizontal swipe dismissed it, and the task remained completed. No native build,
emulator suite, extra production entity, or second device pass was used.
