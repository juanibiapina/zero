# Plan: Tighten the todo-app experience and code (no new features)

## Goal

Remove the accumulated duplication across the six todo-app screens and close the
testing gap, without changing any user-visible behavior. The Project, Capture,
and Task screens on web (`apps/agent-web`) and mobile (`apps/agent-mobile`) have
grown four near-identical copies of the same list-screen machinery. The
delete-a-project change made this worse: it doubled the Undo-timer logic inside
each Projects screen (`pendingDone` + `pendingDelete` are the same code twice).
This plan consolidates that machinery into deep, shared modules and locks the
shared behavior with tests, so a change lands once instead of in four places.

Everything here is behavior-preserving. Success is measured by: the same screens
render and behave identically, the duplication is gone, and tests at the shared
interfaces prove it.

## Background a fresh agent needs

- **Two React apps, one shared logic package.** `apps/agent-web` is a React-DOM
  Vite app; `apps/agent-mobile` is a React-Native Expo app. They are separate
  apps, not one universal build. `packages/agent-core` (`@zero/agent-core`) is
  the shared, platform-agnostic app code both import (the TanStack DB collection
  factory, entity data layers, date and grouping helpers, timezone sync).
- **agent-core has no React dependency today**, but it already depends on the
  React-query / TanStack ecosystem as peers. Crucially, **the API worker
  (`apps/agent-api`) does not import `@zero/agent-core`** — only the two React
  apps do (verified by grep). So adding `react` as a peer dependency of
  agent-core cannot bloat or complicate the Worker bundle. This is what makes
  sharing React hooks from agent-core safe.
- **The collection factory** (`packages/agent-core/src/collection/base.ts`) is
  the shared write/sync/offline engine. Each entity is a verb table over it
  (`insert` / `update` / `delete` verb kinds). Screens read the collection with a
  live query and write with the entity's API (`api.add`, `api.setStatus`,
  `api.remove`, …), each returning a TanStack `Transaction` whose
  `isPersisted.promise` rejects on a failed write.
- **The Undo idiom.** A row that leaves the list on a destructive/terminal action
  (a Project set to `done`, or now deleted) is held struck-through with an inline
  **Undo** for ~5s (`DONE_UNDO_MS`), then the write commits. This is the
  todo-app's chosen idiom for row-leaving actions. A separate `ConfirmDialog`
  primitive exists on mobile but is used only for discarding unsaved quick-add
  text, not for row actions. Keep this split; do not converge them.

## The duplication, catalogued

Confirmed by reading all six screens and grepping:

1. **Per-screen helpers copied into every screen** (3 mobile + 3 web):
   - `messageOf(err)` — 7 copies.
   - `useDelayed(active, ms)` — the "only true after N ms" hook, 4+ copies.
   - `useLoadError(api)` — subscribe to the data layer's load-error channel,
     copied on mobile screens (and inlined via `document.visibilitychange` on
     web).
   - `LOADING_TEXT_DELAY_MS = 1000` constant, copied.
   - The **foreground-refetch effect** (`AppState`/`visibilitychange` →
     `api.refetch()`), copied.
   - The **write-error idiom**: `const tx = api.X(); tx.isPersisted.promise
     .catch((e) => setWriteError(messageOf(e)));` — repeated at every call site.
2. **Projects-only, doubled after the delete change** (web + mobile):
   - The Undo-timer machinery: a `Set<string>` of pending ids, a
     `Map<string, timeout>` of timers, `start*` / `undo*` / `commit*` callbacks,
     and an unmount cleanup effect — now present **twice per screen** (`pendingDone`
     and `pendingDelete`) and **twice across surfaces** = four copies of one idea.
3. **Pure, UI-agnostic constants and functions duplicated web ↔ mobile:**
   - `STATUS_LABELS`, `ALL_STATUSES`, `ICON_CHOICES`, `DONE_UNDO_MS`,
     `BACKLOG_COLLAPSE_THRESHOLD` (Projects).
   - `parseLocalDay(date)` and `dayLabel(date, today)` (Upcoming).
4. **Testing gap:** `apps/agent-mobile` has jest coverage of its screens
   (including the Projects undo/commit/status/icon/delete flows). **`apps/agent-web`
   has no test infrastructure at all** — no `test` script, no vitest,
   `@testing-library/react`, or jsdom. Every web screen's logic (undo timers,
   status grouping, sheet wiring, delete) is unverified.

## Approach: three deep modules plus a test surface

Apply the deletion test to each candidate: deleting the shared module would
re-spread its complexity across four call sites (done-web, delete-web,
done-mobile, delete-mobile for the undo hook; all six screens for the helpers).
That is the signal these are real deep modules, not pass-throughs. Dependency
category for all of them is **in-process** (pure computation and pure React
state; no I/O), so they are merged and tested directly through their interface —
no ports, no adapters.

Sequence the work so each slice is independently shippable and lands with its
tests. Slices 1 and 2 are pure agent-core additions with no React; slice 3 makes
the React-peer decision; slice 4 is the safety net that should ideally land
alongside 1–3 to prove no regression on web.

### Slice 1 — Move the pure Project/Upcoming constants and helpers into agent-core

Lowest risk, no new dependency. Move surface-agnostic data and pure functions to
`@zero/agent-core`, next to the existing `projects/sections.ts` and
`captures/dates.ts`:

- `projects/labels.ts` (or fold into `sections.ts`): `STATUS_LABELS`,
  `ALL_STATUSES`, `ICON_CHOICES`, `DONE_UNDO_MS`, `BACKLOG_COLLAPSE_THRESHOLD`.
- `captures/dates.ts`: add `dayLabel(date, today)` and its `parseLocalDay` helper
  (pure, already uses `Intl` + the existing `tomorrow`).
- `collection/view.ts` or a shared consts module: `LOADING_TEXT_DELAY_MS`.
- A tiny `messageOf(err)` in agent-core (pure).

Both surfaces import these instead of redeclaring them. Export from
`packages/agent-core/src/index.ts`.

Rationale: these are pure values/functions with no React and no DOM, so they
belong in the package that already holds `projectsByStatus`, `visibleCaptures`,
and `tomorrow`. One source of truth for the icon set and status labels also means
web and mobile can never drift (today they are hand-kept in sync).

### Slice 2 — Extract the undoable-leave hook (consolidate `pendingDone` + `pendingDelete`)

The freshest, highest-leverage cleanup. Replace the two parallel
`pending*`/`*Timers`/`start*`/`undo*` blocks in each Projects screen with one
hook:

```
useUndoableLeave(): {
  pending: Set<string>;               // ids currently held with an Undo
  start(id: string, commit: () => void): void;  // hold, then run commit after the window
  undo(id: string): void;             // cancel the pending commit
}
```

It owns the `Set`, the timer `Map`, and the unmount cleanup. Done calls
`start(id, () => api.setStatus(id, 'done'))`; Delete calls
`start(id, () => api.remove(id))`. The window (`DONE_UNDO_MS`) is a parameter with
that default. The row renders struck-through with an Undo whenever `pending.has(id)`,
and one `undo` handler serves both (no more routing between `pendingDone` and
`pendingDelete`).

Deletion test: removing this hook puts the timer/set/cleanup logic back into four
places. It concentrates complexity → it earns its keep. The interface is small
(three members) and the behavior behind it (deferred commit, cancel, leak-free
cleanup) is the whole point — a deep module.

Placement depends on slice 3's decision. **Outcome:** the hook landed per-app
(one copy in each app's `screen-hooks` module), not in agent-core — see slice 3.

Placement depends on slice 3's decision. If agent-core takes a React peer
(recommended at plan time), the hook lives there and both surfaces share it. If
not, extract it once per surface (still removes the within-file doubling, just
not the cross-surface copy).

### Slice 3 — Share the cross-surface hooks

**Outcome (what shipped):** the hooks live in one `screen-hooks` module **per
app** (`apps/agent-web/src/lib/screen-hooks.ts` and the mobile mirror), and
`@zero/agent-core` stays React-free. The agent-core-peer approach below was tried
first and reverted: a source-linked workspace lib that calls React hooks resolves
its **own** React copy (agent-core's devDep 19.2.8 vs the mobile app's pinned
19.2.3), and two React instances trip the rules-of-hooks dispatcher — it broke
the mobile jest suite immediately and would risk the same in the Metro/Vite
bundles, which cannot be verified on this box. Per-app copies of ~30 lines of
trivial hooks are the safe trade. The pure constants/helpers still live in
agent-core (slice 1); only the React hooks are per-app.

The original (rejected) plan follows for the record.

Add `react` as a `peerDependency` (and dev dependency) of `@zero/agent-core`,
then house the React hooks there:
`useDelayed`, `useLoadError`, `useForegroundRefetch(api)` (the AppState /
visibilitychange effect, injected with the platform's foreground signal), the
`useUndoableLeave` hook from slice 2, and optionally a `useWriteError()` returning
`[error, run]` where `run(tx)` wires the `isPersisted.promise.catch(messageOf)`
idiom.

Two open decisions to settle before building:

- **Single entry vs `/react` subpath.** Since no non-React package imports
  agent-core, a single `.` entry is fine and simplest. The safer, more explicit
  option is a `@zero/agent-core/react` subpath export so the React dependency is
  visible in import paths and a future non-React consumer can never pull hooks in.
  Recommendation: single entry now, note the subpath as the escape hatch.
- **`useForegroundRefetch` seam.** Web listens on `document.visibilitychange`,
  mobile on `AppState`. The hook cannot reference either global. Inject the
  platform's "app became active" subscription as a small function argument, so the
  hook stays platform-agnostic and each app passes its one-line adapter. This is
  an internal seam, not a port (one real implementation per app; not something
  that varies at test time).

Risk: adding React to agent-core touches its build/lint config. Mitigated by the
fact that the Worker never imports it, and the hooks use only `useState` /
`useEffect` / `useRef` (no DOM, no react-dom, no react-native), so both apps'
Reacts satisfy the peer.

### Slice 4 — Stand up web test infrastructure and cover the shared behavior

Close the coverage gap and prove slices 1–3 changed nothing on web. Add to
`apps/agent-web`: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`,
`jsdom`, a `test` script, and a vitest config. Port the mobile Projects tests to
web (status change from the sheet, icon edit, Done deferred-behind-Undo + commit,
Delete deferred-behind-Undo + commit, empty/loading/error states). Add
agent-core unit tests for the extracted hooks (`useDelayed`, `useUndoableLeave`)
and the moved pure helpers (`dayLabel`, the label/icon constants' shape).

Test at the interfaces (the deep modules' surfaces), not internal state:
`useUndoableLeave` is tested for "commit fires after the window, not before" and
"undo cancels the commit"; the web screens are tested through rendered output and
fired events, mirroring the mobile suite so both surfaces assert the same
behavior.

## What to change and why (summary)

- `packages/agent-core` — new pure modules (constants, `dayLabel`, `messageOf`)
  and, after the React-peer decision, a hooks module; widened `index.ts` exports;
  `package.json` gains a `react` peer + dev dep.
- `apps/agent-web/src/pages/{ProjectsPage,HomePage,UpcomingPage}.tsx` and
  `apps/agent-mobile/src/app/(signed-in)/{index,projects,upcoming}.tsx` — delete
  the local helper/constant copies and the `pending*` machinery; import the shared
  versions. No behavior change.
- `apps/agent-web` — add the test toolchain and a Projects test suite.

## Test strategy

- New agent-core unit tests for the extracted hooks and pure helpers (vitest,
  already configured there).
- New web screen tests (vitest + @testing-library/react) mirroring the mobile
  jest suite, so the shared behavior is asserted on both surfaces.
- The existing mobile jest suite is the regression oracle for the refactor: it
  must stay green with no test edits beyond import-path changes. Per the
  deep-modules rule, replace (do not layer) any old per-screen helper tests with
  tests at the shared interface; there are none today for these helpers, so this
  is purely additive.
- Run per package: `pnpm --filter @zero/agent-core run test`, the mobile jest
  run, and the new `pnpm --filter @zero/agent-web run test`, plus `lint` and
  `typecheck` on all touched packages.

## Documentation

- `docs/storage.md` / `docs/todo-app.md`: note that the shared list-screen
  helpers and the undoable-leave idiom now live in `@zero/agent-core` (one source
  of truth), and that `ICON_CHOICES` / `STATUS_LABELS` are shared so the surfaces
  cannot drift.
- `docs/entities/project.md`: point the UI section at the shared constants/hook
  rather than restating them.
- No changelog entry: this is purely internal (refactor + tests), which the
  changelog rule excludes.

## Skills to use

- `deep-modules` — for shaping `useUndoableLeave` and the shared hooks as deep
  modules at internal seams (classify deps as in-process; no ports).
- `vocabulary` — keep the plan's and code's terms precise (module, interface,
  seam, deep).
- `tdd` — the hooks and pure helpers are unit-testable; write the test first,
  especially the undo "commit after window / undo cancels" cases.
- `testing` — when standing up the web test toolchain and deciding what to assert
  through the rendered interface vs internal state.
- `git-commit` — commit each slice separately (they are independently shippable).

## Acceptance criteria

- No user-visible change on either surface: Projects, Captures, and Upcoming
  render and behave exactly as before (verified by the mobile suite staying green
  and the new web suite passing).
- `pendingDone` and `pendingDelete` are gone, replaced by one `useUndoableLeave`
  usage per screen; the Undo-timer logic exists in exactly one place.
- `messageOf`, `useDelayed`, `useLoadError`, the foreground-refetch effect,
  `LOADING_TEXT_DELAY_MS`, `STATUS_LABELS`, `ALL_STATUSES`, `ICON_CHOICES`,
  `DONE_UNDO_MS`, `BACKLOG_COLLAPSE_THRESHOLD`, `parseLocalDay`, and `dayLabel`
  each exist once, in `@zero/agent-core`.
- `apps/agent-web` has a `test` script and a passing Projects suite covering
  status change, icon edit, and the Done/Delete Undo-and-commit flows.
- Lint and typecheck pass for `@zero/agent-core`, `@zero/agent-web`, and
  `@zero/agent-mobile`; the API worker is untouched (it does not import
  agent-core).

## Risks and mitigations

- **React peer in agent-core** could, in theory, reach the Worker bundle.
  Mitigated: `apps/agent-api` does not import `@zero/agent-core` (grep-verified);
  the hooks use no DOM/react-dom/react-native.
- **A refactor silently changes timing** (e.g. the undo window or the loading
  delay). Mitigated: the constants move verbatim, and the mobile suite plus the
  new web suite pin the commit-after-window behavior.
- **Scope creep into UX changes.** Explicitly out of scope: converging the
  Undo idiom with `ConfirmDialog`, adding a visible countdown/toast, or restyling
  the delete button. Those are features, not tightening.

## Explicitly not doing (kept as-is on purpose)

- The two entity-api singletons (`apps/agent-web/src/lib/entity-api.ts` and
  `apps/agent-mobile/src/lib/entity-api.ts`) stay per-surface: their differences
  (cookie vs Clerk token, OPFS vs op-sqlite, browser vs native outbox) are real,
  and the shared mechanics already live in the collection factory.
- The `delete` verb kind's dropped `Row` type param (asymmetric with
  `insert`/`update`, which keep it) stays: `Row` is genuinely unused for delete.
