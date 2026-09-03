# Captures: detail sheet + full scheduler — remaining slices

Living plan for the todo app's leftover work. Slices 0–2 (collapse to one list,
postpone-to-tomorrow, drag-to-reorder) and the `sortKey` data model are **shipped
on `main`** and verified in prod — this plan covers only what is left:

- **Slice 3 — Detail bottom sheet** (edit moves into a slide-up sheet) — NEXT
- **Slice 4 — Full scheduler** (chips + calendar in the sheet)
- **Later fast-follow — Natural-language date input** ("next thursday")

Dependencies: 4 needs the sheet from 3; 4 reuses the `reschedule(id, showUpDate|null)`
verb + widened `PATCH /api/captures/{id}` already shipped in Slice 1; NL input is a
strict addition on top of Slice 4's schedule field. One PR per slice; each ships its
docs + changelog in the same change.

## What already exists (shipped foundation the remaining slices build on)

- **Web list:** `apps/agent-web/src/pages/HomePage.tsx` — one Captures list.
  `Row` has circle = process, text = **inline edit** (Slice 3 removes this), a
  hover/focus "Tomorrow" button (`onReschedule`), and a dnd-kit drag grip. Rows
  filtered through `visibleCaptures(rows, capturesLocalToday())`.
- **Mobile list:** `apps/agent-mobile/src/app/(signed-in)/index.tsx` —
  `ReorderableList`; module-scope `CaptureRow` with inline `Gesture.Pan`
  swipe-right-to-postpone, `useReorderableDrag()` long-press drag, tap-circle =
  process, tap-text = **inline edit** (Slice 3 removes this). `GestureHandlerRootView`
  wraps the app in `_layout.tsx`. `BackHandler` chain present (extend it for the sheet).
- **Server:** `captures` table has `text, createdAt, processedAt, showUpDate, sortKey`.
  `PATCH /api/captures/{id}` already accepts any subset of `{ text, showUpDate, sortKey }`
  as one idempotent same-key update (`apps/agent-api/src/routes/captures.ts`), so
  Slice 4 needs **no new endpoint** — it reuses `showUpDate`. `GET /api/captures`
  returns only the visible open set (server filters `showUpDate IS NULL OR <= today`
  from `userSettings.timezone`).
- **Shared collection:** `packages/agent-core/src/captures/*` — `collection.ts`
  (`createCapturesApi` with `edit`/`reschedule`/`reorder` verbs, optimistic +
  offline outbox), `dates.ts` (`capturesLocalToday`, `tomorrow`, `visibleCaptures`
  — loose `== null` date rule), `order.ts` (`orderKeyBetween`, `compareByOrder`),
  `upcoming.ts` (future-dated grouping). View gate in `view.ts`.
- **REST:** web `apps/agent-web/src/lib/captures.ts`, mobile
  `apps/agent-mobile/src/lib/api.ts` (no mobile `lib/captures.ts`); both wired into
  each app's `captures-collection.ts`.
- **Mobile deps present:** `@expo/ui ~57.0.13` (SDK 57 → `BottomSheet` +
  `@expo/ui/community/datetimepicker`), gesture-handler, reanimated 4, worklets,
  `react-native-reorderable-list`. **No `expo-haptics`** (native; deferred). Web
  `agent-web` has its own minimal `components/ui` (button/card/input/table) — **no
  sheet or calendar component yet**; no shadcn/`@zero/ui`.
- **Changelogs:** `apps/agent-web/CHANGELOG.md` + `apps/agent-mobile/CHANGELOG.md`.
  NOT `apps/agent-api/CHANGELOG.md` (that ships to Zero-assistant users).

## Carry-forwards from shipped slices (non-negotiable)

- **Loose `== null`** for every `showUpDate`/`sortKey` check (a pre-column server
  row arrives `undefined`; strict `=== null` would hide it — flash-then-vanish).
- **React Compiler on mobile:** any render-body call into an agent-core helper
  (`visibleCaptures`, `upcomingSections`) must stay inside `useMemo`; build any
  gesture **inline** (no `useMemo`) or the compiler bails the whole screen's
  memoization.
- **Native components need a fresh build.** Slices 1–2 were JS-only (hot-reload on
  the dev client). Slice 3's `@expo/ui BottomSheet` and Slice 4's native
  datetimepicker are native → build a dev client **locally** on the Mac via
  `nix develop <dotfiles>#android` (`expo run:android`), no EAS cloud needed.
  Verify early. The Pixel is **dev-client-only** (a standalone build embeds JS and
  ignores Metro).
- **On-device testing:** Pixel (USB-attached), driven with Maestro on the
  **personal profile / user 0 only**. Dev box has no workerd and no Android
  emulator — verify touched packages directly (`pnpm --filter ... test/lint/typecheck`).

---

## Slice 3 — Detail bottom sheet (edit moves into it) — NEXT

**Goal:** tapping a capture opens a Todoist-style slide-up sheet where you edit
its text. Inline tap-to-edit is removed (editing lives in the sheet); tapping the
circle still processes.

Research that shaped it (NN/g bottom sheets): a bottom sheet is the right pattern
for a short edit/detail task; give an explicit Close (X); support Back/Esc to
dismiss (the grab handle alone is missed and collides with the notification drawer).

- **Mobile UI** (`apps/agent-mobile/src/app/(signed-in)/index.tsx`): tap row →
  `@expo/ui` `BottomSheet` (native — NOT `@gorhom/bottom-sheet` or a hand-rolled
  Reanimated sheet; `@expo/ui` is already a dep and this is exactly the skill's
  guidance). v1 contents: editable text field that commits `PATCH { text }` via the
  existing `edit` verb. Explicit Close (X). Extend the existing `BackHandler` chain
  so Back dismisses the sheet first (before the app's other back behavior). Remove
  the inline tap-to-edit path; tap-circle still processes, long-press still drags,
  swipe-right still postpones.
- **Web UI** (`apps/agent-web/src/pages/HomePage.tsx`): click row → bottom-anchored
  slide-up sheet (new to `agent-web` — no sheet component exists; add a minimal one
  under `components/ui` rather than pulling in shadcn/`@zero/ui`). Same edit field +
  Close + Esc/Back to dismiss. Remove inline edit.
- **Build:** native (`@expo/ui BottomSheet`) → fresh local dev client build before
  the Pixel. Verify early.
- **Tests:** the edit path already has coverage; add a render test that the screen
  mounts with the sheet lib mocked (jest passthrough if needed). Gesture/sheet
  interaction verified on-device (Maestro, user 0).
- **Docs:** `docs/entities/capture.md` — note editing happens in the detail sheet.
- **Changelog** (web + mobile): "Tap a capture to open it in a slide-up view and
  edit it there."

**Acceptance:** tap opens the sheet; edit commits optimistically and syncs; Close,
Back, Esc all dismiss; inline edit gone with no lost capability.

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
