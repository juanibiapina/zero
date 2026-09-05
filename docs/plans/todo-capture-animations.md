## Plan: quick-add morph + done fade-out animations

Self-contained plan for a fresh agent. Assume only this doc. Two Todoist-style
animations on the mobile todo screen, both mobile-only (`apps/agent-mobile`),
pure JS + one babel config change. Research-backed (reanimated 4 docs, Software
Mansion blog, react-native-keyboard-controller / Expo keyboard docs, GitHub
issue software-mansion/react-native-reanimated#8231).

### Goal

1. **Quick-add morph** — the circular `+` FAB (bottom-right) expands/morphs into
   the full-width quick-add bar when opened, and collapses back into the FAB when
   dismissed, instead of the current instant swap. The bar rises together with
   the keyboard.
2. **Done fade-out** — marking a todo done fades and collapses the row out, and
   the rows below slide up to fill the gap, instead of the current instant hard
   remove.

Both are visual only. All existing behavior stays: rapid capture, discard-confirm
dialog, Android back-button + keyboard-hide handling, optimistic remove + error
rollback, the `markTodoDone` call.

### Context (verified in the repo, 2026-08-26)

- Screen: `apps/agent-mobile/src/app/(signed-in)/index.tsx`. FAB component:
  `src/components/ui/fab.tsx`.
- Today the screen conditionally renders: `adding === true` shows a
  `KeyboardStickyView` bar (`Input` + small `Fab`); `adding === false` shows the
  `Fab` pinned `absolute bottom-6 right-6`. The swap is instant.
- `onDone(item)` does an optimistic `setTodos(prev => prev.filter(...))`, calls
  `markTodoDone`, and re-inserts the item on error. Keep this contract.
- Deps already present: `react-native-reanimated@4.5.1`,
  `react-native-worklets@0.10.1`, `react-native-keyboard-controller@1.21.9`.
  Reanimated is **unused in `src` so far** — this is its first use.
- Keyboard height is trackable via `useReanimatedKeyboardAnimation()` →
  `{ height, progress }` shared values (already returned by the jest mock).

### Reanimated 4 reality (research)

- v4 is New-Architecture-only. The app is SDK 57 + New Arch, so fine.
- v4 moved worklets into `react-native-worklets`. Imperative
  `useSharedValue` / `useAnimatedStyle` code is unchanged from v2/v3.
- v4 also ships a new **CSS-style animation API**, but this plan stays
  **imperative** for the morph: the keyboard-follow needs a shared value anyway,
  so one shared driver is simpler than mixing CSS transitions with it. The CSS
  API adds nothing here.

### Pre-step (shared prerequisite): enable the worklets babel plugin

Reanimated 4 runs animated styles / layout animations through **worklets**, which
need the `react-native-worklets/plugin` babel plugin, added **last**.
`apps/agent-mobile/babel.config.js` currently has no `plugins` array. Without it,
animated styles and `entering`/`exiting`/`layout` props throw at runtime.
Reanimated errors clearly if you use the old `react-native-reanimated/plugin`
name — use `react-native-worklets/plugin`.

- Add `plugins: ['react-native-worklets/plugin']` to `babel.config.js` (only
  plugin, so it is last). **Already done**: `babel.config.js` now is
  `babel-preset-expo` + the worklets plugin. There is **no styling babel preset**
  anymore — the app moved from NativeWind to Uniwind, which is a Metro transform
  and needs no Babel preset (an earlier version of this note referenced
  `jsxImportSource: 'nativewind'` + `nativewind/babel`, which are gone).
- Config change ⇒ needs `expo start --clear` (fresh Metro cache), like the
  Metro/Uniwind cache gotcha recorded in the README.
- **No new EAS build expected**: reanimated + worklets native modules autolink
  from `package.json` and were present when dev build 11 was cut. **Verify on
  device**: if animations crash or no-op after `--clear`, the native module is
  missing from the installed client and a new
  `eas build -p android --profile development` is required. Flag this before
  assuming JS-only.

### Jest setup

Tests will now render Animated components. Use reanimated's shipped mock so
worklets and layout animations don't error under jest-expo:

- In `jest.setup.js` add
  `jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'))`
  (the standard, documented mock; disables real animation, makes `Animated.View`
  a passthrough). Try it first; fall back to `require('react-native-reanimated')
  .setUpTests?.()` if the mock fights jest-expo's transform.
- The existing keyboard-controller mock already returns
  `useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: {
  value: 0 } })`, so keyboard-driven styles read a static 0 in tests. Tests
  assert presence + interactions, not motion.

### Accessibility (cheap, modern-correct)

Reanimated layout animations default to `ReduceMotion.System` (auto-respect the
OS reduced-motion setting). Add a `<ReducedMotionConfig />` at the app root (in
`_layout.tsx`) so both animations degrade to instant when the user asks. Optional
`useReducedMotion()` branch for the imperative morph if it doesn't honor System
automatically.

### Sequencing (two independent PRs)

Ship the fade-out first (simpler, lower risk, proves reanimated runs on device),
then the morph. The babel pre-step + jest mock + `ReducedMotionConfig` land with
whichever PR goes first; the second just uses them.

### Increment A: done-item fade-out

Wrap each todo row in `Animated.View` from `react-native-reanimated` with:
- `exiting={FadeOut.duration(200)}` so the removed row fades as reanimated defers
  its unmount.
- `layout={LinearTransition.duration(200)}` on the rows so siblings slide up to
  fill the gap (a bare `FadeOut` leaves the gap and snaps). Software Mansion
  "List Layout Animations" docs; cross-platform Android/iOS/web.
- Optional `entering={FadeIn}` so the error-path re-insert reappears smoothly.
- Keep the stable `key={item.id}` (reanimated needs it to track the leaving row).

Keep the mapped **ScrollView** (the project chose it over FlatList deliberately,
per increment-1 learnings, to avoid VirtualizedList act noise). The
`Animated.FlatList` + `itemLayoutAnimation={LinearTransition}` path is cleaner
for long lists — revisit only if the list grows.

`onDone` is unchanged: the optimistic `filter` triggers `exiting`; the error
re-insert triggers `entering`. No new state. If a plain `FadeOut` leaves a
visible height gap during the fade, upgrade to a custom exiting that animates
opacity **and** height to 0; start with `FadeOut` + `LinearTransition`.

Tests (`(signed-in)/__tests__/index.test.tsx`): the existing "tap done removes it
and calls markTodoDone" test must still pass (under the mock, `exiting` is a
no-op and the row unmounts immediately). No new test needed unless a helper
changes.

### Increment B: quick-add FAB ↔ bar morph

Replace the instant conditional swap with a single persistent Animated container
anchored to the bottom that always renders, driven by one shared `progress` value
(`0` = collapsed FAB, `1` = expanded bar).

- `const progress = useSharedValue(0)`; on open `progress.value = withTiming(1,
  { duration: ~220 })`, on close `withTiming(0)`. Keep the `adding` React state
  as the source of truth for mounting the `Input`, backdrop, and discard dialog;
  drive `progress` from an effect on `adding` (or set both together).
- One `useAnimatedStyle` interpolates the container between the two geometries:
  width 56 → screen width minus horizontal padding; borderRadius 28 → the bar's
  small radius; horizontal position bottom-right inset → full width (interpolate
  `right`/`left` or a `translateX`); the `+` glyph opacity 1 → 0 and rotate
  `0deg → 45deg` (the Reanimated blog's expandable-plus pattern); the `Input` +
  Add button opacity 0 → 1.
- **Keyboard sync**: translate the container up by the live keyboard height so it
  rises with the keyboard, using `useReanimatedKeyboardAnimation().height` in the
  same `useAnimatedStyle` (`translateY: -height.value`). This replaces
  `KeyboardStickyView` for the bar; keep `KeyboardProvider` at the root and the
  `KeyboardEvents` listener for the discard flow. (Note: reanimated's own
  `useAnimatedKeyboard` is deprecated in favor of keyboard-controller, which the
  app already uses.) Fallback: if a hand-rolled translate misaligns on Android
  edge-to-edge (the known inset trap), keep `KeyboardStickyView` wrapping an
  animated width/radius/glyph morph and only animate the shape, not the rise.
- The `Input` keeps `autoFocus`, `blurOnSubmit={false}`, `returnKeyType="done"`,
  and the `onSubmitEditing` → `onAdd` wiring so rapid capture still works.
- Backdrop `Pressable` (dismiss) and the `ConfirmDialog` stay mounted while
  `adding`, exactly as now; only their container's entrance is animated.
  `requestClose`, `closeAdd`, the `keyboardDidHide` listener, and the
  `hardwareBackPress` handler are unchanged — they gate on `adding` + trimmed
  text, which the morph does not touch.
- Because the container always renders, guard the FAB's tap: collapsed it opens
  (`setAdding(true)`); expanded the `+` is faded out and non-interactive (the
  Add-button role takes over). Keep both accessibility labels ("Add todo").

Tests (`fab.test.tsx`, `(signed-in)/__tests__/index.test.tsx`): under the mock,
animated styles are static, so the existing flow tests (tap FAB → bar with input;
backdrop tap → discard/close; rapid capture) must still pass against the
always-mounted structure. Adjust queries if the nesting changes; assert the same
behaviors. Do not assert interpolated style values.

### Verification (this box: no workerd, no emulator)

- `pnpm --filter @zero/agent-mobile test | typecheck | lint`, then
  `expo export --platform android` (bundles locally; catches worklets/reanimated
  and Uniwind resolve errors).
- Device: reload over Metro with `expo start --dev-client --clear`. Confirm
  (A) marking done fades the row and rows below slide up; (B) tapping `+` morphs
  it into the bar rising on the keyboard, and dismiss collapses it back to the
  FAB. Pure JS + babel config ⇒ **no deploy, no new EAS build expected** — but
  re-confirm the reanimated native module is in the client (see pre-step); if
  not, cut a dev build.

### Docs / changelog

- No `apps/agent-api/CHANGELOG.md` entry: the mobile todo app is a separate
  surface (routing rule at the top of this doc). Instead, on completion mark the
  two "UI polish backlog" bullets DONE with commits, and record the
  worklets-babel-plugin gotcha + whether a new EAS build was needed.

### Skills to use

- development-guidelines — throughout.
- react-testing / front-end-testing — the screen + FAB tests under the mock.
- tdd — light (mostly visual); keep existing behavior tests green as the guard.
- typescript-strict — shared-value / animated-style typing.
- git-commit — commits. open-pr — the two PRs.

### Acceptance criteria

- Worklets babel plugin wired; reanimated animations run on device (no crash, no
  no-op).
- Done: tapping the circle fades + collapses the row and rows below slide up;
  still removed and still `markTodoDone`-called; error path restores the row.
- Quick-add: `+` FAB morphs into the full-width bar and back, the bar rises with
  the keyboard; rapid capture, backdrop dismiss, discard-confirm, and
  back-button behavior all unchanged.
- Reduced-motion setting degrades both to instant.
- All mobile checks green; `expo export` bundles.

### Risks

- Native module not in dev build 11 → animations crash/no-op; verify on device,
  cut a new EAS dev build if needed.
- Morph + keyboard-sync jank on Android edge-to-edge (same class as the earlier
  KeyboardAvoidingView inset bug); mitigate with the `KeyboardStickyView`
  fallback above.
- jest reanimated integration with jest-expo; mitigate with the shipped mock.
