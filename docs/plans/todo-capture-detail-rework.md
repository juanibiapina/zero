# Rework the Captures detail: a clean, Todoist-shaped sheet

Tapping a Capture's text opens a bottom sheet whose body is a plain text box, a
big filled **Done** button, and a big outlined **Refine into tasks & projects**
button (`CaptureDetail` in `apps/agent-mobile/src/app/(signed-in)/index.tsx`).
It reads as unfinished, it has no completion or scheduling affordance, and its
**Done** label is ambiguous — it means "save and close," not "complete." This
plan redesigns that sheet into a clean, Todoist-shaped detail, keeping it a
bottom sheet and a **pure `@expo/ui` native tree**. Mobile only; no backend,
data-model, API, store, or shared-collection change.

## As built (2026-09-11) — supersedes the `@expo/ui` decisions below

The plan below assumed the detail sheet would stay a **pure `@expo/ui` tree**.
That was tried and **abandoned**: `@expo/ui`'s narrow style API (no `flex`/`gap`),
its widgets' built-in Material padding/centering, and its style→native mapping
(a bordered container rendered as a filled disc; a text button used Material's
accent, not our token) made a clean, on-brand layout impossible — the same wall
`todo-project-detail-rework.md` hit. What shipped:

- **The detail is a plain React Native bottom sheet** (an RN `Modal` + scrim + a
  keyboard-docked bottom panel via `KeyboardStickyView`), not `@expo/ui`. It
  reuses the app's own `CheckCircle` (the real hollow radio) and `Input`, with
  hairline `bg-divider` rows on a `bg-surface` panel — matching the new-task
  quick-add drawer exactly (`bg-surface`, `rounded-t-2xl`, `shadow-raised`).
- **The scheduler** is a second RN `Modal` (quick options + inline month grid +
  No date), rendered above the detail sheet.
- **No autofocus** — the sheet opens clean; tap the title to edit.
- **Drag-to-full-height was dropped** with `@expo/ui` (the native `BottomSheet`
  provided it). For this short content it has little value; a draggable RN sheet
  is a possible follow-up. The shared `Sheet` wrapper's `snapPoints` prop was
  reverted.

Everything else (verbs, date helpers, scheduler behaviour, no backend change,
device verification) matches the plan. Read the sections below for rationale, but
treat this block as the source of truth on the container and styling.

## Bottom line

1. **Keep it a bottom sheet — a Capture is a single leaf item.** The research
   (NN/g, Material 3, Apple HIG) says a sheet is right for a short, single-item
   interaction; a full screen is for a container you dwell inside. The sibling
   `todo-project-detail-rework.md` moved the *project* (a container) to its own
   screen and explicitly ruled: **"The Captures detail (a single leaf item)
   correctly stays a sheet."** We improve the sheet, we do not move it.
2. **Schedule is one row that opens a custom scheduler — the Todoist pattern.**
   In Todoist the detail shows a single schedule row with the current value
   (e.g. "Today"); tapping it opens a scheduler surface: **quick-option rows**
   (each an icon + label + the *resolved weekday* on the right, e.g. "Tomorrow ·
   Fri"), an **inline month calendar** (selected day accent-filled, today
   marked), and a **No date** row. The resting sheet shows only the one row; the
   options and calendar live in the selector (the earlier inline-chips mock was
   rejected as cluttered). The selector is a **plain React Native modal** (the
   `IconPickerSheet` pattern in `projects/[id].tsx`: a `Modal` + scrim +
   bottom-anchored panel), **not** an `@expo/ui` tree and **not** the OS date
   dialog — so it can reproduce Todoist's layout, and it needs **no native
   module and no fresh dev-client build**. The month grid is a small
   dependency-free RN component (7-column `View` grid), not a calendar library.
3. **Separate zones by subtle background contrast, not hairlines.** Todoist's
   sheet is a slightly elevated surface, and its zones (title, schedule) read as
   softly grouped blocks with the darker app background showing in the gaps —
   no hard divider lines. We build the sheet the same way: a darker base
   (`--color-background`) with each zone a rounded `--color-surface` block, small
   gaps between. Depth comes from tone, not rules.
4. **Match the entity, not Todoist's full task.** A Capture is deliberately
   minimal — `text`, `showUpDate`, `sortKey`, `processedAt`
   (`docs/entities/capture.md`). No description, priority, labels, sub-tasks, or
   comments — so the sheet must not grow those rows. It borrows Todoist's
   *structure* (checkbox + editable title, the one-row schedule, subtle grouping)
   applied only to what a Capture has: its text, its schedule, and its next step.
5. **Kill the ambiguous "Done" button.** In a to-do app a prominent "Done" reads
   as "complete." Here it saved and closed. Todoist has no save button — a
   checkbox completes, edits persist on dismiss. We remove "Done": the checkbox
   means complete, dismissal means save (already the sheet's behaviour via
   `commitAndClose`).

## Why these decisions (research basis)

- **Bottom sheet vs. full screen.** Material 3: sheets show "supplementary
  content … without navigating to a new screen"; full screens are for "complex
  tasks / extended interaction." NN/g "Bottom Sheets": sheets are for "short
  interactions," not to "replace page-to-page flows." Apple HIG Modality: don't
  nest a hierarchy of views in a modal. A one-line Capture is a short
  interaction → sheet.
- **Todoist's task view (Jan 2026 redesign) + the reference screenshot.** The
  shape to borrow: **checkbox + bold editable title** at the top, then **each
  attribute on its own row** written out (accessible), with the **schedule row
  opening the scheduler on tap**. We adopt the checkbox+title header, the
  single tap-to-open schedule row, and the subtle background grouping. We drop
  Todoist's attribute chips (Description/Priority/Reminders/Labels) and sub-tasks
  and comments — a Capture has no data for them.

## Current state (verified)

- **The sheet body** — `CaptureDetail` in
  `apps/agent-mobile/src/app/(signed-in)/index.tsx`: an `@expo/ui` `Column`
  holding a `TextInput` seeded from the draft, a filled `Button` "Done"
  (`onDone` → `commitAndClose`), and an outlined `Button`
  "Refine into tasks & projects" (`onRefine` → `startRefine` + close). Rendered
  inside `@/components/ui/sheet` (the `@expo/ui` `BottomSheet` wrapper), keyed by
  `selected.id`.
- **Screen-level state (stays):** `selectedId` + `draft`, `openDetail`,
  `commitAndClose` (trims, writes only when non-empty and changed, then closes),
  and the `BackHandler` chain that dismisses the sheet first. Colours read via
  `useColor` (`@expo/ui` takes string colours, not classes).
- **Pure-`@expo/ui` constraint (load-bearing).** `todo-project-detail-rework.md`
  root cause: raw React Native rows inside the `@expo/ui` `BottomSheet` host do
  not lay out and render broken on device — and jest can't catch it (it mocks
  `@expo/ui` as RN passthroughs). This `CaptureDetail` is the one sheet that
  works because it is a pure `@expo/ui` tree. The redesign stays pure `@expo/ui`
  (universal `Column`, `Row`, `Spacer`, `Text`, `TextInput`, `Button`,
  `Checkbox`, `Icon`, plus `@expo/ui/community/datetimepicker`).
- **Verbs available (no backend change):** `edit(id, text)`, `process(id)`
  (GTD "complete" — removes from Captures), `unprocess(capture)` (undo),
  `reschedule(id, showUpDate|null)`, `reorder(id, sortKey)`
  (`packages/agent-core/src/captures/collection.ts`). **No `delete` verb** —
  Process is the removal path; do not invent one.
- **Date helpers** — `packages/agent-core/src/captures/dates.ts`:
  `capturesLocalToday`, `tomorrow`, `visibleCaptures` (loose `== null` rule).
  `today` and a `scheduleLabel` formatter are the additions this needs.
- **Row controls (unchanged):** circle = process, swipe-right = postpone to
  tomorrow, long-press = reorder, tap text = open this sheet.
- **Design tokens** (`apps/agent-mobile/global.css`, dark theme):
  `--color-background #1f1f1f`, `--color-surface #282828`,
  `--color-surface-muted #333`, `--color-foreground #f2f2f2`,
  `--color-foreground-secondary #b3b3b3`, `--color-accent #208aef`,
  `--color-checkbox #8f8f8f`, `--radius-dialog 28px`, `--text-title 26/700`,
  `--text-body 16/22`. The redesign reads these via `useColor`; it introduces no
  hex, size, or spacing literal beyond what a token names.
- **Sibling plan overlap** — this plan **delivers the date half of
  `captures-detail-sheet-scheduler-plan.md` Slice 4** (quick options + a calendar
  grid), relocated behind the schedule row rather than inline, built as a custom
  RN surface. The natural-language date fast-follow stays for later. Update that
  plan's status.

## The redesigned sheet

The detail sheet body stays a **pure `@expo/ui` tree** (the constraint above).
The scheduler it opens is a **plain React Native modal** (see Block 2). The two
are separate surfaces, so each uses the toolkit that fits it.

The sheet content is a `Column` on a `--color-background` base, holding two
softly-grouped `--color-surface` blocks (rounded `--radius-dialog`-scaled
corners) with a small gap of the darker base between them — subtle grouping by
tone, no divider lines.

**Block 1 — identity + next step:**
- A `Row`: a `Checkbox` (label `Complete "<text>"`) + a multiline `TextInput`
  seeded from the draft at title type size. Checking runs the same
  `undoableAction` process path the row circle uses (`process` + one bottom Undo
  that `unprocess`es), then closes. The editable title replaces the anonymous
  box; the checkbox replaces the ambiguous "Done."
- Below it, the **Refine** action as a single low-emphasis `Button`/row with a
  small accent glyph — "Refine into tasks & projects" (unchanged behaviour:
  starts the shared refine session, closes the sheet).

**Block 2 — schedule (one row, tap to open the selector):**
- A `Row`: a calendar `Icon` (accent) + a `Text` of the current schedule. When a
  date is set it reads `Today` / `Tomorrow` / a formatted date (`scheduleLabel`);
  **when none is set it reads "Schedule" in the accent colour — never "No
  date"** (the rejected resting label). A trailing `X` clears the date only when
  one is set.
- Tapping the row opens the **scheduler**, a plain RN modal (the `IconPickerSheet`
  pattern: `Modal` + scrim + bottom-anchored panel) titled "Schedule":
  - **Quick-option rows** — icon + label + the resolved weekday on the right:
    **Today** and **Tomorrow** (e.g. "Tomorrow · Fri"). No "Next week" (the user
    ruled it out); it can return later now that the resolved day removes the
    ambiguity — an opt-in, not a default.
  - An **inline month calendar** — a dependency-free 7-column RN grid; today is
    marked and the selected day is accent-filled; a small prev/next steps months.
  - A **No date** row at the bottom that clears the date.
  Picking a quick option or a calendar day calls `reschedule(id, <date>)`;
  **No date** and the resting-row trailing `X` call `reschedule(id, null)`. The
  scheduler carries **no free-text/natural-language field, no recurrence, and no
  time-of-day** (see Out of scope) — a Capture's `showUpDate` is a plain date.

No standalone Done button; edits save on any dismissal (Back, backdrop, native
dismiss, keyboard Done via `onSubmitEditing`) through `commitAndClose`.

**Draggable to full height (Todoist).** The sheet must be draggable from its
resting detent all the way up to full screen, like Todoist. Today the `Sheet`
wrapper (`apps/agent-mobile/src/components/ui/sheet.tsx`) omits `snapPoints`, so
the `@expo/ui` `BottomSheet` auto-sizes to content and cannot be dragged up. Give
the capture sheet `snapPoints` with a content-height resting detent and a `full`
detent (e.g. `['medium', 'full']` or `[{ fraction }, 'full']`) so the grip drags
it to the top. Add an **optional** `snapPoints` prop to the shared `Sheet` rather
than change it globally — Projects' short action/icon sheets keep the auto-size
default (they should not become draggable). Confirm the exact detent values
against the installed `@expo/ui@57.0.13` `BottomSheet` `.d.ts`.

Every control maps to an existing verb; the change is arrangement, affordances,
grouping, and clarity — not new data capability.

## What to change

- `apps/agent-mobile/src/app/(signed-in)/index.tsx` — rewrite the `CaptureDetail`
  body (pure `@expo/ui`) into the two-block layout above. Add a `ScheduleSheet`
  component — a plain RN `Modal` scheduler (quick-option rows + inline month grid
  + No date), modelled on `IconPickerSheet` in `projects/[id].tsx`. Pass new
  handlers from `Captures`: `onComplete` (runs the existing `undoableAction`
  process path, then closes) and `onReschedule(showUpDate | null)` (calls
  `api.reschedule`). Keep `key={selected.id}`, `draft`, `commitAndClose`, and the
  `BackHandler` order (add the scheduler to it so Back closes it first).
- **No new dependency and no native module** — the scheduler is plain RN and the
  month grid is hand-built, so there is **no fresh dev-client build gate**; the
  change is JS-only and testable through Metro on the installed client.
- `packages/agent-core/src/captures/dates.ts` — add `today()` beside
  `tomorrow()`, and `scheduleLabel(showUpDate, localToday)` → `"Schedule"` (empty),
  `"Today"`, `"Tomorrow"`, or a formatted date (loose `== null`). Unit-test both.
- `apps/agent-mobile/src/components/ui/sheet.tsx` — add an optional `snapPoints`
  prop passed straight to the `@expo/ui` `BottomSheet`; the capture sheet sets a
  content-height + `full` pair so it drags to the top. Omitting the prop keeps
  today's auto-size behaviour, so Projects' short sheets are untouched.
- Keep colours via `useColor`; keep the `BackHandler` chain.

## Out of scope

- **Full screen.** A Capture stays a sheet (research + the sibling plan's rule).
  No `/captures/[id]` route.
- **Natural-language / free-text date input** ("next thursday") — deferred for
  now (user's call); the scheduler ships quick options + calendar only. It is the
  fast-follow in `captures-detail-sheet-scheduler-plan.md`, on top of the same
  `reschedule` verb.
- **Recurrence** ("every friday", the "Every Fri" chip, repeating occurrences) —
  a separate feature (the other inbox item, "recurring tasks like todoist"), not
  this rework.
- **Time-of-day** ("Add time") — a Capture's `showUpDate` is a plain date with no
  time component; the scheduler sets a date only.
- **New Capture attributes** (description, priority, labels, sub-tasks, comments)
  — the entity is intentionally minimal.
- **A delete verb** — none exists; Process is removal. Adding one is a separate
  backend change.
- **Web parity.** The reported "ugly screen" is mobile; the web sheet (Radix,
  full styling freedom) is a noted adjacent follow-up, not this change.

## Tests

- **agent-core (unit):** `today` and `scheduleLabel` in
  `packages/agent-core/src/captures/dates.test.ts` — boundary days, the
  Today/Tomorrow labels, a formatted future date, and the loose `== null`
  "Schedule" (empty) case.
- **Mobile (jest):** extend
  `apps/agent-mobile/src/app/(signed-in)/__tests__/index.test.tsx` and the shared
  `@expo/ui` jest mock (add queryable `Checkbox` and the schedule row). The
  `ScheduleSheet` is plain RN, so it needs no `@expo/ui` mock — drive it
  directly. Assert: opening the sheet seeds the title; checking the box calls
  `process` and closes; opening the scheduler and choosing Today / Tomorrow / a
  calendar day calls `reschedule` with the expected value; No date and the
  resting-row `X` call `reschedule(null)`; Refine starts the session and closes;
  dismissal commits a changed, non-empty edit and is a no-op otherwise.
  Run with `--runInBand`. **Comment that the jest mock renders `@expo/ui` as RN
  passthroughs, so a green suite is not proof of the on-device layout — device
  verification is required.**
- **On-device (required, and the real proof this whole effort is about):** no
  fresh build needed (JS-only) — dev client + Metro + `adb reverse` on the
  attached Pixel 7 (user 0), driven by Maestro. Create a **throwaway** Capture,
  open it, confirm the two-block grouping reads cleanly, drag the sheet to full
  height, edit the title, open the scheduler and set Today / a calendar date /
  clear it (watch the list re-filter and confirm the RN scheduler renders above
  the `@expo/ui` sheet), complete via the checkbox + Undo, and start Refine. **Use only throwaway entities against production data and delete
  them when done** (`apps/agent-mobile/README.md`). Capture a screenshot as the
  artifact. This box has no workerd/emulator; verify touched packages directly
  (`pnpm --filter @zero/agent-core test`,
  `pnpm --filter @zero/agent-mobile test`, plus `lint`/`typecheck`).

## Documentation and changelog

- `docs/entities/capture.md` — the detail sheet now has a completion checkbox, an
  editable title, a one-row schedule that opens a Today/Tomorrow/calendar
  selector (quick options + calendar, no free-text/recurrence/time), and a Refine
  action; no Done button; empty schedule reads "Schedule."
- `docs/plans/captures-detail-sheet-scheduler-plan.md` — mark the date half of
  Slice 4 delivered here (quick options + calendar grid, custom RN), relocated
  behind the schedule row; the NL fast-follow remains.
- `docs/todo-app.md` — one tracking line that the Capture detail was redesigned
  with a date scheduler.
- Load the `changelog` skill, then add one user-facing bullet to
  `apps/agent-mobile/CHANGELOG.md` (NOT `apps/agent-api/CHANGELOG.md`): e.g.
  "The capture detail is cleaner — a complete checkbox, an editable title, and a
  schedule row that opens a Today / Tomorrow / calendar picker."

## Skills to use

- `impeccable` — this is a redesign; use it to shape the two-block grouping, the
  tone-based separation, the schedule row and its selector, type/spacing rhythm
  from the tokens, and the accent glyphs; run its detector once after the rework.
- `expo-ui` — confirm the universal `Checkbox`/`Icon`/`Row`/`TextInput`/`Button`
  and `BottomSheet` `snapPoints` props against the installed `@expo/ui@57.0.13`
  `.d.ts`; keep the sheet body a pure `@expo/ui` tree; check whether the
  universal layout components accept a background/rounding style (needed for the
  surface blocks) or require a platform modifier.
- `expo-animation` — keep the redesigned sheet, the RN scheduler modal, and the
  shipped swipe/reorder gestures on the row behind it coexisting cleanly.
- `deep-modules` / `vocabulary` — keep the schedule logic in the agent-core date
  seam (pure fns); the sheet stays presentation only.
- `testing` — extend the mobile behaviour test and the agent-core date tests
  through their interfaces.
- `changelog` — before editing the mobile changelog.
- `reproducible-locally` — collect package-test output and the Pixel/Maestro
  screenshot as evidence.
- `git-commit` / `open-pr` — commit the vertical slice on a branch (a push to
  `main` auto-deploys the web bundle; mobile ships via its own build), one PR.

## Acceptance criteria

- Tapping a Capture opens a sheet with two softly-grouped blocks (no hairline
  dividers): a completion checkbox + editable title + a Refine action, and a
  single schedule row.
- The schedule row shows the current date (or "Schedule" when none, never "No
  date") and opens a Today / Tomorrow / calendar selector on tap; a trailing `X`
  clears the date. Every choice calls `reschedule` and the list re-filters.
- The sheet can be dragged from its resting detent up to full height (Todoist);
  Projects' short action/icon sheets keep their auto-size behaviour.
- Checking the box completes the Capture with the single bottom Undo; dismissal
  saves a changed, non-empty edit and is a no-op otherwise; Refine starts the
  session and closes. No standalone "Done" button.
- The sheet body is a pure `@expo/ui` tree, the scheduler is a plain RN modal
  that renders above it, and both render correctly on the Pixel 7 (device-verified
  with throwaway entities, screenshot captured).
- agent-core date tests and the mobile sheet test pass; `agent-core` and
  `agent-mobile` lint/typecheck pass.
- `docs/entities/capture.md`, the scheduler-plan status, `docs/todo-app.md`, and
  `apps/agent-mobile/CHANGELOG.md` ship in the same change; no backend, data,
  API, store, or shared-collection change.

## Risks

- **RN modal over an `@expo/ui` sheet (the key device risk).** The scheduler is a
  plain RN `Modal` opened while the `@expo/ui` `BottomSheet` is up; RN `Modal`
  renders in its own native window, so it should sit above the sheet, but this
  stacking is unverified on Android. Device-verify; if it fails, fall back to
  presenting the scheduler as the sheet's own swapped content or a second
  `@expo/ui` surface. jest (which mocks `@expo/ui`) cannot prove any of this.
- **`@expo/ui` background/rounding on layout components.** The subtle-grouping
  look needs surface-coloured, rounded blocks; confirm the universal `Column`/
  `Row` expose that styling on both platforms, else fall back to a platform
  modifier — and keep it a pure `@expo/ui` tree either way (no raw RN rows).
- **Production data on device.** The dev client points at production; only ever
  test with throwaway captures and delete them.
