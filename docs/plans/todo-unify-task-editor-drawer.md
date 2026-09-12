# Unified task create and edit drawer

## Goal and agreed behavior

The mobile todo app uses one bottom-drawer presentation for task creation and
editing. Both show date and project chips. A selected project supplies its own
icon; there is no additional folder glyph or calendar glyph. Unset chips read
“No date” and “No project”. Chips remain visible even when unset.

Creation autofocuses, submits explicitly, and confirms before discarding text.
Editing opens without the keyboard, saves text on dismissal, and applies date
and project changes immediately. The completion circle remains edit-only.

Home retains Task/Project create modes. A project's screen retains Task/Waiting
modes and presets the project chip to its own project, still changeable. Other
create modes hide task metadata. Both drawers use the existing scrim token.
Hiding the keyboard does not dismiss a creation draft.

## Implementation decisions

- `apps/agent-mobile/src/components/task-editor-sheet.tsx` owns the shared RN
  Modal, keyboard docking, text field, chips and create-mode pills. Existing RN
  fields stay in an RN tree; no native package or build dependency changes.
- `useQuickAdd` and `useTaskDetail` retain distinct persistence lifecycles.
  Presentation is shared without forcing creation's three write paths into the
  existing-task controller.
- The discard dialog renders inside the Modal, above its panel. Android Back
  cancels that dialog before attempting to dismiss the drawer.
- Creation focuses again in Modal `onShow`: on the Pixel, initial input autofocus
  alone focused the field before its window could open the keyboard.
- Chips have 48dp targets, wrap on narrow widths, and truncate long project names.
  Long titles have a bounded scrolling input. There is no decorative drag handle
  suggesting an unimplemented swipe gesture.
- Home/project-screen bottom-gap measurement and the keyboard-hide race timer
  are removed. The Projects list still uses its project-only `QuickAdd` bar;
  that surface and its tests are retained.
- Empty submit resets the draft's metadata as well as closing the drawer.

Dependencies: local React state and label resolution are in-process. Native
Modal/keyboard behavior requires physical-device verification. Persistence uses
existing owned task/project/wait interfaces; no new transport seam is introduced.
Tests exercise the shared presentation and existing screen interfaces.

## Out of scope

Web, backend schemas, task visibility rules, structured waiting conditions,
Projects-list creation, and new drag-to-dismiss gestures are unchanged. Existing
edit behavior still closes the drawer when a move/reschedule removes the task
from the caller's visible list.

## Checks and acceptance

- Mobile Jest suite, lint and typecheck must pass.
- Create and edit use the same drawer and chips; the project icon appears once.
- Date/project picker round trips preserve the creation draft.
- All existing create modes, project presets, toasts and completion Undo work.
- Keyboard-up creation and keyboard-down editing work on the Pixel 7.
- Discard dialog is visible above the drawer; Back cancels it.
- Mobile changelog and `docs/todo-app.md` accompany the code.

### Physical-device evidence, 2026-09-12

Verified on the USB Pixel 7 using the development client and headless Metro:

1. From Home, created throwaway project `Drawer QA 0912`, after switching from
   a task draft with a picked date to Project mode.
2. Verified keyboard hide preserves text, discard confirmation appears, Back
   cancels confirmation, and Discard closes the draft.
3. On the throwaway project's screen, created `Verify shared drawer` with Today,
   renamed it to `Verified shared drawer`, then rescheduled it to Tomorrow.
4. Added throwaway free-text waiting condition `QA response`.
5. From Upcoming, cleared and restored the task's project, reopening between
   writes, then completed and restored the task through Undo.
6. Deleted the throwaway project and verified its task disappeared from Upcoming.
   No existing user entities were mutated.

The initial device pass exposed the Modal autofocus issue; the corrected drawer
opened the keyboard and docked above it. Screenshots captured create and edit.

Whole-repo `gob run bin/ci` was attempted and stopped during concurrent lint to
avoid memory contention on mini. Package checks are the local verification;
whole-repo CI has not completed. The documented workerd restriction still applies.

## Skills

- `vocabulary`, `deep-modules`: choose the shared presentation seam and keep
  persistence differences explicit.
- `documentation`, `changelog`: record behavior and verification with the code.
- `testing`: assertions through the drawer and screen interfaces.
- `expo-overview`, `expo-ui`, `impeccable`: preserve existing native presentation,
  accessible targets, and keyboard behavior; verify on the real device.
