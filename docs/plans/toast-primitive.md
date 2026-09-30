# Plan: a hand-rolled, reusable Toast primitive (headless core + per-surface renderers)

## Goal

Replace the third-party toast (sonner on web, sonner-native on mobile) with an
in-house toast primitive designed as if it were a standalone publishable package:
a **headless, framework-agnostic controller** (the deep module) plus two thin
**renderer adapters** (web DOM, mobile React Native). The immediate consumer was
the "create a Project from Home → toast that links to it" feature, but the primitive is general and
carries no app or navigation knowledge.

This exists because no maintained toast library renders on our stack: sonner-native
collapses on New Architecture + react-native-screens (verified on-device; issue
`gunnartorfis/sonner-native-toasts#316`), and react-native-toast-message has an
open New-Architecture regression (`calintamas/react-native-toast-message#583`).
See `docs/investigations/` context in the home plan.

## The shape: one deep module, two adapters

The design is Ports-&-Adapters with the **render seam** as the boundary:

- **Deep module — the toast controller** (`@zero/agent-core`, React-free). Tiny
  interface, large behavior: minting ids, queueing, de-duplicating/replacing by
  id, auto-dismiss timers, max-visible capping, and an observable snapshot. All
  the logic a caller never wants to re-implement lives here. Dependency category
  is **in-process** (in-memory state + `setTimeout`), so it is tested directly
  through its interface with fake timers — no port inside it.
- **Two renderer adapters** (one per surface) that read the controller through
  its observable seam and paint toasts. Two real adapters (web + mobile) justify
  the seam. They cannot be shared: `@zero/agent-core` is deliberately React-free
  (documented: a workspace lib calling React hooks resolves its own React copy
  and trips rules-of-hooks; see `docs/todo-app.md`), and web renders DOM while
  mobile renders React Native — so each app owns its `<Toaster>` and a ~6-line
  `useToasts()` hook, exactly as the repo already splits `screen-hooks` per app.

Deletion test: delete the controller and both apps re-grow the same store +
timer + dedupe logic (today's `refine-session.ts` is already copy-pasted across
web and mobile for a far simpler store — the toast is more logic and must not be
duplicated). Delete a renderer and that surface loses its toast. Both earn keep.

### Interface (the publishable surface — keep it this small)

Framework-neutral, in `@zero/agent-core`:

```
type ToastAction = { label: string; onPress: () => void };
type ToastInput = {
  message: string;
  description?: string;
  action?: ToastAction;
  durationMs?: number;   // default from controller; Infinity = sticky
  id?: string;           // caller-supplied key; re-show replaces in place
};
type Toast = Required<Pick<ToastInput,'message'>> & ToastInput & {
  id: string; createdAt: number;
};

type ToastController = {
  show(input: ToastInput | string): string;   // returns the id
  dismiss(id?: string): void;                  // no id = dismiss all
  subscribe(cb: () => void): () => void;       // observable seam
  getSnapshot(): readonly Toast[];             // STABLE ref until change
};

createToastController(opts?: { defaultDurationMs?: number; maxVisible?: number }): ToastController

// A module-level default controller + ergonomic bound fn (mirrors sonner):
toast(message: string, opts?: Omit<ToastInput,'message'>): string
toast.dismiss(id?: string): void
```

- `onPress` (not `onClick`) is the neutral name; the web renderer wires it to a
  button `onClick`, the mobile renderer to a `Pressable onPress`.
- `getSnapshot` MUST return the same array reference until a mutation, and mint a
  new one on every change — this is the `useSyncExternalStore` contract, and the
  exact thing sonner-native got right that makes the observable safe.
- The controller knows nothing about navigation, projects, or React. The Home
  feature passes `action: { label: 'View', onPress: () => navigate('/projects/'+id) }`.

Per app (thin adapters, not public):

```
useToasts(): readonly Toast[]         // useSyncExternalStore(controller.subscribe, controller.getSnapshot)
<Toaster />                           // mounted once at the app root
```

## What to change and why

### 1. Add the controller to `@zero/agent-core`

New `packages/agent-core/src/toast/controller.ts` implementing the interface
above, exported from `packages/agent-core/src/index.ts`. Behavior:

- `show`: mint id (reuse the same UUID helper the collections use) unless the
  caller passed one; if the id already exists, replace that toast in place and
  restart its timer; else append. Cap the retained list at `maxVisible` (default
  3) by dropping the oldest. Schedule auto-dismiss after `durationMs`
  (default 4000; `Infinity` skips the timer). Emit.
- `dismiss(id?)`: clear the timer(s), remove the toast(s), emit.
- Snapshot is an immutable array swapped on each mutation.
- Timers via `setTimeout`; store handles are internal.

This is the whole engine. It is pure enough to test with fake timers.

### 2. Web renderer — `apps/agent-web/src/components/Toaster.tsx`

- `useToasts()` hook (local, `useSyncExternalStore` over the default controller).
- A fixed, `pointer-events-none` container (default bottom-center) mapping toasts
  to rows; each row is `pointer-events-auto`, shows `message` (+ optional
  `description`) and, when present, an action `<button onClick={action.onPress}>`.
- Accessibility: container `role="status"` `aria-live="polite"`.
- Enter/exit animation with **CSS only** (no new dep): a keyframe/transition on
  mount for enter; for exit, the renderer keeps a local rendered list, marks
  removed ids as leaving (`data-state="closed"`), and unmounts them after the
  exit duration (a ~20-line internal seam, so the controller stays pure).
- Mount once in `AppShell` (`apps/agent-web/src/App.tsx`), inside the router so an
  action can navigate — replacing the current `<Toaster/>` from sonner.

### 3. Mobile renderer — `apps/agent-mobile/src/components/toaster.tsx`

- `useToasts()` hook (local).
- An absolutely-positioned `pointerEvents="box-none"` container near the top,
  offset by `useSafeAreaInsets().top` (the app already uses this widely; the root
  now has a `SafeAreaProvider`). High `elevation` + `zIndex` so it sits above
  content.
- Each toast is an `Animated.View` (reanimated) with `entering={FadeInUp}`
  `exiting={FadeOutUp}`. The former `components/quick-add.tsx` implementation
  demonstrated FadeIn/FadeOut on-device before it was removed. Exit plays on
  unmount when the controller drops the toast. No height measurement, no dynamic
  stack math (that measurement path is exactly what broke sonner-native on our
  stack).
- Row shows `message` and, when present, a `Pressable onPress={action.onPress}`
  styled with Uniwind classes, mirroring `RefineBanner`.
- Mount once in `apps/agent-mobile/src/app/_layout.tsx` (inside
  `GestureHandlerRootView` + `SafeAreaProvider`) — replacing the sonner-native
  `<Toaster/>`. **No native module is added**, so it runs on the *current* dev
  client (build 51) over Metro — no EAS rebuild to verify.

### 4. Repoint the Home feature and remove the libraries

- Web `HomePage.tsx`: import `toast` from `@zero/agent-core` instead of `sonner`;
  keep the call `toast('Project created', { description: title, action: { label:'View', onPress: () => navigate('/projects/'+id) } })`.
- Mobile `(signed-in)/index.tsx`: import `toast` from `@zero/agent-core` instead
  of `sonner-native`; action `onPress: () => router.navigate('/projects/'+id)`.
- Remove deps: `sonner` (web); `sonner-native` **and** `react-native-svg`
  (mobile — svg was only sonner-native's). Note `apps/agent-mobile/package.json`
  is currently pinned to `sonner-native@0.24.0` from on-device testing; this
  removal supersedes it.

## System-wide impact

- Only the two Home surfaces call `toast` today; the blast radius is small.
- Removing `react-native-svg` means a *future* EAS dev build won't include it; the
  current build still has it (unused) — harmless. No rebuild is required for this
  change because the new mobile renderer uses only modules already in the client
  (reanimated, gesture-handler, safe-area-context).
- `SafeAreaProvider` added earlier to `_layout.tsx` stays (the toast needs the top
  inset; it is idempotent alongside expo-router's own provider).

## Implementation phases

1. **Controller in agent-core** + unit tests (interface + fake timers). Green in
   isolation before any UI.
2. **Web renderer** + mount in AppShell + repoint `HomePage`; web renderer test
   and repoint the existing `HomePage.test.tsx` project-mode test off the sonner
   mock onto the real controller/Toaster.
3. **Mobile renderer** + mount in `_layout` + repoint `index.tsx`; mobile renderer
   test and repoint `index.test.tsx` off the `sonner-native` mock.
4. **Remove `sonner`, `sonner-native`, `react-native-svg`**; changelog + docs.
5. **On-device verification** on the Pixel 7 (Metro hot-reload, no rebuild): run
   the `project-toast.yaml` Maestro flow — assert the toast appears and its "View"
   action opens the project. Contingency: if a root-mounted mobile Toaster is
   still covered by NativeTabs/native-stack, mount it inside the Home screen's own
   RN tree instead (acceptable — Home is the only caller today); this is a render
   seam move, no controller change.

## Test strategy

- **Controller (`@zero/agent-core`, vitest):** the interface is the test surface.
  Cover: `show` returns an id and appends; auto-dismiss after `durationMs` (fake
  timers); `dismiss(id)` removes; re-`show` with the same id replaces in place and
  restarts the timer; `maxVisible` drops the oldest; `getSnapshot` returns a
  stable reference until a change and a fresh one after; `subscribe` is notified
  and unsubscribes cleanly; `Infinity` duration never auto-dismisses. No renderer
  in these tests.
- **Web renderer (vitest + @testing-library/react):** rendering a toast shows the
  message + action; clicking the action fires `onPress`; auto-dismiss removes the
  row.
- **Mobile renderer (jest + @testing-library/react-native; reanimated already
  mocked in `jest.setup.js`):** shows the message + action; pressing the action
  calls `onPress`.
- **Repoint existing feature tests** (`HomePage.test.tsx`, `index.test.tsx`) from
  the sonner/sonner-native mocks to the new module. Simplest: mock the tiny
  `toast` fn from `@zero/agent-core` and assert it is called with the message +
  an action whose `onPress` navigates — keeping each test's current intent (create
  project → toast → View navigates), no snapshot/pollution concerns.
- **On-device:** the Maestro flow above (already written).

## Documentation

- `packages/agent-core/src/toast/controller.ts` — a header comment stating the
  interface contract (stable-snapshot rule, dedupe-by-id, timer ownership).
- `docs/todo-app.md` — update the "create a Project from Home" Shipped bullet to
  say the toast is our own primitive (drop the sonner/sonner-native mention).
- `apps/agent-web/CHANGELOG.md` / `apps/agent-mobile/CHANGELOG.md` — the existing
  "create a project from Home" entries stay user-facing and unchanged (the user
  sees the same toast); no new entry needed (swapping the toast engine is
  internal). Confirm the entries don't name a library (they don't).
- This plan is the source of truth for the primitive's design.

## Skills to use

- **deep-modules** — keep the controller deep and the renderers thin; don't leak
  the internal web-exit seam through the interface.
- **vocabulary** — module / interface / seam / adapter, used as above.
- **tdd** — controller tests first, then each renderer.
- **testing** — interface-level tests; reanimated mock already exists for jest.
- **changelog** / **documentation** — for the doc updates.
- **reproducible-locally** — web via `pnpm --filter @zero/agent-web test|lint|typecheck`;
  agent-core via `pnpm --filter @zero/agent-core test`; mobile via the Turbo
  pipeline; then the Pixel 7 Maestro flow over Metro (no rebuild).
- **git-commit** — commit engine + renderers + repoint + dep removal + docs together.

## Acceptance criteria

- `@zero/agent-core` exports `toast`, `createToastController`, and the toast types;
  its unit tests pass.
- Web and mobile each mount one `<Toaster>` and render toasts via the shared
  controller; renderer tests pass.
- Creating a project from Home shows a toast naming it with a working "View" link
  (web route + mobile pushed screen), verified **on the Pixel 7 over Metro with no
  EAS rebuild**.
- `sonner`, `sonner-native`, and `react-native-svg` are gone from the package
  manifests; `package.json` no longer pins `sonner-native@0.24.0`.
- web lint/typecheck/test green; agent-core test green; docs/changelogs consistent.

## Outcome (shipped 2026-09-08)

Built as designed: the headless controller in `@zero/agent-core`, a web renderer
(`apps/agent-web/src/components/Toaster.tsx`, CSS enter/exit) and a mobile renderer
(`apps/agent-mobile/src/components/toaster.tsx`, reanimated FadeIn/FadeOut), each
mounted once at the app root. `sonner`/`sonner-native`/`react-native-svg` removed.
Device-verified on the Pixel 7 (Maestro) with **no EAS rebuild** — the mobile
renderer adds no native module.

Two deviations from the first sketch:

- **Mobile deep link deferred.** A cross-tab `router.navigate('/projects/<id>')`
  into a NativeTabs stack screen does not land (expo/expo#45786, needs a native
  fix). The mobile View action opens the Projects tab (`/projects`), where the new
  project is on top; web still opens the exact detail. Revisit the deep link when
  the upstream fix ships.
- **Maestro taps the toast by point.** uiautomator misreports the elevated
  overlay's bounds, so `tapOn: 'View'` lands off the button; the dev flow taps its
  on-screen position instead. This is a test-harness quirk only — a real finger
  tap fires the action (verified).

## Risks and mitigations

- **Mobile root z-order** (the sonner failure mode): mitigated by using the proven
  reanimated FadeIn/FadeOut pattern and a fixed (unmeasured) position, plus a
  documented fallback to in-screen mounting if the root overlay is still covered.
  Verified on-device before merge.
- **Web list exit animation without a dep**: contained to a ~20-line internal seam
  in the web renderer; if it proves fiddly, ship enter-only animation (instant
  removal) for v1 — the controller is unaffected.
- **`getSnapshot` stability**: if the array reference churns, `useSyncExternalStore`
  loops; the controller tests assert stable-until-change to lock this.
- **Over-scoping**: keep v1 to message + description + one action + auto-dismiss +
  maxVisible. No promise/loading/variants/swipe-to-dismiss until a second caller
  needs them (Rule of Three).
```
