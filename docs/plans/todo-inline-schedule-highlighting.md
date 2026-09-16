# Todoist-style inline schedule highlighting in task quick-add

## Goal

Make every task quick-add that already recognizes natural-language schedules show the exact recognized phrase on a compact colored background inline, while the user is still editing. For example, in `Stand up every day`, only `every day` is highlighted; the schedule row continues to show `every day`, and saving still stores `Stand up` as the title plus the normalized recurrence.

Apply the treatment to both recurrence phrases and one-time dates. The existing parser returns the same consumed-range interface for `every day` and `tomorrow`, and both phrases are removed from the saved title today. Highlighting only recurrence would leave the same invisible behavior for one-time dates.

This is a presentation change over the existing parser and task-creation flow. It does not change recurrence grammar, persisted Task data, collection commands, or server routes.

## Current state and decisions

- `@zeroapps/recurrence.parseSchedule()` returns the cleaned title, normalized schedule, and consumed UTF-16 ranges as `{ start, end, text }`. Its context accepts dismissed ranges: masking the active rightmost phrase makes the previous candidate in the same title active without shifting offsets. The UI must use this interface directly; it must not search for phrases or duplicate candidate ordering.
- Mobile task creation runs through the shared `useQuickAdd` module and `TaskEditorSheet`, so one mobile implementation covers Home and project-screen task adds.
- Web Home parses schedules in `HomePage`; its plain `<Input>` cannot style part of a value.
- Web project-detail task add does not parse schedules today. Adding schedule parsing there is a separate parity change and is out of scope for this visual increment.
- Native and browser text inputs do not support arbitrary substring styles. Use an aria-hidden/accessibility-hidden mirrored text layer under a transparent native input. The real input remains the only editable, focusable, selectable, and announced control.
- Keep the existing date/repeat row and its “Keep schedule words in task title” action. The inline highlight becomes the immediate visual explanation and supports Todoist-style tap/click dismissal; the existing action remains the explicit keyboard and screen-reader fallback.
- Add semantic `schedule-highlight` and `on-schedule-highlight` colors to each app's existing token system. Badge text must have at least 4.5:1 contrast against its background in light and dark modes. Do not reuse the destructive role or add raw colors in screen modules.
- The mirror is a platform adapter, not a new shared cross-app UI module. Web and React Native have different layout, scrolling, selection, and accessibility mechanics. The parser's consumed-range interface is the seam they share.

Todoist's documented behavior is the reference: Quick Add highlights recognized one-time and recurring dates, and clicking or tapping the highlighted phrase disregards the recognition while retaining those words in the title.

## Technical approach

### 1. Make consumed ranges a protected parser contract

Strengthen `packages/recurrence/src/index.test.ts` around the existing `parseSchedule` interface:

- assert exact `start` and `end` offsets, not only the consumed text;
- cover a recurrence at the end of a title, a one-time date in the middle with unparsed time words after it, and an emoji before the range to prove UTF-16 slicing stays aligned;
- retain the current rightmost/maximal schedule behavior and the rule that unsupported time text is not highlighted.

Extend the parser context with optional ignored `TextRange[]`. Mask those ranges with equal-length spaces before candidate selection, then restore consumed text and `remainingText` from the original title so UTF-16 offsets and saved words stay exact.

### 2. Web Home renders one editable input with a synchronized highlight mirror

Add a focused web module under `apps/agent-web/src/components/` that owns the complete marked-input mechanism behind an input-like interface:

- accept the full draft, parser-provided consumed ranges, normal input props, a forwarded `HTMLInputElement` ref, and an `onDismissRange` callback;
- render an `aria-hidden` mirror with ordinary and highlighted spans, then place the real input above it with transparent glyphs and an explicit visible caret;
- match the existing input's font, line height, padding, border, and width exactly;
- synchronize the mirror's horizontal offset with the native input's `scrollLeft`, so long titles do not drift;
- leave placeholder rendering to the native input when the value is empty;
- on pointer release, read the native collapsed selection and dismiss recognition only when the caret lands inside a consumed range; retain focus and the caret position;
- preserve native typing, selection, copy/paste, undo, keyboard submission, and IME composition because the real `<input>` remains unchanged.

Wire `HomePage`'s `parsedSchedule.consumed` into this module. Dismissal appends that range to state tied to the exact draft, then calls `parseSchedule` with those ignored ranges. The clicked phrase becomes ordinary title text and the previous rightmost candidate becomes active; only after every candidate is dismissed does the schedule row return to its manual value. Any text edit clears the ignored ranges. Do not create parse or candidate-order logic inside the input module.

### 3. The shared mobile task drawer renders a Pixel-safe highlight mirror

Add a React Native counterpart under `apps/agent-mobile/src/components/` and expose it through a small optional marked-input interface on `TaskEditorSheet`:

- `TaskEditorSheet` receives consumed ranges and an inline-dismiss callback only for quick-add; task editing continues to use the ordinary `Input` path;
- the marked-input module forwards the real `TextInput` ref and ordinary input props so autofocus, keyboard submission, multiline growth, and discard-dialog refocus remain unchanged;
- keep the transparent `TextInput` in normal layout flow, place a pointer-inert/accessibility-hidden nested `Text` mirror behind it, and render slices from the parser's UTF-16 offsets;
- use the same editor typography, line height, width, padding, and Android `textAlignVertical` on both layers;
- synchronize vertical scroll once the multiline field reaches its existing maximum height;
- set cursor and selection colors explicitly while glyphs are transparent;
- detect a touch landing inside a consumed range from the real input's touch and selection events, then invoke the existing `setIgnoredScheduleText(text)` path without changing the draft or dropping keyboard focus;
- render no duplicate accessibility node: assistive technology must encounter one textbox with the full unmodified draft.

Pass ranges only when `useQuickAdd` is in Task mode and `parseSchedule` returns `scheduled`. Project and waiting modes remain plain text. Mobile Home and project detail inherit the behavior from the same `useQuickAdd` interface.

Do not add a rich-text dependency or native module in this increment. If the mirrored implementation cannot keep wrapping, caret position, selection, IME input, and scrolling aligned on the physical Pixel 7, stop and re-plan a native attributed-text adapter instead of shipping a fragile overlay.

### 4. Tests, documentation, and release notes describe the shipped behavior

Add tests at the interfaces users exercise:

- **Recurrence package:** exact consumed UTF-16 offsets for recurrence, one-time date, suffix text, and emoji-prefix cases.
- **Web marked input:** correct plain/highlight slices; one accessible textbox with the original value; no duplicate accessible text; forwarded ref and submit behavior; horizontal scroll synchronization; click-to-dismiss only inside a consumed range.
- **Web Home:** `Stand up every day` highlights only `every day`, keeps the canonical repeat summary, and saves `Stand up`; in `Work today tomorrow`, dismissing `tomorrow` highlights `today`, preserves `tomorrow` as title text, and saves the task for today.
- **Mobile marked input / `TaskEditorSheet`:** correct slices, one accessible textbox, ref/autofocus/submit preservation, tap-to-dismiss, and plain rendering when no range exists.
- **Mobile Home:** recurring and one-time drafts pass the parser ranges into the shared drawer; project mode does not highlight schedule-like words. The shared controller makes a separate project-screen parsing test unnecessary unless wiring diverges.

Update user-facing documentation in the same change:

- add one entry to `apps/agent-mobile/CHANGELOG.md` and one to `apps/agent-web/CHANGELOG.md` stating that recognized dates and repeats are now highlighted as users type and can be kept as title text;
- update the UI behavior in `docs/entities/task.md`, the Task source of truth;
- update the shipped recurring-task item in `docs/todo-app.md` after device proof, without duplicating parser details already owned by `packages/recurrence/README.md`.

No package README, storage document, migration, route documentation, workflow path, or deployment-watch change is needed. The parser already documents consumed ranges, and the existing mobile workflows already watch `apps/agent-mobile` and `packages/recurrence`.

## Verification

Run the repository-prescribed check first with `gob run bin/ci`. On this NixOS host, record the documented `workerd` failure if it reaches untouched Worker checks, then run the touched packages directly:

```bash
pnpm --filter @zeroapps/recurrence run test
pnpm --filter @zeroapps/recurrence run lint
pnpm --filter @zeroapps/recurrence run typecheck
pnpm --filter @zero/agent-web run test
pnpm --filter @zero/agent-web run lint
pnpm --filter @zero/agent-web run typecheck
pnpm --filter @zero/agent-web run build
pnpm --filter @zero/agent-mobile run test
pnpm --filter @zero/agent-mobile run lint
pnpm --filter @zero/agent-mobile run typecheck
pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-inline-schedule-highlight
```

A mobile UI change is complete only after physical Pixel 7 verification through the installed development client and headless Metro:

1. Create a throwaway draft `ZZ highlight every day`; confirm only `every day` is highlighted inline and the schedule row reads `every day`.
2. Edit before, inside, and after the phrase; confirm the caret, selection, keyboard, and mirror stay aligned.
3. Use a long draft that wraps the phrase across a line and reaches the field's scroll limit; confirm no doubled or drifting glyphs.
4. Type `Work today tomorrow`; confirm `tomorrow` has the colored background, tap it, then confirm `today` receives the background, the schedule row changes to Today, `tomorrow` remains ordinary text, and focus stays in the input.
5. Submit that draft and confirm the task is scheduled Today with `Work tomorrow` as its title. Create a second throwaway recurring task without dismissing recognition; confirm the saved title excludes the phrase and the recurrence summary persists.
6. Repeat the visual check in light and dark appearance and capture a screenshot that shows the inline highlight.
7. Complete the ordinary throwaway task and Complete forever on the recurring throwaway task. Do not edit or complete any existing production entity.

The implementation is JavaScript/CSS-only and should hot-reload through the existing development client. It must not trigger a native rebuild.

## Out of scope

- New recurrence or one-time date grammar.
- Time-of-day parsing, reminders, deadlines, labels, priorities, or non-English parsing.
- Adding natural-language parsing to the web project-detail add form.
- Natural-language parsing while editing an existing Task.
- A global smart-date-recognition setting.
- Replacing the existing schedule row or its explicit unrecognize action.
- Task persistence, completion, Undo, API, migration, or collection changes.
- A native rich-text dependency unless Pixel verification proves the mirrored input is not viable; that result requires a new plan.

## Skills to use during implementation

- **tdd** — add consumed-range and input-interface regressions before each adapter implementation.
- **testing** — keep assertions at the parser and marked-input interfaces, then add one integration test per surface.
- **deep-modules** — keep parsing behind `parseSchedule` and hide all mirror, scroll, caret, and touch mechanics inside each marked-input module.
- **expo-overview** — apply the Expo SDK 57 shared setup and physical-device rules before mobile work.
- **expo-native-ui** — preserve native `TextInput` editing, accessibility, and platform behavior.
- **expo-design-system** — add the schedule-highlight semantic token to the existing Uniwind system instead of introducing local colors.
- **changelog** — write the mobile and web release-note entries in the required user-facing format.
- **reproducible-locally** — turn the browser/unit and Pixel checks above into repeatable proof.
- **git-commit** — commit code, tests, documentation, and both changelog entries together.

## Acceptance criteria

- Mobile Home, mobile project quick-add, and web Home highlight exactly the parser-consumed part of one-time and recurring task drafts inline.
- The original draft remains one native, editable textbox with working caret, selection, paste, undo, IME composition, keyboard submit, wrapping, and scrolling.
- `Call Ana tomorrow at 3pm` highlights only `tomorrow`; `at 3pm` remains ordinary title text and survives submission.
- The active range uses a compact semantic background with contrasting text, matching the supplied Todoist reference.
- Clicking or tapping the active range keeps that phrase as title text without dropping focus and moves recognition to the previous candidate in the same draft; the existing explicit unrecognize action follows the same rule.
- Recognized submission stores the cleaned title and current parsed schedule exactly as before. Dismissed phrases remain in the title; no parsed schedule remains only after every candidate is dismissed.
- Project/waiting add modes and existing-task editing never highlight schedule-like words.
- Badge colors come from semantic tokens, and badge text meets 4.5:1 contrast against its background in light and dark modes.
- Assistive technology sees one textbox and the existing labeled unrecognize action, not the mirrored text.
- Recurrence, web, and mobile package checks pass; the Android bundle export passes; Pixel 7 light/dark, wrapping, edit, dismissal, save, and cleanup scenarios pass with screenshot evidence.
- Mobile and web changelogs plus Task/project documentation ship in the same change.
