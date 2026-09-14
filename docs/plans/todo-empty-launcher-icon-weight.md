# Larger, chunkier empty launcher icon

## Bottom line

Refine only Android's zero-task launcher checkmark. Three comparison rounds
established the required footprint, and the user selected **B Full**: scale the
original path by `1.45` and its material strokes by `1.28`. Put that geometry
behind the existing `bin/generate-todo-icons` interface, regenerate its
derivatives, and verify the real launcher result on the attached Pixel 7.

The current adaptive foreground occupies `369 × 271` pixels of its `1024 ×
1024` layer. B Full occupies `520 × 377` pixels while preserving the checkmark's
angle, graphite material, white ground, optical center, and guaranteed Android
safe-zone containment.

## Goal

Make the checkmark shown when Home has no tasks feel more substantial and use
more of the launcher tile while preserving the established white-and-graphite
icon family.

“Empty icon” means `0-empty`, Android's zero-visible-Home-task launcher state.
It does not mean the in-app Home empty state, the static iOS icon, the splash
mark, the browser favicon, or the one-to-four-task launcher states.

## What to change and why

### The comparison rounds selected B Full

Temporary sheets showed each candidate under an Android-style circular mask and
at 96 px and 48 px. The first 12–20% enlargement was rejected as too small. The
second round established B Full at `520 × 377` adaptive pixels. A final sheet
compared B with Expanded (`561 × 393`) and Maximum (`576 × 404`), both still
safe-zone-contained. The user selected B Full, keeping the original proportions
while making the path 45% larger and the material strokes 28% heavier.

Do not commit the rejected candidates or make the artwork a runtime preference.

### Keep the selected geometry inside the existing generation module

`bin/generate-todo-icons` is the source of truth for the checkmark path and
stroke widths. Give the selected path scale and stroke widths clear names in
that module, but do not add another module or interface. The existing generator
already owns all state composition and platform adapters, which provides the
right locality.

Preserve:

- the continuous three-layer path with round caps and joins;
- the existing `metalSide`, `ringBevel`, and `silverFace` paints and shadow;
- the full-bleed white square;
- Android's existing `0.75` adaptive safe-zone transform;
- the path direction, center, and clear-day meaning;
- every one-to-four-task composition and all static icon outputs.

After selection, regenerate only through `bin/generate-todo-icons`. Expected
changed outputs are:

- `apps/agent-mobile/assets/brand/task-count/0-empty.svg`;
- the three `apps/agent-mobile/assets/images/task-count/0-empty*.png` files;
- `docs/prototypes/todo-icon/comparison.png`.

Any changed non-empty state, static mobile asset, splash asset, Apple touch
icon, or web favicon is a regression unless the generator reveals a previously
unknown shared dependency.

Add a rendered-bounds assertion for the selected empty adaptive foreground. Use
the approved candidate's measured bounds with a narrow tolerance, while keeping
the existing safe-zone, opacity, neutral-color, dimension, and deterministic
checks. This turns “larger and chunkier” into an observable output contract.

## Out of scope

- Redrawing the checkmark, changing its angle, palette, bevel, shadow, or
  metaphor.
- Changing the one-to-four-task launcher states.
- Changing iOS, splash, tab, browser, Apple touch, or store-listing artwork.
- Changing task counting, launcher aliases, runtime icon synchronization, or app
  data.
- Publishing a preview APK or submitting an app-store release.

## Implementation steps

1. **B Full is the approved size trade-off.** Preserve the comparison record
   showing the current icon, smaller rejected options, B Full, and the two larger
   safe-zone-contained alternatives; the user selected B Full explicitly.
2. **The selected checkmark is the only production artwork change.** Encode its
   scale and stroke weight in `bin/generate-todo-icons`, regenerate all outputs,
   and confirm the changed-file set is limited to the empty state and comparison
   evidence.
3. **Generation enforces the approved body and footprint.** Add the selected
   adaptive-foreground bounds check, run the existing validators, and prove two
   consecutive generations produce identical hashes.
4. **A real Pixel launcher proves the result.** Build and install a fresh local
   `development-pixel` dev client, activate the default empty alias without
   mutating production tasks, and capture the launcher at normal size. Confirm
   the icon is centered, unclipped, visibly heavier, and the app still opens.
5. **Current documentation records the visible refinement.** Update the
   prototype README with the selected checkmark description, add the completed
   result and Pixel evidence to `docs/todo-app.md`, and add the mobile changelog
   entry in the same change.

## Test strategy

### Asset and generator checks

- Run `bin/generate-todo-icons` and require all built-in validation to pass.
- Run it a second time and compare hashes for every generated SVG and PNG.
- Assert the selected empty adaptive foreground matches its approved painted
  bounds and remains inside Android's guaranteed safe circle.
- Compare pre-change and post-change hashes. Require exact equality for all
  non-empty task-count states, the static icon, splash, mobile/web favicons, and
  Apple touch icon.
- Inspect the selected icon under square, circle, rounded-square, and squircle
  masks at 48 px and 96 px. Important geometry must remain recognizable and
  unclipped.

### Mobile checks

- Stop Metro and local Gradle processes before checks on `mini`.
- Run `pnpm --filter @zero/agent-mobile test`, `lint`, `typecheck`, and an Android
  Expo export serially.
- Run a clean Android prebuild and confirm the default alias still references the
  regenerated empty legacy, adaptive, and monochrome resources; remove the
  generated native directory afterward.
- Run `gob run bin/ci`. If the documented NixOS `workerd` limitation blocks
  untouched Worker checks, retain the passing mobile package checks and leave
  the cross-Worker gate to GitHub Actions.
- Build the `development-pixel` profile locally and install it on the attached
  Pixel 7. Reuse the prior non-data-mutating alias harness or direct alias
  activation to show `Default`; do not create, complete, move, edit, or delete
  the user's production tasks. Capture the launcher and verify app launch, then
  restore normal source and alias state.

No new React or native behavior test is required because the task does not
change runtime logic. The generator output checks and Pixel launcher are the
relevant interface-level tests.

## Documentation and changelog

- Update `docs/prototypes/todo-icon/README.md` to describe the selected empty
  checkmark as enlarged and heavier. Keep geometry facts there rather than
  duplicating them in the mobile README.
- Add an implemented entry with the selected measurements and Pixel evidence to
  `docs/todo-app.md`; do not rewrite the historical icon plans.
- Add this user-facing entry to `apps/agent-mobile/CHANGELOG.md`:
  `- 2026-09-14: The clear-Home launcher checkmark is larger and bolder, so it reads more clearly at a glance.`
- Do not change the agent, web, or root changelogs.

## Skills to use

- `impeccable` — produce and compare the two icon variants at real launcher
  sizes before the selection gate.
- `expo-overview` and `expo-native-ui` — preserve Expo 57 and native launcher
  presentation constraints.
- `deep-modules` and `vocabulary` — keep all platform derivatives behind the
  existing generator interface without adding a hypothetical seam.
- `testing` and `reproducible-locally` — verify rendered outputs,
  determinism, unchanged neighbors, and the Pixel result.
- `expo-dev-client` — build the native development client required for changed
  launcher resources.
- `changelog` and `documentation` — update the product-specific user history and
  the existing documentation sources of truth.
- `git-commit` — commit the selected source, generated derivatives, tests, docs,
  and changelog together.

## Acceptance criteria

- The comparison rounds include the current icon and progressively larger
  alternatives, and the user explicitly selects B Full before production files
  change.
- The selected adaptive foreground is wider, taller, and visibly thicker than
  the current `369 × 271` output, matching its approved comparison render.
- The checkmark remains centered, continuous, graphite on white, and unclipped
  under Android's safe circle and representative launcher masks.
- Only the zero-task state changes; task counts one through four, static mobile
  artwork, splash, iOS, browser, and Apple touch outputs remain byte-identical.
- The generator is deterministic and rejects undersized, off-center, colored,
  incorrectly sized, opaque/transparent, or safe-zone-breaking output as
  applicable.
- Mobile tests, lint, typecheck, Android export, clean prebuild inspection, and
  the available repository CI checks pass.
- A fresh development client shows the selected icon on the Pixel 7 at launcher
  size and still opens, with no production-data mutation.
- The prototype documentation, todo tracking document, and mobile changelog ship
  with the selected asset change.
