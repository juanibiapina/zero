# Plan: Move mobile Upcoming into Browse

## Goal

Replace the mobile Upcoming tab with a rightmost **Browse** tab that opens a short navigation menu. The menu has an **Upcoming** row; selecting it opens the existing future-task screen, and Android Back returns to Browse. Keep **Home** and **Projects** as direct tabs. The user confirmed that Browse opens a full navigation screen rather than a floating button or anchored popup. Keep Projects as a direct tab; only Upcoming moves into Browse.

## Current state and decision

- `apps/agent-mobile` uses Expo SDK 57, Expo Router `NativeTabs`, and a signed-in tab layout at `src/app/(signed-in)/_layout.tsx`. Home, Upcoming, and Projects are sibling tabs. Projects already uses a nested `Stack` for list → detail navigation.
- `src/app/(signed-in)/upcoming.tsx` owns the existing `SectionList`, task detail, completion, refresh, and local-first data access. Its behavior does not need to change. `@zero/agent-core` owns the future-date grouping and Home/Upcoming split; do not change that rule.
- A hidden Upcoming `NativeTabs.Trigger` is not an option: hidden tabs cannot be navigated to. A tab-bar popup would fight the native navigator's fixed tab triggers. Use a Browse tab backed by a small stack: `browse/index.tsx` is the menu and `browse/upcoming.tsx` is the moved screen. The visible order is Home, Projects, Browse. Use `unstable_settings.initialRouteName = 'index'` in `browse/_layout.tsx`, following the Projects stack, so navigation directly to Upcoming has a Browse screen underneath it.
- Keep the menu deliberately small: one Upcoming row now, with no placeholder destinations. For a short navigation list, consult `@expo/ui`'s native `List`/`ListItem` first; if its grouped-settings appearance clashes with the existing flat `ListRow` idiom, use the existing `ListRow`. Reuse `ScreenHeader` and semantic Uniwind tokens. Browse gets a labeled menu icon (`sf="line.3.horizontal"`, `md="menu"`); use a clear accessibility label and at least a 48 dp target for its row. Do not add a new abstraction or native dependency for a single destination.
- The web app (`apps/agent-web`) is a separate React surface with its own nav. This change is mobile-only. No backend or schema change is needed. The checkout was current with `origin/main` when this plan was written.

## Implementation steps

1. **Browse is the rightmost tab.** In `src/app/(signed-in)/_layout.tsx`, replace the Upcoming trigger with a Browse trigger after Projects. Add `src/app/(signed-in)/browse/_layout.tsx` and `browse/index.tsx`. Browse shows its own title and an Upcoming row; tapping it pushes `/browse/upcoming`. Give the pushed screen an in-app “Back to Browse” affordance, matching the Projects workspace's header-off stack pattern, as well as native gesture and hardware Back. Check that relaunch, tab switching, and direct navigation to `/browse/upcoming` land on the right screen with the tab bar still visible.
2. **Upcoming retains its behavior and all internal links work.** Move `src/app/(signed-in)/upcoming.tsx` to `browse/upcoming.tsx` and adjust its imports and header/back presentation; leave task queries and task actions unchanged. Update `src/lib/task-feedback.ts` to target `/browse/upcoming`; the Project-detail add flow uses that shared helper, so its source needs no separate route edit. Use the stack anchor for cross-tab navigation if required, as Project detail already does for `/projects/:id`. Search again for `/upcoming` in mobile code and flows. Remove the old tab route rather than leaving a dead screen in the native navigator. An external `zeroagent://upcoming` link is not documented; if one is in use, add an explicit root-level redirect to `/browse/upcoming` and test it instead of silently breaking it.
3. **The navigation change has automated proof.** Update `src/app/__tests__/signed-in-layout.test.tsx` to assert the Home/Projects/Browse triggers, their order, and no Upcoming trigger. Add a Browse screen navigation test. Move/retarget the Upcoming screen test import without rewriting its behavior tests. Update task-feedback and Project-detail tests to assert the new destination and cross-tab stack behavior. Add a behavior-named `.maestro/hermetic/04-browse-upcoming.yaml` flow that opens Browse → Upcoming, checks the future-task or empty state, and returns with Back; update `.maestro/hermetic/01-add-task.yaml` where it taps the former Upcoming tab. Keep fixtures hermetic and clean them up. Update any still-useful dev-only flows that name the old tab.
4. **The product description matches the new navigation.** Add a user-facing bullet to `apps/agent-mobile/CHANGELOG.md` in the same change. Update the current navigation description in `apps/agent-mobile/PRODUCT.md`, `README.md`, `docs/entities/task.md`, and the current project-tracking section of `docs/todo-app.md`; preserve historical shipped records as history. Do not add a web changelog entry.

## Out of scope

Moving Projects into Browse, changing the web navigation, redesigning Upcoming's date grouping or task editor, and adding new destinations to Browse. The Browse screen is a navigation menu, not a new data collection.

## Verification and acceptance

- Run `gob run bin/ci` as the repository's standard check. On this NixOS host it may stop when host `workerd` fails; then run `pnpm --filter @zero/agent-mobile run test`, `lint`, `typecheck`, and an Android `expo export` separately. Stop Metro and local Gradle first to avoid resource contention.
- Run `pnpm --filter @zero/agent-mobile e2e:pixel` for route and Back proof; the harness runs its Worker in rootless Podman. Use a dev-client visual check only if the menu's appearance, larger font scaling, dark mode, or screen-reader behavior remains non-assertable. No new native module is planned, so a fresh native build should not be necessary.
- Acceptance: the signed-in Android tab bar shows Home, Projects, Browse in that order; Upcoming is not a direct tab; Browse → Upcoming and the existing View action for future tasks open the same working screen; Back returns to Browse; completion, date editing, refresh, and existing Project navigation continue to work; tests, hermetic flow, docs, and changelog reflect the change.

## Skills for implementation

- `expo-overview`, `expo-router` — preserve SDK 57 native tab and nested-stack behavior.
- `expo-ui`, `expo-native-ui` — select a native-feeling, accessible short menu in the current visual system.
- `testing`, `reproducible-locally` — assert routing at the visible interface and prove it on the hermetic Pixel flow.
- `changelog`, `documentation` — write the mobile release note and keep current product/navigation documentation accurate.
