# Dynamic Home-task launcher icon

## Goal

Make the Android launcher icon reflect the number of tasks currently visible on
Home. Use the approved icon family already saved in
`docs/prototypes/todo-icon/`: a checkmark for an empty Home, one row for one
task, two rows for two tasks, three rows for three tasks, and four rows for four
or more tasks.

The change is mobile-only and Android-only. The mobile product currently ships
as an Android preview APK and has no iOS release configuration. The web favicon,
mobile tab icon, and splash mark remain static.

## Current state and constraints

- Home derives its visible ordered list through the existing pure `homeTasks`
  seam in `@zero/agent-core`. The answer depends on tasks, projects, waiting
  conditions, and the device's local day; counting all open task rows would be
  wrong.
- Mobile holds those entities in app-lifetime TanStack DB collections with a
  persisted local-first snapshot and optimistic writes. The icon must follow the
  same snapshot as Home, including offline changes.
- The approved five-state artwork is currently a prototype. `template.svg` owns
  its shared material, and `render.py` owns the state compositions. The EAS
  archive excludes `docs/`, so production icon inputs and generated assets must
  live under `apps/agent-mobile` before `app.json` can reference them.
- Android has no direct runtime launcher-icon interface. Dynamic icons use one
  launcher `activity-alias` per alternate image and enable exactly one launcher
  entry at a time.
- Changing aliases is native work. It requires a new development-client build;
  Metro hot reload alone cannot add it.
- The attached Pixel 7 uses the production server by default. Native verification
  must use fake auth plus the disposable local worker, not create or alter the
  user's production tasks.

## Technical approach

### Keep Home visibility as the source of the count

Add one UI-less mobile module, mounted once beside the signed-in tab navigator.
Its interface is only “keep the launcher icon synchronized.” Its implementation
will:

1. Acquire the existing Task, Project, and WaitingCondition collection handles.
2. Subscribe to all three with `useLiveQuery`.
3. Make no icon decision until all three snapshots have hydrated, preventing a
   temporary empty collection from selecting the checkmark.
4. Call `homeTasks(tasks, projects, localToday(), conditions)` and bucket the
   returned length as follows:

| Home task count | Launcher state |
| --- | --- |
| `0` | primary/default checkmark icon |
| `1` | `OneTask` |
| `2` | `TwoTasks` |
| `3` | `ThreeTasks` |
| `>= 4` | `FourPlusTasks` |

Depend on the bucket, not the raw count, so a change from four to five tasks does
not request a redundant native switch. Optimistic collection updates then move
the desired icon at the same time Home changes, even while offline.

When Clerk has definitively loaded a signed-out state, request the primary
checkmark icon. Do not change the installed icon while Clerk or entity data is
still loading. A switching failure is non-blocking: log one warning and leave
all task behavior unchanged.

### Own the native launcher seam

Use the local Expo module at `apps/agent-mobile/modules/home-app-icon`; its
`app.plugin.js` owns the generated native configuration. The module accepts only
the five Home icon states, keeps the latest request while the app is foreground,
and applies it on the next activity-background transition. It enables the target
launcher alias before disabling the other aliases, so one launch path always
remains.

Keep the real `MainActivity` enabled and remove only its `MAIN`/`LAUNCHER` filter.
A permanent `MainActivityIconDefault` alias owns the checkmark and four sibling
aliases own the non-empty states. This shape matters for the development client:
Expo's launcher explicitly starts `MainActivity`, while the app scheme and
Clerk's hosted callback also resolve there. Disabling the activity makes an
otherwise valid dynamic icon build unable to load its JavaScript.

The mobile TypeScript adapter maps the clear state to `Default`, contains native
failures behind a warning, and does nothing outside Android. Do not enable
automatic iOS switching: iOS presents a system confirmation for every icon
change, and this product does not currently ship an iOS build.

### Promote the selected artwork into the production asset pipeline

Move the selected family source into
`apps/agent-mobile/assets/brand/task-count/` and make it the sole source of truth.
Fold the prototype state-generation logic into `bin/generate-todo-icons` so one
command continues to generate and validate all todo branding.

For each state, generate committed Android inputs under
`apps/agent-mobile/assets/images/task-count/`:

- an opaque legacy icon;
- a transparent adaptive foreground, scaled into Android's guaranteed safe
  circle;
- a matching one-color monochrome foreground for themed icons.

Configure the checkmark outputs as Android's primary legacy/adaptive/monochrome
icon. Configure only the four non-empty states as alternate aliases; resetting
to the primary icon represents zero tasks. Keep the existing
`assets/brand/todo-icon.svg` as the source for the static splash, web favicon,
and iOS icon, so this change does not turn a stale runtime count into launch or
web branding.

Keep `docs/prototypes/todo-icon/comparison.png` as design evidence, update its
README to point to the promoted source, and remove duplicate prototype sources
or outputs. Extend generator validation to cover every state, dimensions,
opacity, neutral colors, safe-zone containment, monochrome shape, and
deterministic regeneration.

### Native configuration gate

Before relying on the local module, run a clean Android prebuild and inspect the
generated native project. It must contain:

- one enabled default `activity-alias` and four disabled alternate aliases;
- the `MAIN`/`LAUNCHER` filter only on those aliases, while enabled
  `MainActivity` retains the existing `zeroagent`, dev-client, and Clerk
  `VIEW`/`BROWSABLE` filters;
- adaptive foreground/background/monochrome resources for each state;
- no reference to `docs/` or an uncommitted native directory.

Remove the generated `android/` directory after inspection. The repository's
ignored native projects and `.easignore` rules must continue to force clean Expo
prebuilds in EAS.

## Alternatives considered

- **`@semisquircle/expo-dynamic-app-icon`:** rejected by the Pixel gate. It
  disabled the real `MainActivity` after the first switch. The launcher alias
  still appeared, but Expo dev-client then failed with `ActivityNotFoundException`
  because its loader explicitly starts that disabled activity. The local module
  keeps `MainActivity` enabled and changes aliases only.
- **`expo-alternate-app-icons`:** rejected because its Android adapter switches
  immediately and its plugin does not copy the generated main activity's actual
  deep-link filters. Disabling `MainActivity` could break Clerk OAuth and the
  dev-client URL.
- **Counting open tasks directly:** rejected because Home also applies date,
  project-status, waiting-condition, completion, and orphan-project rules.
  `homeTasks` already owns that behavior.
- **Moving the count into `@zero/agent-core`:** rejected. Home visibility is
  already shared there; launcher state names and native switching are
  mobile-platform policy.

## Implementation steps

1. **The approved icon family becomes reproducible production input.** Promote
   the template/state definitions, extend `bin/generate-todo-icons`, generate
   the primary and four alternate Android asset sets, update prototype pointers,
   and prove two generator runs have identical checksums.
2. **Every Android build contains five safe launcher states.** Add the local
   Expo module and config plugin, point Android's primary icon at the checkmark,
   register the default and four non-empty aliases, run clean prebuild, and
   inspect launcher filters, deep links, adaptive resources, and monochrome
   resources.
3. **The installed icon follows the hydrated Home list.** Add the private native
   adapter and signed-in synchronization module; derive the count through
   `homeTasks`; reset on signed-out state; mount the module once in
   `apps/agent-mobile/src/app/(signed-in)/_layout.tsx`; keep failures out of the
   task interaction path.
4. **Behavior is covered through the module interface.** Add focused mapping and
   synchronization tests, update the signed-in layout test for signed-out reset
   and the UI-less observer, and keep existing Home tests as the proof of Home's
   visibility rules.
5. **The user-visible behavior and native constraint are documented.** Update
   `apps/agent-mobile/README.md`, `docs/todo-app.md`, the prototype README, and
   `apps/agent-mobile/CHANGELOG.md` in the same change.
6. **A fresh dev client proves all five states on the Pixel 7.** Run checks,
   build and install the native development client, exercise disposable local
   tasks from zero through five and back to zero, capture launcher evidence, and
   verify the app still opens from both its current alias and a `zeroagent` deep
   link.

## Test strategy

### Automated

- Unit-test the bucket mapping for `0`, `1`, `2`, `3`, `4`, and a value above
  four.
- Test that the synchronization module does nothing while any required
  collection is hydrating.
- Test that visible Home tasks select the matching adapter state and that hidden
  tasks do not: include a completed task, a future task, and an undated project
  task in one fixture while only one task is Home-visible.
- Test that counts of four and five share one native state.
- Test that a loaded signed-out session restores the primary checkmark and that
  an unloaded Clerk session makes no request.
- Test that a rejected or `false` native result logs a warning without rendering
  an error or interrupting data updates.
- Run the generator twice and compare output checksums.
- Run a clean Android prebuild/config inspection, then:
  `pnpm --filter @zero/agent-mobile test`, `lint`, `typecheck`, and
  `expo export --platform android`. Stop Metro and Gradle first and run checks
  serially on `mini`. GitHub CI remains the cross-repository gate because local
  `workerd` cannot run on this host.

### Pixel 7

- Build `development-pixel` locally because the module and config plugin are
  native; do not spend EAS cloud quota and do not install a preview/production
  build on the Pixel.
- Keep production data read-only. Automated tests prove the Home-count mapping;
  a temporary uncommitted signed-out harness requests each native state without
  creating, completing, or moving any task, then restores the real `null`
  signed-out state before checks.
- Verify and capture the checkmark, one-row, two-row, three-row, and four-row
  states. The pure mapping test proves four and every larger count share the
  four-row alias.
- At each transition, keep the app foregrounded long enough to confirm the
  request does not close it, then background it and allow the Pixel launcher to
  refresh. Relaunch through the Expo dev-client URL while the preceding alias is
  active.
- Confirm `MainActivity` remains enabled, each transition leaves exactly one
  launcher alias enabled, and the app/dev-client/Clerk schemes still resolve to
  `MainActivity`.
- Save launcher screenshots for all five states, restore the default checkmark,
  and leave the Pixel on a normally signed development-client build.

## Documentation strategy

- Add a current-date entry to `apps/agent-mobile/CHANGELOG.md`, most recent
  first, from the user's perspective. Suggested copy: “The launcher icon now
  mirrors Home: a checkmark when your list is clear, then one to four task rows
  as work appears.”
- Add a shipped item to the Project tracking section of `docs/todo-app.md` after
  implementation and Pixel proof.
- Update the mobile README's Brand assets section with the two icon sources,
  generator outputs, Android-only runtime behavior, and fresh-dev-build
  requirement. Keep build and Pixel procedures in their existing sections;
  link to them rather than duplicating them.
- Update the prototype README to identify the production source and retain only
  design evidence there.
- Do not change the root, agent, or web changelogs.

## Skills to use

- `expo-overview` — preserve Expo 57 setup and package-install conventions.
- `expo-module` — inspect the native module and generated config-plugin output.
- `expo-dev-client` — rebuild and install the Android development client.
- `deep-modules` and `vocabulary` — keep Home-count derivation and native details
  behind one small synchronization interface.
- `tdd` and `testing` — write behavior tests at that interface before wiring the
  native adapter.
- `changelog` — add the mobile user-facing entry.
- `documentation` — update the README, prototype pointer, and todo tracking
  without duplicating procedures.
- `reproducible-locally` — preserve generator, prebuild, and Pixel evidence.
- `git-commit` — commit code, generated assets, tests, changelog, and docs
  together.

## Acceptance criteria

- A hydrated Home with zero visible tasks selects the checkmark; counts one,
  two, and three select that many rows; every count at or above four selects four
  rows.
- The count exactly matches `homeTasks`, including optimistic/offline changes;
  future, completed, unavailable-project, and groomed project tasks do not
  inflate it.
- Loading auth or entity snapshots never flashes or persists a false empty icon.
  A loaded signed-out state uses the checkmark.
- The icon switch is requested while the app runs and applied when it enters the
  background; task interactions are not interrupted.
- The selected alias survives process restart, launches the app, and accepts
  Clerk/dev-client deep links.
- Standard, adaptive, and themed Android launcher modes use the corresponding
  approved state artwork without clipping.
- The static splash, iOS icon, web favicon, tab icon, and application UI do not
  change.
- Mobile tests, lint, typecheck, Android export, clean prebuild inspection, and
  all five Pixel launcher states pass without production-data writes.
- The mobile changelog, mobile README, todo tracking doc, and prototype pointer
  ship with the implementation.

## Out of scope

- Automatic iOS alternate icons.
- Dynamic web/PWA favicons or the in-app Home tab icon.
- Numeric badges, notification counts, icon animation, or a user-selectable icon
  setting.
- Updating the icon while the app process is not running. Remote changes and a
  midnight date rollover become visible after the next app sync and background
  transition.
- Redesigning the approved five-state family or changing the static splash/web
  brand mark.
- Building or publishing a preview APK to Google Drive; release remains a
  separate request.

## Risks and mitigations

- **Alias switching can make an app unlaunchable if every launcher entry is
  disabled.** Use the module's enable-first behavior, inspect the manifest, and prove
  repeated up/down transitions plus relaunch on the Pixel.
- **An alias can lose OAuth or dev-client routing.** Require every generated
  alias to copy all main-activity intent filters and test both schemes while an
  alternate is active.
- **Launcher updates are asynchronous and launcher-specific.** Apply on
  background, allow refresh time in device tests, and treat a short launcher
  delay as platform behavior rather than blocking task writes.
- **Launcher aliases can conflict with Expo dev-client's explicit activity
  launch.** Keep `MainActivity` enabled, compile the local module in a fresh
  development client, and relaunch through the dev-client URL after every alias
  has been active.
- **A persisted empty snapshot can be mistaken for pre-hydration.** Gate on all
  three live-query loading states; after hydration, trust the local-first
  snapshot even if the network is offline.

## Evidence

- `bin/generate-todo-icons` regenerated all SVG/PNG outputs twice with identical
  SHA-256 checksums. It validates opaque legacy images, transparent adaptive and
  monochrome layers, neutral colors, and Android safe-zone containment.
- Clean Expo prebuild produced five launcher aliases, left `MainActivity`
  enabled with the `zeroagent`, `exp+zero-agent`, and Clerk filters, and produced
  legacy/adaptive/monochrome resources for every non-empty state. A Python probe
  asserted those postconditions.
- The first development build (version code 70) proved the third-party approach
  unsafe: four Home tasks selected its four-row icon, then Expo dev-client failed
  with `ActivityNotFoundException` because the package disabled `MainActivity`.
  No task was changed. The dependency was removed.
- The app-owned module compiled in both a direct Gradle development build and the
  final EAS-local `development-pixel` build (version code 71, remote signing).
  Version 71 is installed on the Pixel 7 and remains a development client.
- A temporary signed-out harness selected the checkmark, one-row, two-row,
  three-row, and four-row aliases without any data write. Each transition left
  one alias enabled, each preceding alias could relaunch through the Expo
  dev-client URL, and the final source/build restored the checkmark. Screenshots
  and a five-state collage are in `/tmp/dynamic-icon-pixel/`.
- Mobile lint, typecheck, 21 suites / 135 tests, and Android export pass. The
  whole-repository `bin/ci` reached the documented NixOS `workerd` failure in the
  untouched dashboard Worker after the mobile checks passed.
