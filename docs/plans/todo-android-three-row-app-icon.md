# Android three-row default app icon

## Bottom line

Keep every dynamic Home-task launcher state. Change only Android's primary APK
icon from the clear-Home checkmark to the approved static three-row task mark.

A fresh install and signed-out app should show the three-row brand icon. After a
signed-in app hydrates Home, the existing behavior remains: zero visible tasks
selects the checkmark, one to three tasks select that many rows, and four or more
selects four rows.

## Goal

Separate Android's fixed app identity from its runtime Home-count states:

- **Primary/default icon:** the static three-row artwork generated from
  `apps/agent-mobile/assets/brand/todo-icon.svg`.
- **Dynamic launcher states:** the existing checkmark and one-to-four-row family
  generated from `assets/brand/task-count/template.svg`.

No task-count feature, artwork state, or native switching behavior is removed.

## Current state

- `apps/agent-mobile/app.json` points Android's primary legacy, adaptive, and
  monochrome icon fields at `assets/images/task-count/0-empty*`.
- The config plugin registers an enabled `Default` launcher alias backed by that
  primary checkmark plus four alternate aliases for non-empty counts.
- Mobile maps zero tasks and signed-out state to `Default`. The checkmark
  therefore serves two meanings: APK identity and hydrated zero-task state.
- `bin/generate-todo-icons` already owns the static three-row source, but it
  deletes the static Android foreground and monochrome derivatives because the
  checkmark currently replaces them.

## What to change and why

### Give the APK its static three-row identity

Restore generated Android adaptive and monochrome derivatives from
`assets/brand/todo-icon.svg`. Point `app.json` at:

- `assets/images/icon.png` for the Android legacy icon;
- `assets/images/android-icon-foreground.png` for the adaptive foreground;
- `assets/images/android-icon-monochrome.png` for the themed icon;
- the existing white adaptive background.

Keep these outputs behind the existing `bin/generate-todo-icons` interface. Do
not hand-copy `3-tasks` PNGs: the static source already owns the app identity on
iOS, splash, touch, and web surfaces.

### Make zero tasks an explicit alternate state

Add an `Empty` launcher alias backed by the existing `0-empty` legacy,
adaptive, and monochrome assets. Keep `OneTask`, `TwoTasks`, `ThreeTasks`, and
`FourPlusTasks` unchanged. The plugin will then generate six launcher aliases:
one enabled static `Default` alias and five disabled Home-count aliases.

Make the mobile interface explicit:

| Situation | Native alias |
| --- | --- |
| Not signed in / no Home decision yet | `Default` — static three rows |
| 0 visible Home tasks | `Empty` — checkmark |
| 1 visible Home task | `OneTask` |
| 2 visible Home tasks | `TwoTasks` |
| 3 visible Home tasks | `ThreeTasks` |
| 4+ visible Home tasks | `FourPlusTasks` |

Use named states rather than retaining `null` as an overloaded synonym for the
checkmark. Hydration must still make no request until Tasks, Projects, and
Waiting Conditions are ready, so the APK's three-row default remains visible
until Home has a real count. Switching still occurs only when the app enters the
background.

This keeps the native switching module deep: callers choose one semantic icon
state, while alias ordering, package-manager behavior, and failures remain
inside its implementation.

## Implementation steps

1. **The static source produces Android's primary layers.** Update
   `bin/generate-todo-icons` to emit and validate the static adaptive foreground
   and monochrome files instead of deleting them; regenerate assets and prove
   deterministic output.
2. **A clean Android build contains one default plus five dynamic states.** Point
   `app.json` at the static three-row outputs, add the `Empty` resource/alias to
   the existing config plugin, and include `Empty` in the native module's
   accepted state names.
3. **Zero tasks select the alternate checkmark.** Update the mobile mapping so
   zero returns `Empty`, all positive buckets retain their existing aliases, and
   signed-out state requests `Default` explicitly.
4. **Behavior is covered through the existing icon interface.** Update mapping,
   synchronization, and signed-in-layout tests for the distinct `Default` and
   `Empty` meanings; retain hydration and nonblocking-failure coverage.
5. **The APK default and runtime transition pass on the Pixel 7.** Verify the
   three-row icon before first launch, then verify a hydrated zero-task request
   still changes it to the checkmark after backgrounding without production-data
   writes.
6. **Documentation explains both icon roles.** Update the mobile README,
   prototype status, todo tracking, and mobile changelog in the same change.

## Out of scope

- Removing or redesigning the dynamic task-count icon family.
- Changing which tasks count as visible on Home or when native switching occurs.
- Changing iOS, web favicons, splash artwork, the Home tab icon, or project emoji
  icons.
- Adding icon preferences, animation, numeric badges, or iOS alternate icons.
- App-store submission or publishing the preview APK to Drive; release can use
  the existing native-release procedure after implementation is accepted.

## Test strategy

### Automated and generated output

- Run `bin/generate-todo-icons` twice and compare hashes for every generated SVG
  and PNG.
- Validate that the static Android legacy icon is opaque and that its adaptive
  and monochrome layers have transparent corners, neutral colors, declared
  dimensions, centered three-row artwork, and safe-zone containment.
- Require every existing task-count source and derivative to remain present and
  byte-identical. Only the restored static Android foreground and monochrome
  outputs should be new generated assets.
- Unit-test the count mapping for `0`, `1`, `2`, `3`, `4`, and a value above four;
  zero must return `Empty` and the positive mappings must not change.
- Test that hydrated zero-task data requests `Empty`, hydration requests nothing,
  and signed-out state requests `Default`.
- Retain tests that Android failures only warn and that non-Android platforms do
  nothing.
- Resolve Expo configuration and assert that Android's primary icon fields point
  at the static three-row outputs.
- Run a clean Android prebuild and inspect the manifest/resources:
  `MainActivity` stays enabled for app, Clerk, and development-client routes;
  `Default` is the sole initially enabled launcher alias; `Empty` plus all four
  non-empty aliases exist and are initially disabled.
- Stop Metro and Gradle first on `mini`, then run mobile tests, lint, typecheck,
  and Android export serially. Run `gob run bin/ci`; if the documented NixOS
  `workerd` limitation blocks untouched Workers, retain the passing mobile checks
  and leave that cross-Worker gate to GitHub Actions.

### Pixel 7

- Build and install a fresh local `development-pixel` client because launcher
  resources and the manifest changed. Do not install a preview or production
  build on this device.
- Verify a clean install before first app launch shows the three-row icon. This
  is the direct proof of the reported APK-default defect.
- Without creating, editing, completing, moving, or deleting production
  entities, use a temporary local harness or direct alias requests to verify
  `Empty` still shows the checkmark and `Default` restores the three-row icon.
- Confirm each transition waits until background, leaves exactly one launcher
  alias enabled, and still opens through the launcher, `zeroagent://`, and the
  development-client route.
- Restore the installed development client to its normal source and let the real
  hydrated Home count own the final runtime alias.

## Documentation and changelog

- Update `apps/agent-mobile/README.md` under **Brand assets**: the APK primary is
  the static three-row icon, while five alternate aliases continue to mirror the
  hydrated Home count.
- Update `docs/prototypes/todo-icon/README.md` to identify the five-state family
  as runtime alternatives rather than Android's primary APK icon.
- Add a most-recent implemented item to `docs/todo-app.md` that supersedes only
  the “primary launcher icon is the empty-state checkmark” detail. Keep the
  historical dynamic-icon and enlarged-checkmark entries intact.
- Add this current-date entry to `apps/agent-mobile/CHANGELOG.md`, preserving all
  pre-existing local entries: `- 2026-09-15: New Android installs use the
  three-row task mark as the app icon while the launcher still mirrors Home
  after the app loads.`
- Do not change the agent, web, or root changelogs.

## Skills to use

- `expo-overview` — preserve Expo 57 icon and prebuild conventions.
- `expo-dev-client` — build and install the native development client for Pixel
  verification.
- `deep-modules` and `vocabulary` — preserve the existing launcher module's small
  interface while separating default identity from runtime state.
- `testing` and `reproducible-locally` — verify assets, mappings, manifest output,
  and the clean-install result through observable outcomes.
- `impeccable` — inspect the normal and themed three-row icon at launcher size.
- `changelog` and `documentation` — update user history and current sources of
  truth without rewriting historical records.
- `git-commit` — commit native configuration, generated assets, tests, changelog,
  and docs together.

## Acceptance criteria

- A fresh Android install shows the approved static three-row icon before the app
  runs or task data hydrates.
- Signed-out state selects `Default` and shows the three-row icon.
- A hydrated signed-in Home preserves all five runtime states: checkmark for zero,
  exact rows for one through three, and four rows for every larger count.
- Loading auth or entity snapshots makes no premature alias request.
- Android legacy, adaptive, and themed modes use the corresponding generated
  layers without clipping or a baked launcher mask.
- Clean prebuild contains one enabled static default alias and five disabled
  dynamic aliases while keeping `MainActivity` and all deep links launchable.
- Existing dynamic icon artwork, task visibility rules, switching timing, iOS,
  web, splash, in-app UI, and task data behavior remain unchanged.
- Generator checks, mobile tests, lint, typecheck, Android export, clean prebuild
  inspection, and Pixel 7 verification pass.
- The mobile changelog and current documentation ship with the implementation.
