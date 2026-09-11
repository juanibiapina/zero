# Plan: open the capture detail editor from Upcoming

## Goal

Tapping a capture's text in the **Upcoming** tab opens the same capture detail
editor the **Home** tab opens — the bottom sheet with a complete check, an
editable title, a schedule row (Today / Tomorrow / calendar / no date), and
"Refine into tasks & projects" — instead of the current plain inline text edit.

## Background (what exists today)

Two screens read the same capture data layer (`CapturesApi`, one app-lifetime
singleton from `src/lib/captures-collection.ts`):

- **Home** (`apps/agent-mobile/src/app/(signed-in)/index.tsx`): its `Captures`
  component owns the full editor. Tapping a capture row's text calls
  `openDetail(item)`, which sets `selectedId` + `draft`; the editor renders as
  `<CaptureDetailSheet>` plus a `<ScheduleSheet>`, both defined in this file
  alongside a `QuickRow` helper. Surrounding state and handlers: `selectedId`,
  `draft`, `scheduling`, `closingDetailRef`, `commitAndClose` (edits on any
  dismissal), a `complete` path (`onProcess`, an `undoableAction` with an Undo
  snackbar), `onRefine` (`startRefine` then close), reschedule-from-scheduler,
  and an Android `BackHandler` branch ordering `scheduling > selected >
  confirmingDiscard > adding`. `selected` is resolved every render as
  `list.find(id)` against Home's **visible** list (`visibleCaptures`), so a
  reschedule that moves a capture out of the visible list closes the sheet.
- **Upcoming** (`apps/agent-mobile/src/app/(signed-in)/upcoming.tsx`): its
  `UpcomingRow` has no detail sheet. Tapping the text swaps the row for an inline
  `TextInput` (`editingId`/`editText`, `onStartEdit`/`onEditSubmit`). This is the
  code to replace. Upcoming resolves its rows from `upcomingSections` (future-
  dated, undone captures) and has its own `onProcess` (same `undoableAction`).
  It has no `BackHandler` and no `RefineBanner`.

The editor markup is ~200 lines inside `index.tsx`. Copying it into
`upcoming.tsx` would duplicate a deep behavior (edit-on-dismiss, the scheduler,
refine) across two call sites — a shallow copy that drifts. The fix is to
extract one **deep module** that owns the editor and expose a small interface,
then have both screens use it.

## What to change and why

### 1. Extract the editor into a reusable module

New file `apps/agent-mobile/src/components/capture-detail.tsx`. Move
`CaptureDetailSheet`, `ScheduleSheet`, and `QuickRow` into it verbatim (keep all
accessibility labels and testIDs unchanged — `sheet`, `capture-edit-input`,
`Set schedule`, `capture-schedule`, `schedule-today`, `schedule-tomorrow`,
`schedule-none`, `Refine into tasks & projects` — so existing Home tests keep
passing). Export a hook that owns the editor's state and handlers:

```
useCaptureDetail({ api, list, onError }) -> {
  open(capture): void          // open the editor for a capture
  process(capture): void       // complete with the shared Undo snackbar
  sheets: ReactNode            // <CaptureDetailSheet/> + <ScheduleSheet/>, ready to render
  handleBack(): boolean        // consume an Android Back press if a sheet/scheduler is open
  active: boolean              // a sheet or the scheduler is open (optional, for Back ordering)
}
```

- `api: CapturesApi` — the data layer (already a port with an in-memory test
  fallback via `entity-api`). Covers `edit`, `reschedule`, `process`,
  `unprocess`.
- `list: Capture[]` — the **screen's own visible list**. The hook resolves the
  selected capture as `list.find(selectedId)`, exactly as Home does now. Passing
  the list (rather than re-querying the whole collection) preserves Home's
  existing close-on-reschedule-out behavior and gives Upcoming the analogous
  behavior (rescheduling a row to today drops it from Upcoming and closes the
  sheet). Do **not** change this behavior in this plan.
- `onError: (message: string) => void` — screens pass their `setWriteError`.

The hook internally owns `selectedId`, `draft`, `scheduling`, `closingDetailRef`
and the handlers `open`, `commitAndClose`, `process` (the `undoableAction` with
the shared `'undo'` toast id), `refine` (`startRefine` then close), and
reschedule-from-scheduler. `handleBack()` returns `true` and closes when
`scheduling` or a `selected` sheet is open, else `false`. This keeps the Back
ordering decision at each screen: the screen calls `detail.handleBack()` first
in its own `BackHandler`, then falls through to its other cases.

Classification (deep-modules): every dependency is **in-process** UI state or
the already-ported `CapturesApi`. No new seam or adapter. Tests exercise it
through each screen's rendered interface.

### 2. Home uses the hook

In `index.tsx`'s `Captures`, replace the inline editor state/handlers with
`const detail = useCaptureDetail({ api, list, onError: setWriteError })`.

- Row `onOpen` → `detail.open`.
- Row/sheet complete → `detail.process` (drop the local `onProcess`; the hook
  owns it).
- Render `{detail.sheets}` where `<CaptureDetailSheet>`/`<ScheduleSheet>` were.
- The `BackHandler` branch for `scheduling`/`selected` becomes
  `if (detail.handleBack()) return true;` kept **above** the `confirmingDiscard`
  / `adding` branches (quick-add state stays in the screen). Preserve current
  ordering.
- Keep quick-add, refine banner, reschedule-by-swipe (`onReschedule`), reorder,
  and all other Home-only logic in the screen.

### 3. Upcoming uses the hook

In `upcoming.tsx`:

- Delete the inline-edit path: `editingId`, `editText`, `onEditSubmit`,
  `onStartEdit`, and the `TextInput` branch in `UpcomingRow`. `UpcomingRow`
  keeps the Process check and renders the text inside a pressable that calls
  `onOpen(item)`.
- Add `const detail = useCaptureDetail({ api, list: <the flattened visible
  upcoming captures>, onError: setWriteError })`. The list passed must be the
  captures the rows resolve from (the `upcomingSections` items flattened), so
  `list.find(id)` resolves the tapped row.
- Row `onOpen` → `detail.open`; row process → `detail.process` (replaces the
  local `onProcess`).
- Render `{detail.sheets}`.
- Add a `BackHandler` effect that returns `detail.handleBack()` (Upcoming has no
  quick-add, so this is the only Back consumer).

### 4. Refine from Upcoming stays usable

The editor offers "Refine into tasks & projects", which sets the global refine
session (`startRefine`) and is surfaced by `<RefineBanner>`. Upcoming renders no
banner today, so a refine started there would strand the user. Add
`<RefineBanner onFinish={onFinishRefine} />` to Upcoming, wiring `onFinishRefine`
to `api.process(captureId)` exactly as Home does. This keeps the extracted editor
identical on both screens and the refine flow completable from either.

## Out of scope

- Changing the close-on-reschedule-out behavior, the Undo snackbar, or the
  scheduler UI. The editor moves verbatim.
- The web surface (`apps/agent-web`); this is a mobile-only change.
- Home's quick-add, swipe-to-postpone, reorder, and tasks header — untouched.
- Any `CapturesApi` / `agent-core` change. The data layer already supports every
  action the editor needs.
- Sharing the editor into the Projects screens.

## Tests to add or update

- **Upcoming** (`__tests__/upcoming.test.tsx`): add tests that tap a capture's
  text and assert the detail sheet opens (`sheet` label present), that editing
  the title (`capture-edit-input`) and dismissing calls `editCapture`, that the
  schedule row (`Set schedule`) opens the scheduler and a pick calls
  `rescheduleCapture`, and that the round check completes the capture. Remove or
  rewrite the old inline-edit assertions. Mirror the equivalent Home tests at
  `index.test.tsx:645-793`.
- **Home** (`__tests__/index.test.tsx`): should keep passing unchanged because
  labels/testIDs are preserved. Run it to confirm the extraction is behavior-
  preserving; adjust only if a moved import path breaks a mock.
- Follow `deep-modules`: test through each screen's interface, not the hook's
  internals. Do not add a separate unit test that reaches past the rendered
  editor.

## Docs to add or update

- `apps/agent-mobile/CHANGELOG.md`: one user-facing entry dated today, e.g.
  "Tapping a capture in Upcoming now opens the same detail editor as Home —
  complete it, edit the title, or reschedule — instead of a plain inline edit."
  (Route: mobile todo app → this file, per `AGENTS.md`.)

## Skills to use

- `deep-modules` — designing the extracted editor as one deep module with a
  small interface; classifying its dependencies (all in-process / already
  ported).
- `vocabulary` — keep interface/seam/adapter terms consistent in code comments
  and the PR.
- `tdd` — write the Upcoming sheet tests alongside the screen change.
- `git-commit` — when committing (code + changelog together, per `AGENTS.md`).
- `open-pr` — to send for review.

## Acceptance criteria

1. Tapping a capture's text in Upcoming opens the detail bottom sheet (complete
   check, editable title, schedule row, Refine), identical to Home.
2. Editing the title and dismissing persists via `editCapture`; the scheduler
   persists via `rescheduleCapture`; the check completes via `processCapture`
   with the shared Undo snackbar.
3. The old inline `TextInput` edit path is gone from Upcoming.
4. Android Back closes the scheduler, then the sheet, on both screens.
5. Refine started from Upcoming shows the RefineBanner there and "Done"
   completes the capture.
6. The editor markup exists in exactly one place; `index.tsx` no longer defines
   `CaptureDetailSheet`/`ScheduleSheet`.
7. `pnpm --filter @zero/agent-mobile run test`, `lint`, and `typecheck` pass;
   the change is verified on the Pixel 7 (per `AGENTS.md`, mobile changes are
   not done until verified on device — use a throwaway future-dated capture and
   delete it after).
8. A dated changelog entry is committed with the code.

## Risks and mitigations

- **Back-handler ordering regression on Home.** The quick-add / discard-confirm
  ordering is subtle. Mitigation: keep `detail.handleBack()` as the first branch
  and leave the remaining branches byte-for-byte; re-run the Home Back test
  (`index.test.tsx:795`).
- **Wrong `list` passed to the hook.** If Upcoming passes a list that does not
  contain the tapped capture, `selected` resolves null and the sheet will not
  open. Mitigation: pass the same flattened array the rows render from, and the
  new "opens the sheet" test catches it.
- **On-device-only bugs** (per `AGENTS.md`, optimistic writes can pass in-memory
  tests yet fail on the persisted collection). Mitigation: the mandatory Pixel 7
  pass on throwaway entities.
