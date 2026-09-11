# Captures: detail sheet + full scheduler — remaining slices

Living plan for the todo app's remaining scheduler work. Slices 0–3 (collapse
to one list, postpone-to-tomorrow, drag-to-reorder, and the edit-only detail
sheet) and the `sortKey` data model are **shipped** — this plan tracks their
status and what is left:

- **Slice 3 — Edit-only detail bottom sheet** (inline editing moved into the
  existing shared sheet) — SHIPPED
- **Slice 4 — Full scheduler** (quick options + calendar) — SHIPPED on **mobile
  and web**. Mobile via the detail rework (`docs/plans/todo-capture-detail-rework.md`,
  a plain RN modal); web via `docs/plans/todo-capture-detail-web.md` (a Radix
  popover on the detail sheet). Both: the schedule row opens a Today / Tomorrow
  (with resolved weekday) / inline month calendar / No date selector — no native
  picker, no `react-day-picker` (a shared `monthMatrix` helper), no free-text,
  recurrence, or time.
- **Later fast-follow — Natural-language date input** ("next thursday")

Dependencies: 4 needs the sheet from 3; 4 reuses the `reschedule(id, showUpDate|null)`
verb + widened `PATCH /api/captures/{id}` already shipped in Slice 1; NL input is a
strict addition on top of Slice 4's schedule field. One PR per slice; each ships its
docs + changelog in the same change.

## What already exists (shipped foundation the remaining slices build on)

- **Web list:** `apps/agent-web/src/pages/HomePage.tsx` — one Captures list.
  `Row` has circle = process, text = **open detail sheet**, a hover/focus
  "Tomorrow" button (`onReschedule`), and a dnd-kit drag grip. Rows
  filtered through `visibleCaptures(rows, capturesLocalToday())`.
- **Mobile list:** `apps/agent-mobile/src/app/(signed-in)/index.tsx` —
  `ReorderableList`; module-scope `CaptureRow` with inline `Gesture.Pan`
  swipe-right-to-postpone, `useReorderableDrag()` long-press drag, tap-circle =
  process, tap-text = **open detail sheet**. `GestureHandlerRootView` wraps the app
  in `_layout.tsx`; the `BackHandler` chain dismisses the sheet first.
- **Server:** `captures` table has `text, createdAt, processedAt, showUpDate, sortKey`.
  `PATCH /api/captures/{id}` already accepts any subset of `{ text, showUpDate, sortKey }`
  as one idempotent same-key update (`apps/agent-api/src/routes/captures.ts`), so
  Slice 3 and Slice 4 need **no new endpoint**. `GET /api/captures` returns every
  open Capture; the clients split the set between Captures and Upcoming using
  their local day.
- **Shared collection:** `packages/agent-core/src/captures/*` — `collection.ts`
  (`createCapturesApi` with `edit`/`reschedule`/`reorder` verbs, optimistic +
  offline outbox), `dates.ts` (`capturesLocalToday`, `tomorrow`, `visibleCaptures`
  — loose `== null` date rule), `order.ts` (`orderKeyBetween`, `compareByOrder`),
  `upcoming.ts` (future-dated grouping). View gate in `view.ts`.
- **REST:** web `apps/agent-web/src/lib/captures.ts`, mobile
  `apps/agent-mobile/src/lib/api.ts` (no mobile `lib/captures.ts`); both wired into
  each app's `captures-collection.ts`.
- **Shared sheet primitives are shipped:** mobile
  `apps/agent-mobile/src/components/ui/sheet.tsx` wraps the universal `@expo/ui`
  `BottomSheet`; web `apps/agent-web/src/components/ui/sheet.tsx` wraps Radix
  Dialog as a bottom-anchored sheet with title, Close, Esc, backdrop dismissal,
  focus trap, and scroll lock. Projects already uses both. Slice 3 adds no
  dependency and must reuse these primitives unchanged. `@expo/ui ~57.0.13`
  also provides the native `TextInput` and `Button` needed for the mobile body.
- **Changelogs:** `apps/agent-web/CHANGELOG.md` + `apps/agent-mobile/CHANGELOG.md`.
  NOT `apps/agent-api/CHANGELOG.md` (that ships to Zero-assistant users).

## Carry-forwards from shipped slices (non-negotiable)

- **Loose `== null`** for every `showUpDate`/`sortKey` check (a pre-column server
  row arrives `undefined`; strict `=== null` would hide it — flash-then-vanish).
- **React Compiler on mobile:** any render-body call into an agent-core helper
  (`visibleCaptures`, `upcomingSections`) must stay inside `useMemo`; build any
  gesture **inline** (no `useMemo`) or the compiler bails the whole screen's
  memoization.
- **Slice 3 is JS-only against native modules already shipped for Projects.**
  The installed dev client already needs `@expo/ui` for the Projects sheet and
  fields, so reusing `Sheet`, `TextInput`, and `Button` requires no dependency or
  native configuration change. Verify through the dev client + Metro on the
  Pixel. Rebuild only if the installed client proves it lacks the module. Slice
  4's datetimepicker can still require a fresh dev-client build.
- **On-device testing:** Pixel (USB-attached), driven with Maestro on the
  **personal profile / user 0 only**. Dev box has no workerd and no Android
  emulator — verify touched packages directly (`pnpm --filter ... test/lint/typecheck`).

---

## Slice 3 — Edit-only detail bottom sheet — SHIPPED

### Goal and scope

Tapping a Capture's text area opens the shared slide-up sheet and lets the user
edit that Capture's one-line text. This slice moves the existing edit capability
out of the row; it does not add scheduling, metadata, deletion, processing, or
another Capture field. Slice 4 adds scheduling later.

The row keeps its existing independent controls and gestures:

- circle: Process;
- mobile swipe right / web Tomorrow button: postpone;
- mobile long-press / web grip: reorder;
- text area: open detail sheet.

No server, route, REST adapter, collection, schema, dependency, or shared sheet
change is needed. Both apps already call the optimistic, offline-replaying
`api.edit(id, text)` verb, and Projects already shipped the generic `Sheet`
module on both platforms.

### Interaction decisions

- The sheet contains one single-line text field seeded from the selected Capture
  and an explicit **Done** action. The field receives focus when the sheet opens;
  no visible heading repeats the action already implied by the field and sheet.
- Keep the draft in the screen alongside `selectedId`, rather than inside a row.
  This removes editing state from every list row and gives all dismissal paths
  access to the current draft.
- Done, Enter/the keyboard Done key, Close, backdrop dismissal, Esc (web), and
  native sheet dismissal all run the same `commitAndClose` callback. It trims the
  draft, writes only when the result is non-empty and changed, then closes. An
  empty edit leaves the stored text unchanged. This preserves implicit saving
  while preventing a typed change from being lost through a non-button dismissal.
- The write remains optimistic. A persistence failure uses the screen's existing
  write-error channel after the sheet closes. The editor does not add loading,
  success, or disabled states.
- If the selected Capture disappears during a refetch, derive it from the live
  list and close the sheet. Do not retain a stale detached copy.

### Implementation

1. **Mobile opens one native edit sheet without disturbing gestures.** In
   `apps/agent-mobile/src/app/(signed-in)/index.tsx`, simplify `CaptureRow` to a
   display row: remove its `editing`, `editText`, and inline `TextInput` interface;
   keep its inline `Gesture.Pan`; bind the text area's `onPress` to open and
   `onLongPress` to `useReorderableDrag`. Add screen-level selected-id + draft
   state, `commitAndClose`, and a small keyed `CaptureDetail` body built from the
   existing universal `@expo/ui` `Column`, `Text`, `TextInput`, and `Button`.
   Render it inside the existing `@/components/ui/sheet`. Put the selected-sheet
   branch first in the existing `BackHandler` chain so hardware Back dismisses it
   before quick-add behavior.
2. **Web opens the same conceptual editor through the Radix sheet.** In
   `apps/agent-web/src/pages/HomePage.tsx`, remove `Row`'s local inline-edit state
   and optional `onEdit` interface. Make its text area a real button that opens
   the selected Capture while the grip, Process circle, and Tomorrow button keep
   their own actions. Render the existing `@/components/ui/sheet` with
   screen-reader title `Edit capture`, the shared screen draft in `Input`, and
   Done. Route the
   sheet's Close/Esc/backdrop callback and Enter through `commitAndClose`.
3. **Keep the sheet modules unchanged.** The existing entity-agnostic wrappers
   already hide Radix / `@expo/ui` details behind their small interfaces. Capture
   content belongs in the screen, like `ProjectDetail`; adding Capture-specific
   props to either Sheet would weaken that seam.

### Tests

- **Mobile:** update `apps/agent-mobile/src/app/(signed-in)/__tests__/index.test.tsx`
  so the current inline-edit tests open the mocked BottomSheet, assert the field
  is seeded, submit changed text, and observe the optimistic row +
  `editCapture(id, text)` call. Retain unchanged coverage and add empty-draft
  coverage. Extend the shared `@expo/ui` jest mock with a queryable `TextInput`
  and Done `Button` if needed. Add a BackHandler assertion that the sheet closes
  before quick-add handling. Gesture behavior remains covered by existing wiring
  tests and gets a device smoke test.
- **Web:** add `apps/agent-web/src/pages/HomePage.test.tsx`, following
  `ProjectsPage.test.tsx`: inject a fresh in-memory `CapturesApi`, render the real
  page, open the sheet, edit, commit, and assert the row changes. Cover unchanged
  or empty text as a no-op and verify Esc/Close dismisses. Do not test Radix
  implementation details beyond the behavior exposed by `Sheet`.
- Run tests, typecheck, and lint for `@zero/agent-core`, `@zero/agent-web`, and
  `@zero/agent-mobile`. Run mobile Jest with `--runInBand`. This box cannot run
  the whole-repo `workerd` checks.
- Verify web sheet focus, Enter, Close, Esc, backdrop, Process, Tomorrow, and drag
  in a browser. Verify mobile tap, edit, Done/Back/dismiss, Process, swipe-right,
  and long-press reorder on the attached Pixel through the development client +
  Metro and Maestro (user 0).

### Documentation and release notes

- Update `docs/entities/capture.md`: editing now happens in the detail sheet;
  inline editing is removed.
- Update `docs/todo-app.md` and this plan to mark Slice 3 shipped; leave Slice 4
  as the next scheduler slice.
- Load the `changelog` skill, then add the same user-facing outcome to
  `apps/agent-web/CHANGELOG.md` and `apps/agent-mobile/CHANGELOG.md` in the feature
  change. Do not edit `apps/agent-api/CHANGELOG.md`; the agent product is
  unaffected.

### Skills to use during implementation

- `expo-overview` + `expo-ui` — confirm SDK 57 native `BottomSheet`, `TextInput`,
  and `Button` usage against installed types.
- `impeccable` — preserve the incumbent list and sheet visual system; run its
  detector once after the web UI is complete.
- `testing` — update mobile behavior tests and add the web test through each
  screen's public interaction surface.
- `browse` — verify keyboard, focus, and dismissal behavior in the web sheet.
- `changelog` — write both product release notes before editing either changelog.
- `reproducible-locally` — collect package-test and Pixel/Maestro evidence.
- `git-commit` + `open-pr` — commit the complete vertical slice and open one PR.

### Acceptance criteria

- Tapping Capture text opens an edit-only bottom sheet on web and mobile with the
  current text focused.
- Changed, non-empty text saves through the existing optimistic/offline path on
  Done, Enter, Close, or dismissal; the row shows the edited text.
- Empty and unchanged drafts issue no write and preserve the stored text.
- Close, Esc/backdrop (web), and native dismissal/Back close the sheet.
- Process, postpone, and reorder retain their current behavior and remain
  separate from opening the sheet.
- No inline editor remains, no backend/shared-data-layer code changes, and Slice
  4 scheduling stays out of scope.
- Both changelogs, Capture docs, and roadmap status ship in the same PR; affected
  tests, lint, typecheck, browser verification, and Pixel verification pass.

## Slice 4 — Full scheduler in the sheet (chips + calendar)

**Goal:** reschedule a capture to any date from the detail sheet. Reuses the
shipped `reschedule(id, showUpDate|null)` verb + widened PATCH — **no backend
change**.

Research (Todoist/Things/Fantastical): lead with quick chips, calendar grid as a
rarely-opened fallback. Gentle overdue (Things 3) — overdue rolls into today
silently, no red; `visibleCaptures` already matches this, do not add overdue-red.

- **Chip set = exactly four: Today · Tomorrow · Next week · No date.** Decision
  (not open): defer "This weekend" — the four cover the overwhelming majority and
  each maps to one trivial pure date function (`today`, `tomorrow`, next Monday,
  `null`); "This weekend" adds a second weekday rule and a fifth chip for a
  minority case (fold it into the NL fast-follow instead, where it parses for
  free). "No date" sets `showUpDate = null` (always-visible again).
- **Pure date functions** live in `packages/agent-core/src/captures/dates.ts`
  (`today`, `tomorrow` exist; add `nextWeek`/next-Monday), each unit-tested there.
- **UI (both surfaces):** a schedule control in the sheet — the four chips first,
  a "Pick a date…" calendar grid below.
  - Mobile: chips + `@expo/ui/community/datetimepicker` (native).
  - Web: chips + `react-day-picker` (`snyk-dependency-check` before adding).
- **Build:** mobile native datetimepicker → local dev client build.
- **Docs:** `docs/entities/capture.md` — scheduler UX (chips + calendar), `null` =
  no-date.
- **Changelog** (web + mobile): "Pick any date for a capture from its detail view —
  today, tomorrow, next week, a calendar date, or clear the date entirely."

**Acceptance:** any chip/calendar date sets `showUpDate` and the list re-filters;
"No date" clears it; swipe-right (tomorrow) still works as the accelerator.

## Later — Natural-language date input (fast-follow, not core sequence)

Type "next thursday" in the sheet's schedule field. Highest-praised scheduling
feature across Todoist/Fantastical; fits the type-fast capture workflow. Its own
slice after Slice 4 — a strict addition on top of the same `reschedule` verb and
schedule field. "This weekend" parses for free here. Pulling it earlier would mean
building a parser before there is any input to attach it to.

## Cross-cutting

- **Skills:** `code`, `deep-modules` (keep the schedule/edit seam narrow, reuse the
  shipped verbs), `snyk-dependency-check` (before `react-day-picker` and any new
  dep), `expo-ui` (Slice 3 `BottomSheet`, Slice 4 datetimepicker), `expo-animation`
  (sheet/gesture coexistence with the shipped swipe + drag), `impeccable` (sheet +
  scheduler polish), `changelog` (before each changelog edit), `reproducible-locally`
  (prove edit/reschedule persist + sync + offline per slice), `git-commit` (per slice).
- **Verification per slice:** unit tests (`agent-core` pure helpers, `agent-api`
  store/routes) + a Pixel Maestro pass on user 0. Native-component slices (3–4)
  need a fresh local build via `nix develop <dotfiles>#android` (`expo run:android`);
  no workerd/emulator on the dev box, so verify touched packages directly.
- One PR per slice; docs + changelog in the same change (repo changelog rule).
  Pushing to `main` auto-deploys `zero-api` (agent + web bundle) via Cloudflare
  Workers Builds; mobile ships separately (an EAS/local build, not the push).
