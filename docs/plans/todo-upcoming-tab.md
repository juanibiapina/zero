# Upcoming tab (todo app section #2) — plan

Status: **built, checks green (agent-core 69, mobile jest 46, web
build/lint/typecheck, `expo export` clean); on-device verification pending.** Off
branch `todo-nav-tab-bar` (PR #65, the nav chrome). Adds the second nav section
promised by that PR: an **Upcoming** view that shows future-dated captures
grouped by day. Self-contained handoff.

## Goal

Give the todo app its second section: **Upcoming**, a list of the user's
future-scheduled captures grouped into day sections (Tomorrow, then each
following day that has items). No calendar strip — the user scrolls. Ship it on
both surfaces (mobile tab bar + web nav), keeping them in step per the nav plan.

This also resolves the one-tab anti-pattern the nav plan flagged: the mobile bar
goes from one tab to two.

## Background a fresh agent needs

- **Two surfaces, built separately.** `apps/agent-mobile` is Expo (React Native,
  Expo Router, NativeTabs). `apps/agent-web` is a separate React app (react-router
  + Vite), NOT the Expo web build. They share only pure helpers from
  `@zero/agent-core`. Every UI piece is built twice, in each surface's idiom.
- **Capture data model** (`packages/agent-core/src/captures/types.ts`): a
  `Capture` has `id`, `text`, `createdAt`, `processedAt`, `showUpDate`
  (`YYYY-MM-DD` local day it shows up, or `null` for a plain always-visible
  capture), and `sortKey` (fractional index for manual order).
- **The current Captures tab shows items that have shown up:** `visibleCaptures`
  (`captures/dates.ts`) keeps open captures with `showUpDate == null` OR
  `showUpDate <= today`. So an undated capture and any capture whose day has
  arrived live in Captures.
- **Upcoming is the complement, forward only:** open captures with a `showUpDate`
  strictly in the future (`showUpDate > today`). A capture is in exactly one of
  the two tabs: Captures if it has shown up (or is undated), Upcoming if its day
  is still ahead. No overlap, so there is no overdue or "today" case to handle in
  Upcoming — those are already in Captures.
- **How a future date gets set today:** postponing a capture sets
  `showUpDate = tomorrow`, which moves it out of Captures and into Upcoming's
  Tomorrow section. Postpone-to-tomorrow is the only dating path today; the
  arbitrary-date scheduler is a later slice, not built. So Upcoming starts thin
  (mostly a Tomorrow section) and fills as scheduling grows. Build it now.
- **The `+` quick-add stays a FAB, never a tab** (nav plan decision).
- **Tab = a screen file whose name matches its `NativeTabs.Trigger name`**; adding
  a tab is a new file under `src/app/(signed-in)/` plus one more `Trigger`.
- **First on-device run** of a genuinely new native module needs a fresh EAS dev
  build; pure-JS screens hot-reload. `NativeTabs` and `SectionList` are already in
  the installed dev client, so no rebuild is expected for this change (verify).

## Decisions already made (design)

- **Grouping lives in `@zero/agent-core` as one pure, tested helper**, shared by
  both surfaces (same rule as `visibleCaptures`). New file
  `packages/agent-core/src/captures/upcoming.ts`:

  ```ts
  export type UpcomingSection = { date: string; captures: Capture[] };
  export function upcomingSections(
    list: readonly Capture[],
    today: string,          // YYYY-MM-DD, capturesLocalToday()
  ): UpcomingSection[];
  ```

  Rules:
  - Keep only open, future-dated captures:
    `processedAt == null && showUpDate != null && showUpDate > today`.
  - Group by `showUpDate`; emit one section per distinct future day that has
    items, ordered by date ascending. No empty sections.
  - Within a section, order captures by `compareByOrder` (the shared comparator:
    `sortKey` asc, nulls last, `createdAt` tiebreak) — same as the Captures list.
  - Pure and locale-free: it returns ISO dates, not labels. The UI formats each
    date to "Tomorrow" / weekday+day+month with `Intl.DateTimeFormat` in the
    device locale.

- **Per-surface screens, no shared component** (surfaces are separate apps):
  - Mobile: new `src/app/(signed-in)/upcoming.tsx`, a `SectionList` of the
    helper's sections with a day header per section. Rows reuse the existing row
    affordances (circle to Process, tap to edit) but **without drag-to-reorder** —
    cross-day reordering has no meaning in a date-grouped view. This is a plain
    `SectionList`, not the Captures `ReorderableList`.
  - Web: new `src/pages/UpcomingPage.tsx` + route `/upcoming`, rendering the same
    sections with the existing `Row` (read-only or editable), grouped under date
    headers.

- **Navigation entries:**
  - Mobile `_layout.tsx`: add a second `NativeTabs.Trigger name="upcoming"` with
    icon `sf="calendar"` / `md="calendar_month"` and label **Upcoming**, after the
    Captures trigger.
  - Web `SideNav.tsx`: add a `NAV_ITEMS` entry `{ to: "/upcoming", label:
    "Upcoming", icon: CalendarIcon }` (inline SVG, the app has no icon lib) and a
    `<Route path="upcoming" element={<UpcomingPage />} />` in `App.tsx`.

- **No calendar strip.** The user scrolls the sections; a date selector is not
  wanted.

## Files to change

agent-core:
- `packages/agent-core/src/captures/upcoming.ts` — new helper.
- `packages/agent-core/src/captures/upcoming.test.ts` — new (vitest).
- `packages/agent-core/src/index.ts` — export the helper + type.

mobile (`apps/agent-mobile`):
- `src/app/(signed-in)/upcoming.tsx` — new screen (SectionList).
- `src/app/(signed-in)/_layout.tsx` — second `NativeTabs.Trigger`.
- `src/app/__tests__/signed-in-layout.test.tsx` — assert the Upcoming tab renders.
- `CHANGELOG.md` — user-facing entry.

web (`apps/agent-web`):
- `src/pages/UpcomingPage.tsx` — new page.
- `src/App.tsx` — `/upcoming` route.
- `src/components/SideNav.tsx` — `NAV_ITEMS` entry + `CalendarIcon`.
- `CHANGELOG.md` — user-facing entry.

docs:
- `docs/todo-app.md` — tracking note (Upcoming shipped as section #2).
- this file — keep current.

## Test strategy

- **agent-core (vitest), the load-bearing tests:** `upcomingSections` with a fixed
  `today`:
  - excludes undated captures (`showUpDate == null`), captures dated today or
    earlier (`showUpDate <= today`), and processed captures.
  - emits a section per distinct future day that has items, date-ascending.
  - orders captures within a day by `compareByOrder` (sortKey asc, null last).
  - returns an empty array when there are no future-dated captures.
- **mobile (jest):** extend `signed-in-layout.test.tsx` to assert both `Captures`
  and `Upcoming` tab labels render (the existing NativeTabs mock already renders
  `Trigger.Label` children).
- **web:** follow the existing page/nav test patterns if present; at minimum the
  build/lint/typecheck below must pass.

## How to verify (this NixOS box: no workerd, no Android emulator)

```bash
pnpm --filter @zero/agent-core run test        # upcoming.test.ts
pnpm --filter @zero/agent-web run typecheck && pnpm --filter @zero/agent-web run lint && pnpm --filter @zero/agent-web run build
pnpm --filter @zero/agent-mobile run typecheck && pnpm --filter @zero/agent-mobile run lint
cd apps/agent-mobile && pnpm exec jest --runInBand
cd apps/agent-mobile && npx expo export --platform android   # sanity: bundles clean
```

On-device (Pixel 7 over USB), same flow as the nav plan: `adb reverse tcp:8081
tcp:8081`, start Metro **with cwd inside `apps/agent-mobile`** (starting from repo
root makes Metro pick the wrong project root and the dev client 404s the bundle),
launch the dev client, then `maestro hierarchy` to confirm the **Upcoming** tab
and a day-headed section render.

## Acceptance criteria

- Mobile bottom bar shows two tabs: Captures and Upcoming.
- Web nav shows Captures and Upcoming (sidebar on desktop, bottom bar on phones).
- Upcoming lists open future-dated captures grouped under day sections (Tomorrow,
  then later days), ordered within a day by the manual sort key; undated captures
  and already-shown captures never appear.
- Postponing a capture in Captures makes it appear under Tomorrow in Upcoming.
- Tapping a row's circle processes it; it leaves the view.
- All checks above pass; a user-facing changelog entry ships on each surface.

## Skills to use

- `tdd` — write `upcoming.test.ts` before the helper.
- `testing` — keep the grouping logic pure in agent-core so it is unit-tested
  without either UI.
- `changelog` — the mobile and web changelog entries (same change).
- `git-commit` / `open-pr` — committing and raising the PR.
- `reproducible-locally` — the on-device Maestro check is the real proof.
