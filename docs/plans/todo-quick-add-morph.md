# Mobile quick-add FAB-to-bar morph

Status: implemented. The completed Task row-removal animation is not part of
this plan.

## Goal

On mobile, make the circular quick-add FAB expand into the full-width quick-add
bar and collapse back into the FAB. The bar must continue to rise with the
keyboard. When Android Back starts hiding the keyboard, the bar must collapse
in the same interaction.

## Current context

- [`quick-add-composer.tsx`](../../apps/agent-mobile/src/components/quick-add-composer.tsx)
  owns the collapsed `Fab`, while
  [`task-editor-sheet.tsx`](../../apps/agent-mobile/src/components/task-editor-sheet.tsx)
  owns the inline expanded editor and its container transform. The older
  `quick-add.tsx`/`QuickAddBar` pair is not mounted by the current app.
- `KeyboardStickyView` keeps the open bar aligned with the keyboard under
  Android edge-to-edge insets. Preserve that proven boundary unless an on-device
  replacement is equally reliable.
- Reanimated 4, the worklets Babel plugin, the Jest animation mock, and
  system reduced-motion configuration are already installed and in use.
- Task row removal and sibling layout animation already ship through
  `ReorderableTaskList`; do not reimplement them here.

## Behavior to preserve

- The FAB opens quick-add and the input receives focus.
- Keyboard submit and the add action create through the existing caller-owned
  flow.
- Rapid repeated entry, Task/Project modes, date and Project chips, and busy
  state keep their current behavior.
- Android Back and keyboard dismissal close an empty quick-add bar together.
  A non-empty draft keeps the bar open behind the discard confirmation.
- The expanded bar stays flush with the keyboard and the collapsed FAB retains
  its current screen and tab-bar insets.
- Accessibility labels and focus order remain correct. System reduced-motion
  preference produces an immediate or minimal transition.

## Acceptance criteria

- Opening visibly transforms the FAB into the bar rather than replacing it with
  an unrelated cross-fade; closing reverses the transition.
- Position, size, radius, and relevant content opacity move as one coherent
  transition without a flash, duplicate actionable controls, or touch-through.
- The transition remains smooth during keyboard entrance and dismissal on the
  supported Pixel development device.
- One Android Back press closes both the keyboard and an empty quick-add bar.
- Every preserved behavior above remains covered by focused interaction tests
  through the public quick-add or screen interface. Tests assert behavior, not
  animation frame values.
- The mobile changelog records the user-visible polish when it ships.

## Risks

- A persistent shared shell can leave hidden controls accessible or clickable;
  inactive content must also be non-interactive and hidden from accessibility.
- Animating geometry while `KeyboardStickyView` moves the open state can produce
  a jump or double translation on Android edge-to-edge layouts.
- Input mount timing can race autofocus and keyboard animation.
- Reanimated's test mock cannot prove timing or visual continuity; device
  inspection remains necessary.

## Verification

1. Run focused quick-add and Home interaction tests.
2. Run mobile tests, lint, typecheck, and an Android export.
3. Run `gob run bin/ci`.
4. Stop competing Metro and Gradle processes, then run
   `pnpm --filter @zero/agent-mobile e2e:pixel` on `mini` for behavioral
   regression coverage. Do not install the preview APK on the development-client
   Pixel.
5. On the same Pixel, inspect open, close, keyboard movement, reduced motion,
   rapid submit, discard confirmation, and Android Back. Record any visual-only
   criterion that cannot be asserted by Maestro.
