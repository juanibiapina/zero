# Plan: create a Project from the Home + button, with a toast that links to it

## Goal

On both surfaces (web `HomePage`, mobile Home `(signed-in)/index.tsx`), add a
third **Project** option to the Home quick-add. Submitting in Project mode
creates a name-only project (exactly what the Projects screen already does),
**leaves the user on Home**, and shows a small toast that links to the new
project's detail screen. Tapping the toast navigates to the project; the toast
also auto-dismisses.

## Context a fresh agent needs

- **Quick-add already has a mode toggle** on Home: `capture | task`.
  - Web: `apps/agent-web/src/pages/HomePage.tsx`, local `QuickAdd` component,
    `AddMode = "capture" | "task"`, rendered as a radiogroup. `onAdd` branches on
    `mode`.
  - Mobile: the mode is threaded through
    `apps/agent-mobile/src/components/quick-add.tsx` →
    `quick-add-bar.tsx` (`QuickAddMode`/`QuickAddBarMode = 'capture' | 'task'`),
    where the toggle maps over a hardcoded `['capture', 'task'] as const`. Home
    (`(signed-in)/index.tsx`, the `Captures` component) owns `mode` state and the
    `onAdd` branch.
- **Name-only project creation already exists.** Both Projects screens call
  `projectsApi.add(trimmed, refiningCaptureId())`. `add` (in
  `packages/agent-core/src/projects/collection.ts`) returns a TanStack DB
  `Transaction`; the project's id is **client-minted inside** the insert verb
  (`mintRow` in `packages/agent-core/src/collection/base.ts`). The optimistic
  row's title is the trimmed text, icon defaults to `DEFAULT_ICON` (📁), status
  `next`.
- **Reading the new id:** the localized way is to read it off the returned
  transaction at the Home call site — `const tx = projectsApi.add(trimmed);
  const id = String(tx.mutations[0]?.key);` — the same `mutations[].key` the base
  factory uses internally. This keeps `@zero/agent-core` untouched. (Alternative
  considered and rejected: change `ProjectsApi.add` to return `{ id, tx }`, which
  ripples through both existing Projects screens for no other benefit.)
- **Project detail destinations exist.** Web `/projects/:id`
  (`<Route path="projects/:id">` in `apps/agent-web/src/App.tsx`), navigated with
  react-router. Mobile `router.navigate('/projects/${id}')` (a pushed screen in
  the Projects tab, `(signed-in)/projects/[id].tsx`). Navigating there from Home
  switches tabs — acceptable; the detail screen already handles being entered
  directly.
- **`refiningCaptureId()`** — when a refine session is active, passing it to
  `add` links the new project back to its source capture (the Projects screen
  does this). Pass it from Home too for parity; it's `null` otherwise.

## Toast approach: use libraries (decided)

Research established there is **no native toast primitive** to lean on (`@expo/ui`
SDK 57 ships none; iOS HIG has no toast; Android's native `Toast` is
non-interactive). Compatibility was the only open question and it is resolved:

- **Web → `sonner`.** The shadcn-endorsed toast (Radix `Toast` is deprecated).
  Pure React, works with the existing Tailwind/shadcn CSS variables, supports an
  `action` button. No compatibility risk.
- **Mobile → `sonner-native`.** `sonner-native@0.27.0` targets **Reanimated 4**
  and the split `react-native-worklets`, matching this app's stack exactly. Peer
  deps vs installed: reanimated `^4.1.1` (have 4.5.1) ✅, worklets `>=0.6.1` (have
  0.10.1) ✅, gesture-handler `>=2.28.0` (have 2.32.0) ✅, safe-area-context
  `^5.6.0` (have 5.7.0) ✅, screens `^4.16.0` (have 4.26.2) ✅, and
  **`react-native-svg ^15.12.1` — currently absent, must be added.** Uniwind is
  not a blocker: sonner-native styles via `style`/`styles` props (NativeWind is
  optional), and Uniwind (a NativeWind drop-in) documents third-party-lib
  integration.

Both give the same imperative `toast(...)` API with an action, swipe-to-dismiss,
stacking, and dark mode, so web and mobile behave alike.

## What to change

### 1. Install and mount the toasters

- **Mobile:** `npx expo install react-native-svg sonner-native` (use
  `expo install` so versions match SDK 57). Mount `<Toaster />` (from
  `sonner-native`) once at the app root
  (`apps/agent-mobile/src/app/_layout.tsx`), inside `GestureHandlerRootView`.
  Verify a `SafeAreaProvider` ancestor exists (sonner-native uses safe-area
  context); the current root has none, so add `SafeAreaProvider`
  (`react-native-safe-area-context`) around the tree if the Toaster needs it.
- **Web:** add `sonner`; mount `<Toaster />` once in `AppShell`
  (`apps/agent-web/src/App.tsx`), inside the router so a toast action can
  navigate. Style it to the app theme the shadcn way (theme + CSS variables), or
  keep defaults for v1.

Adding `react-native-svg` is a **native** module, so the first on-device run
needs a fresh **EAS dev build** (pure-JS changes hot-reload; this one does not).

### 2. Extend the quick-add mode to three options

- Web `HomePage.tsx`: widen `AddMode` to `"capture" | "task" | "project"`; render
  the third radio; branch `onAdd` on `mode === "project"`.
- Mobile `quick-add.tsx` + `quick-add-bar.tsx`: widen the mode types to include
  `'project'`; extend the toggle array to `['capture', 'task', 'project'] as
  const`; wire the Home `onAdd` project branch.
- Project-mode placeholder should teach outcome naming (mirror the Projects
  screen's `"Run a 5K under 30 min"` / helper-text spirit; at minimum a distinct
  placeholder like "Name a project outcome").
- Keep the user on Home in every mode (no navigation on submit); clear the input
  and keep the bar open for rapid entry, as capture/task already do.
- Verify the three pills still fit the mobile quick-add bar on a narrow device.

### 3. Create the project, capture its id, raise the toast

In each Home `onAdd`, for project mode:

```
const trimmed = text.trim();
if (!trimmed) { /* existing empty-submit behavior */ return; }
const tx = projectsApi.add(trimmed, refiningCaptureId());
tx.isPersisted.promise.catch((e) => setError(messageOf(e))); // same error path
const id = String(tx.mutations[0]?.key);
toast("Project created", {              // sonner / sonner-native
  description: trimmed,
  action: { label: "View", onClick/onPress: () => navigate/ router.navigate(`/projects/${id}`) },
});
setText("");
```

- Web uses `useNavigate` from react-router in the toast action; mobile uses
  `router.navigate`.
- Home already receives `projectsApi` on both surfaces (used for task icons and
  the CTA), so no new data wiring.

## Tests to add or update

- **Web** (`apps/agent-web/src/pages/HomePage.test.tsx`, Vitest + Testing
  Library, exists): selecting Project mode and submitting calls the fake
  projects api's `add`, the user stays on Home (no route change), and a toast
  appears with a "View" action; invoking it navigates to `/projects/<id>`. Mock
  `sonner`'s `toast` and assert the call + action.
- **Mobile** (`apps/agent-mobile/src/app/(signed-in)/__tests__/index.test.tsx`
  and `components/__tests__/quick-add-bar.test.tsx`): the three-way toggle
  renders and switches; submitting in Project mode calls `projectsApi.add` and
  fires `toast` with an action that calls `router.navigate('/projects/<id>')`.
  Mock `sonner-native`'s `toast`.
- Extend the quick-add mode-toggle test for the new `project` option.

## Docs to update

- `docs/todo-app.md` — Project-tracking "Shipped" bullet: Home's + can now create
  a project directly, staying on Home with a toast that links to it. Note the new
  `sonner`/`sonner-native` dependency.
- `apps/agent-web/CHANGELOG.md` — web-facing entry (`- YYYY-MM-DD: …`).
- `apps/agent-mobile/CHANGELOG.md` — mobile-facing entry.

## Skills to use

- **changelog** — load before editing either CHANGELOG.md.
- **expo-ui** — confirm (already done) `@expo/ui` has no toast, so a library is
  the right call on mobile.
- **expo-router** — mobile toast action navigating cross-tab to `/projects/:id`.
- **tdd** — tests first for the mode branch and toast on both surfaces.
- **git-commit** — commit code + tests + changelog + doc together.
- **reproducible-locally** — verify web via `pnpm --filter @zero/agent-web run
  test|lint|typecheck` (this NixOS box has no workerd); mobile via the Turbo
  pipeline; on-device Maestro pass deferred until a fresh EAS dev build (needed
  for `react-native-svg`).

## Acceptance criteria

- Web and mobile Home quick-add offers Capture / Task / **Project**.
- Submitting in Project mode creates a name-only project, leaves the user on
  Home, clears the input, keeps the bar open.
- A toast names the project and links to its detail screen; tapping it navigates
  to `/projects/<id>` (web route / mobile pushed screen) and dismisses; the toast
  also auto-dismisses (~5 s).
- Write failures surface the same error path as capture/task adds.
- Tests above pass; web lint/typecheck/test green; `docs/todo-app.md` and both
  changelogs updated in the same change.

## Risks

- **`tx.mutations[0].key` id read** depends on the transaction being populated
  synchronously after `insert` (the base factory already relies on this). If it
  proves brittle under test, fall back to having `ProjectsApi.add` mint and
  return the id.
- **New native dep (`react-native-svg`)** forces a fresh EAS dev build before the
  mobile toast runs on device; plan the device verification around that.
- **sonner-native + SafeAreaProvider**: confirm the root provides safe-area
  context; add `SafeAreaProvider` if the Toaster requires it.
- **Toggle width** on the mobile quick-add bar with three pills on a narrow
  device.
