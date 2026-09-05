# Rework the project detail: make it a destination, not a drawer

Rework what opens when you tap a project. Today it opens a **bottom sheet** stuffed with
a stack of forms — a big emoji grid, a Title field, a Notes box, the tasks, a waiting
builder full of selects, status buttons, delete — and on mobile the tasks/waiting rows
render broken inside that sheet. This plan changes the **container**: a project becomes a
**destination you navigate into** (a pushed screen on mobile, a `/projects/:id` route on
web), and sheets/menus are demoted to the short sub-interactions they are good at. It is
**UI/navigation only**: no data model, API, store, collection, or derivation-helper change.

## Bottom line

1. **A project is a place you work, so it gets its own screen, not a drawer.** Grooming a
   task list — completing, taking on/parking, adding tasks, recording what a project waits
   on — is dwell-and-navigate work, which the bottom-sheet guidance explicitly says not to
   put in a sheet. Navigate into the project (native Back on mobile, a route on web).
2. **Sheets/menus stay — demoted to the short forks:** the icon picker, the status move,
   the waiting-kind picker, the delete confirm. Those are the correct use of a sheet.
3. **This dissolves the broken mobile renderer** instead of patching it: a pushed Expo
   Router screen is an ordinary React Native view tree, so the task/waiting rows render
   like every other list screen — the "RN-inside-`@expo/ui`" bug simply cannot occur there.

## Goal

When you tap a project you land on the project's own screen: its work is the body (tasks,
then what it's waiting on), its identity is a compact header (icon, editable title, derived
status), and management (status moves, notes, delete) is tucked into a header menu. It
reads as "here is this project's work," and Back returns you to the list.

## Why a destination, not a drawer (research basis)

- **NN/G, "Bottom Sheets" (2024):** "**Do not use a bottom sheet to replace typical
  page-to-page user flows.** A bottom sheet is a transient UI element… for interruptions or
  a fork in the road, rather than the expected 'happy path.'" And: "Use bottom sheets
  **only for short interactions**… not when users will likely spend significant time
  reviewing the information or options displayed inside it." Their canonical anti-example is
  opening a *detail page you navigate within* in a sheet — exactly this screen's shape.
- **Apple HIG, Modality:** "**Don't create an app within your app.** … Be especially wary
  of creating modal tasks that involve a hierarchy of views." The current sheet nests a task
  list, an icon picker, and a waiting-condition builder-with-sub-selects.
- **Material 3 / HIG on sheets vs full screen:** sheets present "supplementary content
  without navigating to a new screen"; full screens are for "complex tasks / extended
  interaction / multiple decisions or states."
- **The analog apps split container from leaf:** in **Things** and **Todoist** a *project*
  is a full destination with its task list (you navigate into it); a single *task* gets a
  panel/sheet ("task view" in Todoist, "peek" in Linear). A container you work inside is a
  destination; a single leaf item is a sheet/panel. Our Project is a container.

## Current state (verified)

- **Web** — `apps/agent-web/src/pages/ProjectsPage.tsx`. Tapping a row opens the shared
  `Sheet` (`components/ui/sheet.tsx`, a `@radix-ui/react-dialog` slide-up) with
  `ProjectDetail`: Icon grid → Title → Notes → Tasks (`ProjectTasks`) → Waiting
  (`ProjectWaits`, an always-open kind `<select>` + param fields) → Status
  (`StatusControls`) → Delete. Router is react-router v7 (`BrowserRouter`, nested routes in
  `App.tsx` under `AppShell`, which renders the `SideNav`). A detail-route precedent already
  exists: `admin/users/:userId` → `UserDetailPage`.
- **Mobile** — `apps/agent-mobile/src/app/(signed-in)/projects.tsx`. Tapping a row opens the
  shared mobile `Sheet` (`components/ui/sheet.tsx`, an `@expo/ui` `BottomSheet`) whose body
  is an `@expo/ui` `Column` — into which the Tasks and Waiting sections drop **raw React
  Native** `View`/`Pressable`/`Text`/`Input` rows and a raw `Pressable` Delete. The
  `@expo/ui` native host does not lay those out, so they render broken on device (the
  root cause; see the previous investigation below). Router is Expo Router: a root `Stack`
  (`app/_layout.tsx`, `headerShown: false`) wrapping the `(signed-in)` group, which is a
  `NativeTabs` navigator (`(signed-in)/_layout.tsx`) with Today / Upcoming / Projects tabs.
- **Shared derivation (do not touch)** — `projectDisplayStatus`, `conditionSatisfied`,
  `unresolvedConditions`, `homeTasks` in `@zero/agent-core`
  (`packages/agent-core/src/projects/derive.ts`). Stores, `/api/*` routes, and the TanStack
  DB collections are unchanged.
- **Model reference** — the throwaway prototype `docs/prototypes/todo-model.html`. Its
  "backstage" project card is the content model: summary (status dot · icon · title ·
  derived-status pill · open-task count), the status moves, then the **tasks** (each with a
  ★ take-on toggle) with an inline add, then the **waiting conditions** with a single "+
  Waiting condition" action. This plan puts that content on a screen instead of in a sheet.

## Root cause of the broken mobile renderer (retained finding)

`@expo/ui` renders a real native tree (SwiftUI/Jetpack Compose); its host only accepts
`@expo/ui` children, and embedding a React Native view requires wrapping it in `RNHostView`.
The mobile `ProjectDetail` violates this by putting raw RN rows inside the `@expo/ui`
`Column`. Corroboration: the one mobile sheet that works (`CaptureDetail` in `index.tsx`) is
a **pure** `@expo/ui` tree; and the mobile test mocks `@expo/ui` into RN passthroughs, so
the suite is green while the device is broken — **this class of bug is invisible to jest**.
Moving the project detail to a pushed RN screen removes the `@expo/ui` host entirely, so the
rows become ordinary RN like the Captures/Projects list rows and the bug cannot recur.

## How to think about each interaction

The rule from the research: **does it ask the user to dwell and navigate (→ destination), or
is it a quick pick/confirm (→ sheet / menu / popover)?**

| Element | Nature | Surface |
|---|---|---|
| **The project** | Dwell + navigate (groom) | **Destination**: pushed screen (mobile) / `/projects/:id` route (web) |
| **Title / rename** | Quick edit | Inline-editable heading on the screen (commit on blur), not a labeled field |
| **Icon** | Rare quick pick | Small **popover/menu** off a de-emphasized header glyph — a correct sheet use |
| **Derived status** | Read-only signal | A subtle pill in the header (it is computed by `projectDisplayStatus`) |
| **Status moves** (in play / backlog / done) | Occasional command | **Header overflow menu** (or small action sheet), not always-visible buttons |
| **Tasks** (complete / take-on / add) | The core dwell work | A real list on the screen with an inline composer |
| **Waiting conditions** | Occasional add | Section on the screen; kind-picker **revealed on "+"** (progressive disclosure) |
| **Notes** | Secondary | Inline "Add notes" expander, below the work |
| **Delete** | Rare + destructive | Header overflow menu, behind the existing ~5s Undo (+ a confirm) |

Sheets do not disappear; they get their correct scope: icon pick, status move, waiting-kind
pick, delete confirm. The **Captures** detail (a single leaf item) correctly **stays a
sheet** — do not touch it.

## Architecture

### Web — a nested detail route

- Add `<Route path="projects/:id" element={<ProjectDetailPage />} />` under `AppShell` in
  `App.tsx`, beside the existing `projects` route (mirrors `admin/users/:userId`). The
  `SideNav` stays (destination within the shell), and browser Back works for free.
- `ProjectsPage` rows become `Link`/`navigate("/projects/" + id)` instead of opening a
  sheet. The list keeps its grouped sections, add field, and the Done/Delete-with-Undo (Undo
  can stay on the list; see Delete below).
- New `ProjectDetailPage` renders the three zones (below). Reuse the existing
  `ProjectTasks` / `ProjectWaits` bodies, re-laid-out; drop the `Sheet` wrapper.
- On a missing id (deleted/bad), redirect to `/projects`.
- Wide-screen master-detail (list + detail side-by-side, Linear/Things style) is a **noted
  future enhancement**, not v1 — v1 is a plain route.

### Mobile — a pushed screen within the Projects tab

- Restructure the Projects tab into a folder with its own stack so the detail pushes over
  the list while the bottom tabs stay visible (the Things/Todoist pattern):
  - `app/(signed-in)/projects/_layout.tsx` → a `Stack` (native header shown on the child).
  - `app/(signed-in)/projects/index.tsx` → the current list screen (the tab body). The
    `NativeTabs.Trigger name="projects"` continues to resolve here.
  - `app/(signed-in)/projects/[id].tsx` → the pushed detail screen (native header + Back).
  - Confirm the exact Expo Router wiring during implementation (nested `Stack` under the
    tab vs. a root-stack push); the requirement is: bottom tabs remain, native Back returns
    to the list. A native navigator change needs a **fresh EAS dev build** to appear.
- The detail screen is an **ordinary RN view tree** (like `index.tsx`/`upcoming.tsx`): a
  `ScrollView`/`SectionList`, the existing `CheckCircle`/`ListRow`/star rows, RN `Input`
  for the composers. No `@expo/ui` `Column` wrapping the body → the render bug is gone.
  `@expo/ui` stays only for the small sub-interaction surfaces (icon picker/status menu),
  used as pure `@expo/ui` trees the way `CaptureDetail` already is.
- Row navigation replaces `setSelectedId`: tapping a project row calls
  `router.push('/projects/' + id)`. Remove the sheet and its `BackHandler`/selection state
  from the list screen (the quick-add and its back handling stay).

## The three-zone layout (on the screen, both surfaces)

- **Header (identity, compact):** a small icon glyph + the **title as an editable heading**
  (commit on blur/Enter); the **derived status** as a subtle read-only pill; a trailing
  **overflow menu** ("⋯") holding *Put in play / Move to backlog / Mark done*, and *Delete
  project*. Tapping the icon opens the emoji picker (web popover/menu; mobile a small pure-
  `@expo/ui` sheet or `Menu`) — the icon is de-emphasized, not an always-open grid.
- **Body (the work, primary):** **Tasks** — the project's open tasks, each with a complete
  control and a take-on/park ★, then an inline "Add a task…" composer. Then **Waiting on** —
  the open conditions (Resolve/auto/delete) and a single "+ Waiting condition" that reveals
  the kind/param fields only on tap (mobile keeps free-text; structured kinds stay web-first
  per the entity doc).
- **Footer (secondary):** **Notes** as an inline "Add notes" expander (demoted from its
  prominent labeled box). Delete lives in the header menu, not here.

Behavior of every control is unchanged — same verbs (`edit`, `setStatus`, task
`add`/`complete`/`takeOn`/`park`, waits `add`/`resolve`/`remove`, delete). Only the
container, arrangement, and prominence change.

### Delete + Undo across a navigation

The list's Done/Delete currently strike the row through in place with a ~5s Undo. From a
detail **screen**, deleting or marking done should **navigate back to the list and show the
Undo there** (the existing `useUndoableLeave` on the list), so the transient Undo lives
where the row is. Trigger it via a small confirm from the header menu, then `navigate/push`
back with the pending-undo id. Keep the destructive commit deferred exactly as today.

## What stays unchanged

`@zero/agent-core`, the stores, the `/api/*` routes, the collections, and the **Captures**
detail sheet. This is a navigation/presentation rework.

## Tests

- **Web** `apps/agent-web/src/pages/ProjectsPage.test.tsx` + a new `ProjectDetailPage`
  test: the row now **navigates** (assert the route / that the detail renders) rather than
  opening a dialog; move the task-add, waiting-condition, status (Move to backlog / Mark
  done), icon-pick, and Delete/Undo assertions onto the detail page, updating for the moved
  affordances (open the icon menu before `🎓`; open "+ Waiting condition" before filling
  it). Render with a router (`MemoryRouter`) at `/projects/:id`. These are real jsdom
  behavior tests and gate the web rework.
- **Mobile** `apps/agent-mobile/src/app/(signed-in)/__tests__/projects.test.tsx` + a new
  detail-screen test: the list test asserts the row **pushes** the detail route (mock
  `expo-router`'s `router.push`/`useLocalSearchParams`); the detail test drives the RN tree
  directly (no `@expo/ui` mock needed for the body now — it is plain RN). Keep the icon,
  add-task, waiting, status, and Undo assertions on the detail test. **State in a comment +
  the PR that the old suite mocked `@expo/ui` and could not catch the render bug; the fix is
  proven on-device.**
- **On-device (required):** EAS dev build (native navigator + any new `@expo/ui` surface),
  then Maestro on the attached Pixel 7 (`apps/agent-mobile/.maestro/`): open a project (the
  tab bar stays, Back returns), the tasks and waiting rows render and are interactive, add a
  task, take-on/park, add a free-text condition, run status moves + delete, confirm Undo on
  the list. Capture the run as the artifact.

## Documentation

- `docs/entities/project.md` — rewrite "Interactions → UI": a project opens its **own
  screen** (web `/projects/:id`; mobile a pushed screen within the Projects tab), not a
  detail sheet; header (de-emphasized icon, editable title, derived-status pill, overflow
  menu for status/delete), tasks + waiting as the body, notes secondary. Note that sheets/
  menus now serve only the icon/status/waiting-kind/confirm sub-interactions, and that the
  Captures detail is still a sheet. Source of truth for the sheet→screen change.
- `docs/todo-app.md` — tracking note: the project detail moved from a bottom sheet to a
  navigable destination, which also fixed the mobile task/waiting renderer (name the cause
  briefly: RN inside an `@expo/ui` host tree; a pushed RN screen removes the host).
- Changelogs (user-facing bullet in the same commit as the code):
  - `apps/agent-web/CHANGELOG.md` — a project now opens its own page that leads with its
    tasks and what it's waiting on.
  - `apps/agent-mobile/CHANGELOG.md` — tapping a project now opens its own screen (with
    Back), and its tasks and waiting conditions render correctly. (A real user-visible fix.)

## Skills to use

- `impeccable` — shaping the destination's header/body/footer hierarchy, the de-emphasized
  icon, the overflow menu, and the reveal-on-action forms so the screen reads cleanly.
- `expo-router` — the pushed Projects detail route (nested `Stack` under the tab, native
  header + Back, `router.push` / `useLocalSearchParams`).
- `expo-ui` — the small pure-`@expo/ui` sub-interaction surfaces (icon picker / status
  menu); confirm props from the installed `.d.ts`.
- `vocabulary` / `deep-modules` — keep the derivation helpers as the single seam; the rework
  stays UI/navigation only, no logic into render code.
- `changelog`, `git-commit`, `open-pr` — per-surface bullets; commit at green points (web,
  then mobile); open the PR at the end.

## Acceptance criteria

- Tapping a project opens its own screen/route (native Back on mobile, browser Back on web),
  leading with its tasks then what it's waiting on; icon, status moves, notes, and delete are
  present but not the first thing seen.
- Changing the icon takes one extra tap (no always-open grid); adding a waiting condition
  reveals its fields only after "+".
- On device, the project screen's tasks and waiting rows render and are interactive; the tab
  bar stays and Back returns to the list; verified via EAS build + Maestro / Pixel 7.
- Done/Delete return to the list with the existing ~5s Undo, and defer the commit as today.
- Web `ProjectsPage` + `ProjectDetailPage` tests and the mobile list + detail tests pass.
- No change to data, API, stores, collections, or the derivation helpers; the Captures
  detail sheet is untouched; existing store/route/derive tests stay green.

## Risks

- **Bigger than a re-layout — it is a navigation change.** New routes on both surfaces, a
  restructured Projects tab folder on mobile, and Undo that now spans a Back. Sequence it:
  web route first (simplest, real tests), then the mobile route + render fix.
- **Expo Router native-navigator wiring** (nested `Stack` under a `NativeTabs` tab) is the
  fiddly part and needs a fresh **EAS dev build** to verify; the jest suite (which mocks the
  router) cannot prove Back/tab behavior. Device-verify.
- **The jest suite can't catch the native render bug** (it mocked `@expo/ui`), and now
  largely stops needing that mock; do not read a green mobile suite as proof of the on-device
  fix.
- **Scope creep.** No new columns, no reschedule, no structured-kind creation on mobile, no
  wide-screen master-detail in v1 — those stay on the availability-model roadmap
  (`docs/plans/todo-availability-model.md`). This change moves the container and re-lays-out
  existing controls, nothing more.

## Delivery

One branch (not `main`, since a push auto-deploys). Web commit (route + detail page + tests
+ changelog), then mobile commit (Projects tab restructure + detail screen + render fix +
tests + changelog); docs updated in the same effort. Open a PR at the end (`open-pr`);
device-verify the mobile screen (render, tab-stays, Back, Undo) before calling it done.
