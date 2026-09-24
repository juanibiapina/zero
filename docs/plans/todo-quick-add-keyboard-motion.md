# Quick-add drawer opens with the keyboard

## Goal

Pressing the + button on the mobile todo app should reveal the create drawer and bring up the keyboard as one perceived action. The drawer should stay attached to the keyboard throughout its motion, without a separate full-screen slide followed by keyboard entry. Prefer a reliable, quiet transition over a literal Todoist-style button-to-drawer morph.

## Current behavior and constraints

- `apps/agent-mobile` uses Expo SDK 57, React Native 0.86, Reanimated 4, and `react-native-keyboard-controller`; its root already mounts `KeyboardProvider`. No new dependency or native build should be necessary for the first approach.
- `useQuickAdd` in `src/components/quick-add-composer.tsx` owns drafts, submit, discard confirmation, pickers, and Back behavior across Home and Projects. It renders a `Fab` and the shared `TaskEditorSheet`. `useProjectAdd` also invokes this drawer on project screens. `TaskEditorSheet` is shared with task editing, where the keyboard deliberately stays closed on open.
- The sheet uses a transparent React Native `Modal` with `animationType="slide"`, then focuses the create field via `onShow`. Its `refocusAfterPresentation` helper adds a 100 ms settle and 50 ms focus gap because Android previously focused a field without showing the keyboard. `KeyboardStickyView` already follows the keyboard; `keyboardDidShow`/`keyboardDidHide` currently only bound the scroll area's maximum height.
- The separate `quick-add.tsx` / `quick-add-bar.tsx` transition is not the path used by the current Home/Projects create drawer. Do not tune that unused crossfade for this task.
- The Modal also contains the discard dialog. Replacing it with an in-tree overlay risks regressing keyboard docking, picker stacking, and Back/discard behavior. `@expo/ui` BottomSheet is not a keyboard-attached quick-add replacement here, as the mobile README documents.

## Change

1. **Make create presentation keyboard-first.** In `TaskEditorSheet`, give the keyboard-opening create path no native Modal slide. Keep the existing slide for task editing and for a no-keyboard create path such as After; select this when opening rather than changing native presentation behavior in the middle of a mode switch. Leave `KeyboardStickyView` in charge of docking. Avoid any extra delayed entrance animation: the keyboard lifting the same surface is the visible motion. The FAB disappears as the drawer appears; do not add a separate full-screen transition or a fake shared-element morph across Modal windows.
2. **Start keyboard opening at presentation, not after a settled slide.** Focus the field as soon as the Modal can own it (`onShow`), with one focus request per opening. Avoid combining TextInput `autoFocus` with a routine blur/refocus that flaps the IME. Preserve the Android recovery path only if immediate focus fails to show the keyboard, and cancel any pending retry when the drawer closes or changes to a no-input mode. Keep edit mode unfocused, focus when switching from After into a text-entry mode, and preserve focus restoration after canceling discard. If Android still cannot show the keyboard promptly and reliably from this Modal, stop and use an in-tree keyboard-sticky create surface rather than shipping a timer-dependent sequential entrance; keep the same `useQuickAdd` interface and write logic.
3. **Prove behavior without changing task semantics.** Extend `task-editor-sheet` and, if changed, `lib/keyboard` tests for create/edit/no-input presentation, one initial focus, and cancellation of a delayed recovery focus. Add or update a behavior-named flow under `.maestro/hermetic/` that opens the + drawer, finds the input with the keyboard present, adds a task, reopens it, and dismisses it with Back. Preserve the existing submit, discard-confirm, picker, and project-screen flows.
4. **Document the user-visible fix in the same change.** Add one user-facing bullet at the top of `apps/agent-mobile/CHANGELOG.md` using the date of implementation; do not add it to the agent changelog. Update `docs/todo-app.md` only if its recorded drawer/presentation decision changes. Do not duplicate implementation details in the README unless its UI-stack explanation becomes false.

## Out of scope

A pixel-matched Todoist shared-element morph, a new sheet library, native configuration changes, refactoring the unused `QuickAdd` transition, and redesigning task edit or metadata pickers. The real + button lives outside a separate Modal window, so a literal morph would cost substantially more code and is unnecessary for a smooth quick-add.

## Verification and acceptance

- On a Pixel 7 development client, capture or inspect an opening at normal and reduced-motion settings: no completed drawer slide precedes keyboard entry; the drawer tracks the keyboard without a visible jump or second independent travel. If possible compare a 60 fps recording before/after and aim for the first keyboard movement within ~150 ms of drawer appearance. Repeat several times after cold launch, after Back, and after returning from a metadata picker. Validate a project-screen + as well as Home and Projects-list +.
- Confirm editing opens without the keyboard, After mode does not request one, a hardware keyboard does not hide the input, and rapid open/close does not summon a late keyboard. Confirm discard, submission, Back, safe-area alignment, large text, and both light/dark appearance remain intact. Feel/jank needs device inspection; Maestro assertions alone cannot prove animation timing. Judge final smoothness on a release-mode install on the slowest available device when one is available; treat development-client timing as provisional.
- Run focused Jest tests, lint, and typecheck for `@zero/agent-mobile`, then `pnpm --filter @zero/agent-mobile e2e:pixel`. Run `gob run bin/ci` as the repository check; on this NixOS host its whole-repo worker/e2e stage cannot start host `workerd`, so report that limitation and rely on the package checks plus the Pixel harness. Stop Metro and local Gradle before checks on the 2-CPU host.

## Skills to use

- `expo-overview` and `expo-animation` — use SDK-aware keyboard-motion and reduced-motion guidance while implementing and checking on a device.
- `expo-ui` — check native alternatives before changing the sheet; retain this keyboard-attached surface unless a native control demonstrably supports it.
- `testing` — assert observable create/edit/focus behavior instead of animation internals.
- `changelog` — load before writing the mobile changelog entry.
- `documentation` and `vocabulary` — keep any updated decision record concise and use one source of truth.
