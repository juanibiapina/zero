# Bring the web capture detail to parity with mobile

Mobile's capture detail was redesigned (`docs/plans/todo-capture-detail-rework.md`):
a complete radio + editable title, a schedule row that opens a Today / Tomorrow /
calendar / No-date selector, and a Refine action — no "Done" button. The **web**
capture detail (`apps/agent-web/src/pages/HomePage.tsx`) is still the older
edit-only sheet. This plan brings web to parity. Web only; no backend, API,
store, or shared-collection change.

## Bottom line

1. **Redesign the web detail sheet to match mobile's model.** Today the Radix
   `Sheet` holds only a title `Input` in a muted box and a **"Done"** button.
   Replace that with: a **complete radio + editable title**, a **schedule row**,
   and a **Refine** action. Drop "Done" — the radio completes, dismissal saves
   (the sheet already commits the edit on close/Esc/backdrop via
   `commitAndClose`). This mirrors the mobile decision that "Done" reads as
   *complete* in a to-do app.
2. **Reuse the shared date logic — it already exists.** `scheduleLabel`,
   `weekdayShort`, and `monthMatrix` were added to `@zero/agent-core` for mobile
   and are platform-agnostic and unit-tested. Web imports them directly, so the
   scheduler is **dependency-free** — a custom month grid, no `react-day-picker`.
3. **No native-toolkit trap here.** Web is Tailwind + shadcn/Radix with full
   styling control (the `@expo/ui` problems that plagued mobile do not exist on
   web). Match the web app's own surfaces (the quick-add/add composer, the
   waiting-condition popover), not mobile's tokens.
4. **All the domain wiring already exists on web.** `api.reschedule(id,
   showUpDate|null)`, `api.process`/`unprocess` (with the shared Undo snackbar),
   `api.edit`, and `startRefine` are all already used on `HomePage`. This is a
   sheet-UI change plus a scheduler popover, not new capability.

## Current state (verified)

- **`apps/agent-web/src/pages/HomePage.tsx` → `CapturesSection`.** Holds
  `selectedId` + `draft`, `openDetail`, and `commitAndClose` (trims; writes only
  a changed, non-empty draft; then closes). The row (`Row`) already has: a
  process circle (`onProcess`), a hover **Tomorrow** button (`onReschedule` →
  `reschedule(id, tomorrow(...))`), a hover **Refine** button (`onRefine` →
  `startRefine`), tap text → `openDetail`, and a dnd-kit drag grip.
- **The sheet body** (in `CapturesSection`): a `<form onSubmit=commitAndClose>`
  with an `Input` (autofocus) in `rounded-2xl bg-muted/60` and a **Done**
  `Button`. No completion, no schedule, no refine inside the sheet.
- **`apps/agent-web/src/components/ui/sheet.tsx`** — Radix Dialog slide-up
  (`title` + `srOnlyTitle`, Esc/backdrop/focus-trap/scroll-lock). Reuse
  unchanged.
- **Shared helpers (already shipped):** `scheduleLabel`, `weekdayShort`,
  `monthMatrix`, plus `capturesLocalToday`, `tomorrow`, `visibleCaptures` in
  `@zero/agent-core`.
- **Precedent for a web popover composer:** the waiting-condition "+ " control
  opens a small popover (see `apps/agent-web` + `CHANGELOG.md` 2026-09-10) —
  the same shape the schedule selector should take.
- **Tests:** `apps/agent-web/src/pages/HomePage.test.tsx` exists with an
  in-memory `CapturesApi` (its `rescheduleCapture`, `processCapture`,
  `unprocessCapture`, `editCapture` are already wired).
- **Changelog:** `apps/agent-web/CHANGELOG.md` (NOT the agent file).

## What to change

- **`HomePage.tsx` sheet body — the three parts:**
  1. **Identity row:** a round complete control + the editable title `Input`.
     Reuse the row's existing process-circle styling — extract it into a small
     shared control (e.g. `CaptureCircle`/`Check`) used by both the row and the
     sheet, so there is one circle. Completing runs the existing `onProcess`
     `undoableAction` (process + single Undo) and closes the sheet.
  2. **Schedule row:** a button showing `scheduleLabel(selected.showUpDate,
     capturesLocalToday())` with a calendar glyph — accent when a date is set,
     muted "Schedule" when not. Clicking it opens the **scheduler popover**.
  3. **Refine action:** a low-emphasis button "Refine into tasks & projects"
     (accent), calling `startRefine(selected.id, selected.text)` then closing.
  - Remove the **Done** button. Keep `commitAndClose` on submit (Enter),
    Esc/backdrop/close.
- **Scheduler popover (new, dependency-free):** a Radix Popover (or reuse the
  waiting-composer popover pattern) anchored to the schedule row, containing:
  - **Today** and **Tomorrow** rows with the resolved weekday
    (`weekdayShort`) on the right;
  - an **inline month calendar** built from `monthMatrix(year, month0)` —
    Monday-first, today marked, selected day filled, prev/next month arrows;
  - a **No date** row.
  Each choice calls `api.reschedule(selected.id, date|null)` and closes the
  popover (the detail sheet stays open). This reuses the row's existing
  `reschedule` wiring.
- **Extract the circle** used by `Row` so the sheet and row share one control
  (avoid a second, divergent circle). Small, local to `HomePage`/a web `ui`
  component.
- **No `Sheet` component change**, no backend, no shared-collection change.

## Design / consistency

- Match the **web app's own** surfaces: the sheet stays the Radix slide-up; the
  identity/schedule/refine rows follow the spacing and muted/accent tokens the
  page already uses (e.g. the quick-add composer and waiting popover), not
  mobile's tokens. The *model* matches mobile (radio completes, no Done, one
  schedule row → selector); the *skin* matches web.
- Keep the row's hover Tomorrow/Refine buttons as accelerators (unchanged), the
  same way mobile keeps swipe-to-postpone alongside the sheet scheduler.

## Out of scope

- **Natural-language date input, recurrence, and time-of-day** — same exclusions
  as mobile; `showUpDate` is a plain date.
- **New capture attributes** (priority, labels, sub-tasks, comments) — the
  entity stays minimal.
- **A delete verb** — none exists; Process is removal.
- **Mobile** — already shipped.

## Tests

- **`HomePage.test.tsx` (jsdom, real behavior through the page):**
  - Opening the sheet seeds the title; editing + submit/close writes via `edit`;
    empty/unchanged is a no-op (retain existing coverage).
  - The sheet's complete radio calls `process` and closes; Undo reopens.
  - Opening the scheduler and choosing Today / Tomorrow / a calendar day calls
    `reschedule` with the expected date; **No date** calls `reschedule(null)`.
  - Refine starts the session and closes.
- Reuse the existing in-memory `CapturesApi` in the test (its verbs are already
  wired). Assert through the page's public interaction surface, not Radix
  internals.
- Run `pnpm --filter @zero/agent-web test`, `lint`, `typecheck`. `agent-core`
  helpers are already covered; no new core tests needed unless a helper gains a
  case.

## Documentation and changelog

- `docs/entities/capture.md` — note the web detail now matches: complete radio +
  editable title, schedule row → Today/Tomorrow/calendar/No-date selector, Refine
  action, no "Done".
- `docs/plans/captures-detail-sheet-scheduler-plan.md` — flip "web still pending"
  to shipped for the date scheduler.
- `apps/agent-web/CHANGELOG.md` — one user-facing bullet, e.g. "The capture
  detail now has a complete check, an editable title, and a schedule row that
  opens a Today / Tomorrow / calendar picker (or clears the date)."

## Skills to use

- `impeccable` — shape the sheet's identity/schedule/refine hierarchy and the
  scheduler popover on the web tokens; run its detector once after.
- `shadcn` — the Popover/Button/Input primitives and the app's component idioms.
- `browse` — verify in a real browser (the web app runs locally here): open the
  sheet, edit, complete + Undo, open the scheduler, pick Today/Tomorrow/a
  calendar day/No date, confirm the list re-filters, and Refine. Capture
  screenshots.
- `deep-modules` / `vocabulary` — keep date logic in the shared `agent-core` seam
  (already there); extract one shared circle control rather than duplicating it.
- `testing` — extend `HomePage.test.tsx` through its interaction surface.
- `changelog` — before editing the web changelog.
- `git-commit` / `open-pr` — commit the web slice (and fold with the mobile
  branch or its own PR, per how the mobile change is landed).

## Acceptance criteria

- Tapping a capture on web opens a sheet with a complete radio + editable title,
  a schedule row (current date, or "Schedule" when unset), and a Refine action —
  no "Done" button.
- The schedule row opens a Today / Tomorrow / calendar / No-date selector; each
  choice calls `reschedule` and the list re-filters; No date clears it.
- The complete radio processes the capture with the shared Undo; dismissal saves
  a changed non-empty edit and is a no-op otherwise; Refine starts the session
  and closes.
- One shared circle control backs both the row and the sheet (no divergent
  copy).
- `HomePage.test.tsx` covers complete + schedule; web lint/typecheck/tests pass;
  verified in a browser with screenshots.
- `capture.md`, the scheduler-plan status, and `apps/agent-web/CHANGELOG.md` ship
  in the same change; no backend, API, store, or shared-collection change.

## Risks / notes

- **One circle, not two.** The row already draws a process circle; extract and
  share it so the sheet's radio can't drift from the row's. Small refactor.
- **Popover vs. inline.** A Radix Popover anchored to the schedule row matches
  the waiting-composer precedent and keeps the sheet short; if it fights the
  sheet's focus trap, fall back to swapping the sheet's content to the scheduler
  (both are fine — decide during implementation).
- **Keep web and mobile options identical** (Today/Tomorrow/calendar/No date, no
  "Next week") so the two products stay consistent.
