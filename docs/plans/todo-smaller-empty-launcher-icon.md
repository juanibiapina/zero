# Smaller clear-Home launcher icon

## Bottom line

Reduce only Android's clear-Home launcher checkmark to **85% of its current rendered size**. The selected A candidate scales the current path and stroke widths together, preserving the approved shape and graphite material while restoring visible space between the mark and Pixel Launcher's circular mask.

The valid comparison included Pixel Launcher's adaptive-icon crop and showed the candidate in the user's launcher context. The earlier raw-foreground comparison was rejected because it omitted that crop and made the current icon look farther from the edge than it is on-device.

## Goal

Give the zero-task launcher checkmark more breathing room without returning to the undersized original mark.

“Clear-Home launcher icon” means Android's `0-empty` dynamic launcher state, selected after Home hydrates with no visible tasks. It does not mean the in-app Home empty state or Android's three-row default icon.

## What to change and why

`bin/generate-todo-icons` is the source of truth for the checkmark and every platform derivative. Keep the change behind this existing module interface; do not add another seam or hand-edit generated assets.

Scale both current dimensions by `0.85`:

- path scale: `1.45` → `1.2325` relative to the original path;
- stroke scale: `1.28` → `1.088` relative to the original material strokes;
- adaptive-foreground painted bounds: `520 × 377` → the selected measured `444 × 323` pixels at `+296 +355` in the `1024 × 1024` layer.

Update the rendered-bounds assertion to the selected output. Preserve the existing path angle, center, continuous geometry, round caps and joins, graphite gradients, bevel, shadow, white background, adaptive safe-zone transform, and runtime alias behavior.

Regenerate assets only through `bin/generate-todo-icons`. The expected generated changes are:

- `apps/agent-mobile/assets/brand/task-count/0-empty.svg`;
- `apps/agent-mobile/assets/images/task-count/0-empty.png`;
- `apps/agent-mobile/assets/images/task-count/0-empty-foreground.png`;
- `apps/agent-mobile/assets/images/task-count/0-empty-monochrome.png`;
- `docs/prototypes/todo-icon/comparison.png`.

Every non-empty task-count state and every static icon derivative must remain byte-identical.

## Out of scope

- The in-app Home empty state.
- Android's three-row default, pre-hydration, and signed-out icon.
- The one-to-four-task launcher states.
- iOS, splash, tab, browser, Apple touch, or store-listing artwork.
- Task counting, launcher aliases, synchronization, or application data.
- Publishing an EAS Update, preview APK, or app-store release.

## Implementation steps

1. **The generator produces the selected A geometry.** Replace the current empty-path and stroke scales with `1.2325` and `1.088`, then update the approved adaptive-foreground bounds to the generated `444 × 323` result.
2. **Only the clear-Home derivatives change.** Run the generator and require the changed-file and hash set to match the expected five outputs plus the generator itself.
3. **The product documentation describes the reduced mark.** Update `docs/prototypes/todo-icon/README.md` with the selected factors and bounds. Add a completed entry to `docs/todo-app.md`. Keep `docs/plans/todo-empty-launcher-icon-weight.md` unchanged as the historical enlargement plan.
4. **The mobile changelog records the visible correction.** Add a 2026-09-16 entry explaining that the clear-Home launcher checkmark now leaves more space around itself. Keep the 2026-09-14 enlargement entry as history.
5. **The Pixel launcher proves the final presentation.** Build and install a fresh local `development-pixel` dev client, activate the `Empty` alias without changing production tasks, and capture the launcher. Confirm the result matches selected candidate A and still opens the app.

## Test strategy

- Run `bin/generate-todo-icons` twice and compare hashes to prove deterministic output.
- Require the selected empty adaptive foreground to match its approved painted bounds within the existing tolerance and remain inside Android's guaranteed safe circle.
- Require byte equality for task-count states one through four, the static icon, splash, iOS, browser favicons, and Apple touch output.
- Inspect the result using Pixel Launcher's adaptive-icon crop, not a direct rendering of the full foreground layer. Compare it at actual launcher size against the approved A candidate.
- Stop Metro and local Gradle processes, then run mobile tests, lint, typecheck, and Android Expo export serially.
- Run a clean Android prebuild and confirm the `Empty` alias still references the regenerated legacy, adaptive, and monochrome resources. Remove the generated native directory afterward.
- Run `gob run bin/ci`. If the documented NixOS `workerd` limitation blocks untouched Worker checks, retain the passing mobile checks and leave those cross-Worker checks to GitHub Actions.
- Build the `development-pixel` profile locally, install it on the attached Pixel 7, and use the existing non-data-mutating alias harness or a naturally empty hydrated Home. Do not create, complete, edit, move, or delete production tasks. Restore normal source and alias state after verification.
- Capture and share a Pixel launcher screenshot showing the selected mark with visible white space around it, then confirm tapping it launches the app.

No React or native behavior test needs to change because runtime icon selection is unchanged. Generator checks and real-launcher verification cover the modified interface.

## Documentation

Update these current sources of truth in the implementation change:

- `docs/prototypes/todo-icon/README.md` for selected geometry and rendered bounds;
- `docs/todo-app.md` for the implemented and Pixel-verified result;
- `apps/agent-mobile/CHANGELOG.md` for the user-visible correction.

Do not commit the temporary option sheets. The accepted decision is recorded in this plan.

## Skills to use

- `impeccable` — verify the selected size in real launcher context and preserve the existing visual identity.
- `expo-overview` and `expo-native-ui` — retain Expo 57 and Android adaptive-icon constraints.
- `deep-modules` and `vocabulary` — keep all generated derivatives behind the existing icon-generator interface.
- `testing` and `reproducible-locally` — verify bounds, determinism, unchanged neighbors, and the real Pixel result.
- `expo-dev-client` — build and install the native development client required for launcher-resource changes.
- `changelog` and `documentation` — update the product-specific history and sources of truth.
- `git-commit` — commit source, generated assets, documentation, and changelog together.

## Acceptance criteria

- The selected A candidate is implemented: the path and all material strokes are 85% of the current size.
- The adaptive foreground measures `444 × 323` pixels within the existing tolerance and remains centered and safe-zone-contained.
- Pixel Launcher shows clear white space between the checkmark and circular mask, matching the corrected comparison rather than the rejected raw-layer comparison.
- The checkmark's angle, proportions, graphite treatment, white ground, and continuous geometry remain unchanged.
- Only the zero-task state changes; all other generated icon states and platform assets remain byte-identical.
- Generator validation, determinism checks, mobile tests, lint, typecheck, Android export, clean prebuild inspection, and available repository CI checks pass.
- A fresh development client shows the selected icon on the Pixel 7, and the icon still launches the app without any production-data mutation.
- Prototype documentation, todo tracking, and the mobile changelog ship with the asset change.
