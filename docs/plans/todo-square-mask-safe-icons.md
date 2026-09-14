# Square-first, mask-safe todo icons

## Goal

Make every Zero todo icon start from a full-bleed square design, while preserving correct circular, rounded-square, and squircle presentation when a mobile operating system applies its own mask. The web favicon must no longer contain a pre-drawn white circle with transparent corners.

The key decision is: **design one square composition, then generate platform derivatives from it.** Do not maintain independent square and circular artwork.

- Web renders the square composition as authored.
- iOS receives an opaque square and applies its own launcher mask.
- Android receives a transparent foreground, a white background, and a monochrome foreground; the launcher applies its selected mask.
- Older Android launchers receive an opaque square fallback.
- The splash screen receives the artwork alone on transparency, not a launcher mask.

Android therefore needs multiple files, but they are generated adapters for one design rather than separately maintained icons.

## Current state and root cause

- The static source, `apps/agent-mobile/assets/brand/todo-icon.svg`, draws a white `<circle>` on a transparent 1024 × 1024 canvas.
- The dynamic source, `apps/agent-mobile/assets/brand/task-count/template.svg`, uses the same circular ground for the checkmark and one-to-four-row launcher states.
- `bin/generate-todo-icons` copies the static SVG unchanged to `apps/agent-web/public/todo-icon.svg`. `apps/agent-web/index.html` advertises that SVG after the PNG fallback, so modern browsers can show its transparent corners. Production currently serves these same links and reproduces the circular tab icon.
- The generated 48 px PNG, 180 px Apple touch icon, iOS icon, and Android legacy icons are already flattened onto white and therefore already occupy an opaque square. Replacing the source circle with a square should leave those composites visually unchanged.
- Android adaptive icons are already structured correctly: the generator removes the source background, scales the artwork into Android's safe zone, and supplies a separate white background and monochrome layer. The operating system owns the final mask. The local launcher-alias module and task-count synchronization logic do not need behavioral changes.
- The real web product is `apps/agent-web`; it has no web app manifest or service worker. The `apps/agent-mobile` Expo web favicon is a separate generated fallback.
- Expo 57 guidance confirms the platform model: iOS requires an opaque full square and masks it when appropriate; Android adaptive icons use separate foreground/background layers and can be masked into different launcher shapes; splash artwork should have transparency.

## Technical approach

### 1. Make the source contract square-first

Change both approved source families without changing their graphite artwork, spacing, state meanings, or white/graphite palette:

- In `apps/agent-mobile/assets/brand/todo-icon.svg`, replace the circular ground with a white rectangle that fills `0 0 1024 1024`.
- In `apps/agent-mobile/assets/brand/task-count/template.svg`, make the same change so every generated state has a full-bleed square ground.
- Give the top-level background and artwork groups stable semantic IDs, and have the generator locate them by ID rather than by “first group contains a circle.” This keeps the generator's public interface as the single `bin/generate-todo-icons` command while hiding platform-specific extraction behind it.
- Update SVG titles and descriptions from “circular ground” to “full-bleed white ground.” Regenerate all five state SVGs rather than editing them independently.

The central artwork already fits the existing mobile safe-zone treatment. Do not enlarge or reposition it as part of this correction.

### 2. Generate each platform's required derivative

Refactor only the internals of `bin/generate-todo-icons`:

- **Square composite:** render the full source for `assets/images/icon.png`, the Android legacy task-count PNGs, the mobile favicon, the web PNG fallback, and the Apple touch icon.
- **Web vector:** copy the full square static source to the web public directory. Change the generated public filename and `apps/agent-web/index.html` reference from `/todo-icon.svg` to `/favicon.svg` so browsers receive a fresh URL instead of retaining the aggressively cached circular favicon. Remove the old generated web copy.
- **Splash:** remove the background group but preserve the static artwork's authored scale; render that mark to `assets/images/splash-icon.png` with transparent corners. Do not use the additional Android safe-zone scale for the splash.
- **Android adaptive:** remove the background, apply the existing 0.75 safe-zone transform, and generate the transparent foreground plus monochrome silhouette for all five states. Keep `#FFFFFF` as the adaptive background.
- **Design evidence:** regenerate `docs/prototypes/todo-icon/comparison.png` with square, unmasked state previews.

Keep `apps/agent-mobile/app.json`, the launcher aliases, state switching, and the web PNG/touch-icon links unchanged unless regeneration proves a path must move. No second hand-authored circular asset should be added.

### 3. Make shape errors fail during generation

Extend the generator's existing validation so the source contract and every derivative are measurable:

- both source roots use `viewBox="0 0 1024 1024"`;
- the background is an opaque white rectangle covering the complete view box;
- square composites are opaque and all four corner pixels are white;
- splash, adaptive foreground, and monochrome outputs retain transparent corners;
- every adaptive foreground and monochrome pixel remains within Android's guaranteed safe circle;
- all outputs have their declared dimensions and neutral RGB channels;
- generated output is deterministic across two consecutive runs.

Create a temporary verification sheet, not another production source, that applies square, circle, rounded-square, and squircle masks to the static mark and all five task-count states. Inspect it at launcher size. The safe-zone assertion is the automated guarantee; the sheet is visual evidence.

Expected regression invariant: Android adaptive foregrounds and monochrome layers should remain pixel-identical because only the removed background changes. Investigate any difference before accepting it.

## Implementation steps

1. **The approved sources describe a full square.** Update the static source and task-count template, add stable background/artwork IDs, update accessible descriptions, and regenerate all state SVGs.
2. **One generator produces square and maskable adapters.** Split full-composite, transparent-artwork, safe-zone foreground, monochrome, splash, and web output paths inside `bin/generate-todo-icons`; rename only the web SVG derivative for cache busting.
3. **Generation rejects a pre-cropped source.** Add the full-bleed, alpha, corner, safe-zone, dimensions, color, and deterministic-output checks; regenerate every committed derivative and comparison image.
4. **Web proves the reported defect is gone.** Update `apps/agent-web/index.html`, build and preview the app, and inspect the favicon in fresh light and dark browser profiles at 16, 32, and 48 px.
5. **Mobile proves platform masking still works.** Run a clean Android prebuild, inspect all five adaptive resources, build a fresh development client, and verify the launcher states on the attached Pixel 7 without changing production data.
6. **Current documentation states the platform rule.** Update the mobile README, prototype README, todo project tracking, and web changelog in the same change; add a mobile changelog entry only if mobile users receive a visible difference.

## Test strategy

### Generated assets

- Run `bin/generate-todo-icons` twice and compare SHA-256 hashes for every generated SVG and PNG.
- Use ImageMagick to assert dimensions, opacity/alpha, neutral colors, full-square corner pixels, and Android safe-zone containment.
- Compare pre-change and post-change Android foreground/monochrome pixels; they should match.
- Inspect the temporary multi-mask sheet for the static mark and all five dynamic states.
- Inspect the square favicon at 16, 32, and 48 px on both light and dark surrounding backgrounds.

### Web

- Run `pnpm --filter @zero/agent-web test`, `lint`, and `typecheck`.
- Run the production-configured agent web build through the repository's ZeroVault wrapper, then serve the built Vite assets with `pnpm --filter @zero/agent-web preview`.
- With the `browse` skill, open a fresh tab/profile, verify `/favicon.svg`, `/favicon.png`, and `/apple-touch-icon.png` return `200` with correct image MIME types, and capture a verification page that renders the selected favicon at 16, 32, and 48 px on light and dark backgrounds. Confirm the document advertises the new SVG URL.
- After deployment, verify `https://zero.juanibiapina.dev/favicon.svg` and inspect a fresh production tab. The changed SVG URL prevents the old circular asset from winning through favicon cache.

### Mobile and native resources

- Stop Metro and Gradle before checks on `mini`.
- Run `pnpm --filter @zero/agent-mobile test`, `lint`, `typecheck`, and an Android Expo export serially.
- Run a clean Android prebuild; inspect the default and four alternate adaptive resources, then remove the generated native directory.
- Run `gob run bin/ci`; if the documented NixOS `workerd` failure blocks the untouched Workers, retain the passing package checks as local evidence and leave the full cross-Worker gate to GitHub Actions.
- Build and install a fresh `development-pixel` client on the attached Pixel 7. Use the prior signed-out icon harness or direct disposable alias test path so no production task is created, completed, moved, or deleted.
- Capture the checkmark and one-to-four-row launcher states, verify app and deep-link launch after alias changes, and restore the normal default state. The Pixel's launcher proves its real mask; the generated mask sheet covers shapes the Pixel launcher does not expose.
- Verify the splash PNG structurally as a transparent mark. A development client cannot prove the standalone splash because `expo-dev-client` owns that surface; do not install a preview build on the dev-client-only Pixel.

## Documentation and changelog

- Update `apps/agent-mobile/README.md` under **Brand assets** to state the square-first source contract, generated Android layers, operating-system masking, and transparent splash derivative. Keep build procedures in their existing sections.
- Update `docs/prototypes/todo-icon/README.md` to describe square production sources and platform masks instead of a circular ground.
- Add a concise implemented item to `docs/todo-app.md`; do not rewrite the completed historical icon plans.
- Add one user-facing entry dated `2026-09-14` to `apps/agent-web/CHANGELOG.md`: “Browser tabs now show the task icon on a clean square instead of an awkward pre-cropped circle.”
- Do not add a mobile changelog entry if the launcher pixels remain unchanged as expected: mobile already uses opaque square fallbacks or operating-system adaptive masks. If implementation changes a visible mobile result, add a separate mobile entry describing only that observed difference.

## System-wide impact

- `apps/agent-web` changes redeploy the `zero-api` Worker because that Worker bundles the web assets and watches the web app path.
- Mobile launcher and splash assets ship only in a new native build; no JavaScript, persisted data, task counting, alias switching, authentication, or network behavior changes.
- Existing install aliases remain launchable because neither their manifest structure nor native switching module changes.

## Alternatives considered

- **Keep separate square and circular masters:** rejected because the artwork would drift. Platform derivatives should remain behind one generator interface.
- **Remove only the SVG favicon link:** rejected because it hides the bad source contract and leaves the task-count design evidence pre-cropped.
- **Draw rounded corners into the source:** rejected because iOS and Android would mask an already masked image, producing excess inset and awkward double rounding.
- **Add a web app manifest and maskable PWA icons:** deferred. The current web app is not configured as a PWA, and a manifest is not required to fix the browser favicon or Apple touch icon.
- **Change graphite material, scale, or app colors:** rejected because this task corrects shape adaptation, not the approved artwork.

## Out of scope

- New icon artwork, colors, shadows, row geometry, or task-count meanings.
- Dynamic web favicons or dynamic iOS alternate icons.
- A PWA manifest, service worker, Android web-install assets, or store-listing artwork.
- App-store submission or preview APK publication.
- Landing, dashboard, agent Telegram, tab-navigation, and project emoji icons.

## Skills to use

- `expo-overview` — preserve Expo 57 icon and prebuild conventions.
- `expo-dev-client` — rebuild and install the native development client for Pixel verification.
- `deep-modules` and `vocabulary` — keep platform derivative logic behind the generator's small interface.
- `impeccable` — review small-size and multi-mask visual output.
- `testing` and `reproducible-locally` — make generation deterministic and verify observable files rather than generator internals.
- `browse` — inspect the local and deployed favicon in real browser chrome.
- `changelog` and `documentation` — update user-facing history and current source-of-truth docs.
- `git-commit` — commit sources, generated derivatives, docs, and changelogs together.

## Acceptance criteria

- The static source and every task-count state have a full-bleed white square background with no authored circular or rounded mask.
- The web SVG and PNG favicon show the mark on a square in fresh light and dark browser tabs; no circular transparent margin remains.
- iOS receives an opaque 1024 × 1024 full-square icon and relies on the operating system's mask.
- Android receives separate white-background, transparent safe-zone foreground, and monochrome layers for all five launcher states; square, circle, rounded-square, and squircle previews do not clip important artwork.
- Older Android fallback icons are opaque squares.
- The splash asset contains only the mark on transparency and still uses the configured white splash background.
- Dynamic Home-count behavior, alias launchability, deep links, and all task data behavior remain unchanged.
- Generation is deterministic and rejects non-square backgrounds, wrong alpha, colored pixels, wrong dimensions, or safe-zone escapes.
- Web and mobile package checks pass; clean prebuild inspection passes; all five launcher states are captured on the Pixel 7 without production-data writes.
- The mobile README, prototype README, todo tracking document, and web changelog ship with the correction; the mobile changelog changes only if device verification finds a visible mobile difference.

## Risks and mitigations

- **Favicon cache can preserve the defect after deployment.** Move the modern SVG to a fresh generated public URL and verify in a fresh browser profile.
- **A full-square source can accidentally make the splash an opaque tile.** Generate splash from the unscaled artwork-only tree and assert transparent corners.
- **Background extraction can alter adaptive artwork.** Identify source layers semantically and require pixel equality for existing foreground and monochrome outputs.
- **A launcher mask can clip peripheral artwork.** Preserve the current Android safe-zone transform, retain the automated containment check, and inspect representative masks.
- **Native icon changes can appear correct in generated files but fail on-device.** Rebuild the development client and exercise every alias on the Pixel before completion.

## Evidence

- `bin/generate-todo-icons` completed twice with identical SHA-256 hashes for every generated SVG, PNG, web asset, and comparison image. Its source validator rejected a pre-cropped circle, an inset square, and an extra top-level layer.
- Every Android adaptive foreground and monochrome file remained byte-identical to the pre-change assets. The opaque iOS, legacy Android, PNG favicon, and Apple touch outputs also remained unchanged; only the backgroundless splash derivative changed among mobile raster files.
- `/tmp/todo-icon-verification/masks.png` shows the static mark and all five task-count states under square, rounded-square, squircle, and circle masks without clipping.
- Mobile passed 21 suites / 135 tests, lint with 3 existing warnings, typecheck, Android export, clean Expo prebuild, and native manifest/resource assertions. The prebuild kept `MainActivity` enabled and produced one default plus four alternate aliases with adaptive and monochrome layers.
- Development-client build 72 (`development-pixel`, local) compiled successfully, installed on the attached Pixel 7, and opened against Metro. A temporary source harness changed only the requested launcher alias; no task or other production data changed. Maestro captured the checkmark, one-row, two-row, three-row, and four-row states under the Pixel launcher's circular mask. The production source hash matched its pre-harness hash afterward, and the installed app was restored to the default alias.
- Web passed 3 files / 38 tests, lint with 6 existing React Compiler warnings, typecheck, and the production-configured build. Vite preview served `favicon.svg`, `favicon.png`, and `apple-touch-icon.png` with `200` and the correct MIME types; the built HTML points at the new SVG URL. `/tmp/todo-icon-verification/favicon-sizes.png` shows the full square at 16, 32, and 48 px on light and dark backgrounds.
- The Impeccable detector reported no findings for the changed web HTML and SVG.
- Whole-repository `gob run env TURBO_CONCURRENCY=1 bin/ci` passed lint, typecheck, builds, and all tests through the touched mobile/web packages, then stopped at the documented NixOS inability to execute `workerd` in the untouched dashboard Worker tests.
