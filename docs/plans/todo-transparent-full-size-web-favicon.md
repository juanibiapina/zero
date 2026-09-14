# Transparent, full-size todo favicon

## Bottom line

Fix the reported white-box defect only in browser favicon outputs. Generate a
transparent web derivative whose graphite task rows occupy about 90% of the
square canvas, while preserving the approved opaque and mask-safe assets used by
native launchers and saved home-screen shortcuts.

Do not enlarge the shared source artwork or make native launcher backgrounds
transparent. The browser and native surfaces have different presentation
contracts, so `bin/generate-todo-icons` should adapt one approved source for each
surface behind its existing one-command interface.

## Goal

The Zero todo favicon must sit directly on browser chrome, without a white square
inside the browser's own tab or sidebar tile. Its three rows must use nearly all
of the favicon canvas and remain recognizable at 16, 32, and 48 px on light,
gray, and dark browser backgrounds.

## Research and decisions

### The screenshot identifies a web-only defect

The supplied screenshot shows Zero beside Todoist, Gmail, Calendar, and Telegram
in a browser sidebar. Zero alone has a full opaque white square inside the
sidebar's gray rounded tile. The current files explain that result:

- `apps/agent-web/public/favicon.svg` contains a full-canvas white rectangle.
- `apps/agent-web/public/favicon.png` is an opaque 48 × 48 image with white
  corner pixels.
- `apps/agent-web/index.html` advertises both, with the SVG last.
- `bin/generate-todo-icons` deliberately copies or renders the full white-square
  source for both browser files and validates their corners as white.

The screenshot's peer comparison is technically sound. The fetched 32 px
Todoist, Calendar, and Telegram favicons have alpha at their corners; Gmail's
favicon also has transparent corners. Transparent PNG and SVG icons are supported
browser inputs. MDN documents `rel="icon"` selection by type and size, and
web.dev documents SVG favicons that adapt to browser appearance.

The current backgroundless mark occupies about 63% of a square canvas. Temporary
75%, 82%, 86%, and 90% candidates were compared at 16, 32, and 48 px against
white, `#e5e5e5`, and `#202020`. The 90% candidate best matches the visual weight
of the neighboring favicons while retaining about 5% horizontal and 7% vertical
breathing room. Its graphite highlights remain visible on the dark sample, so no
new dark-mode artwork is justified.

### Native launchers need a different adapter

Expo SDK 57 gives web, iOS, and Android separate icon configuration. Android
adaptive icons use independent foreground, background, and monochrome layers;
the launcher applies its own mask. iOS app icons and Apple touch icons need an
opaque composition. Expo recommends transparency for splash artwork, not for the
launcher composition.

The current generated assets already follow those rules:

| Surface | Required result | Decision |
|---|---|---|
| Agent web browser SVG/PNG | Artwork on transparency | Change to a 90%-fill web derivative |
| Expo mobile package's `web.favicon` | Artwork on transparency | Generate the same 90%-fill web derivative |
| Apple touch icon | Opaque square for iOS masking | Keep byte-identical |
| iOS app icon | Opaque square | Keep byte-identical |
| Android adaptive icons | Transparent safe-zone foreground over a separate white background | Keep byte-identical |
| Android legacy icons | Opaque square fallback | Keep byte-identical |
| Splash icon | Transparent artwork at its current scale | Keep byte-identical |

Existing Pixel 7 launcher evidence shows the task rows filling most of the
visible circular mask without clipping. The generated three-row foreground uses
481 × 461 px of the 1024 px layer, which is about 77% × 74% of Android's 624 px
safe circle. Enlarging the shared source would therefore solve a web canvas
problem by risking a native safe-zone regression.

### One source still owns the artwork

Keep `apps/agent-mobile/assets/brand/todo-icon.svg` as the approved source with
its `background` and `artwork` groups. Do not create a second hand-authored web
SVG. The generator already removes the background for splash and Android
foreground outputs; extend that implementation to produce a web-specific crop
and scale from the same artwork group.

This preserves locality: source geometry and material remain in one file, while
platform adaptation remains inside one deep generation module.

## Technical approach

1. Add a web-artwork path inside `bin/generate-todo-icons` that removes the
   source `background` group and scales the existing `artwork` group around its
   optical center. Target a rendered non-transparent bounding box whose largest
   dimension is 88–92% of the canvas; the researched candidate uses about 90%.
2. Generate both the SVG browser icon and the 48 px PNG fallback from that same
   web tree. Preserve alpha and require transparent corner pixels.
3. Generate `apps/agent-mobile/assets/images/favicon.png` from the same web tree,
   because that file is Expo's web favicon despite living under the mobile app.
4. Keep the Apple touch, iOS, Android legacy, Android adaptive, monochrome, task
   count, and splash output paths unchanged.
5. Point `apps/agent-web/index.html` at fresh browser-icon URLs, such as
   `/favicon-mark.svg` and `/favicon-mark.png`, and retire the current generated
   `/favicon.svg` and `/favicon.png`. A new URL avoids the browser's independent
   favicon cache; the production responses currently revalidate at HTTP level,
   but that does not reliably invalidate browser favicon storage.

## Implementation steps

1. **Browser outputs become transparent and full-size.** Extend the generator's
   internal artwork transformation, render one approximately 90%-fill web tree
   to SVG and PNG, and regenerate the Expo web favicon from it.
2. **Native outputs remain unchanged.** Regenerate all assets and compare
   checksums against the pre-change native icon, task-count, adaptive,
   monochrome, Apple touch, and splash files. Investigate any difference instead
   of accepting it.
3. **Fresh HTML links defeat the reported cache.** Update the two `rel="icon"`
   links to the new generated paths, keep the SVG after the PNG fallback, and
   leave `rel="apple-touch-icon"` on the opaque 180 px file.
4. **Generation enforces each surface contract.** Validate transparent browser
   corners, a centered 88–92% artwork bounding box, dimensions, grayscale color,
   and deterministic output. Retain the existing opaque-corner and Android
   safe-zone checks for native files.
5. **Rendered browser chrome matches neighboring icons.** Compare the result at
   16, 32, and 48 px on light, screenshot-gray, and dark backgrounds, then verify
   it in the same browser sidebar that produced the report and in a fresh
   Chromium profile.
6. **Current documentation describes platform adapters.** Update the brand-asset
   documentation and product tracking, then add the user-visible web changelog
   entry in the same change.

## Test strategy

### Asset invariants

- Run `bin/generate-todo-icons` twice and compare hashes for every committed
  output.
- Assert both browser SVG and PNG have transparent corners and no painted
  full-canvas background.
- Rasterize the SVG at 16, 32, and 48 px; assert the non-transparent bounds are
  centered and the largest dimension remains between 88% and 92%.
- Assert the SVG and PNG use the same composition by raster comparison at 48 px.
- Record pre-change hashes for all native and Apple touch outputs and require
  exact equality after regeneration.
- Keep all current dimensions, neutral-color, opacity, source-shape, and Android
  safe-zone checks passing.

### Web verification

- Run `pnpm --filter @zero/agent-web test`, `lint`, `typecheck`, and the
  production-configured build.
- Serve the Vite build and use the `browse` skill to confirm the new SVG, PNG,
  and Apple touch URLs return `200` with correct MIME types and that built HTML
  advertises the fresh browser URLs.
- Capture one comparison sheet at actual 16, 32, and 48 px over light, gray, and
  dark fields. Compare visual weight with Todoist, Gmail, Calendar, and Telegram.
- Open a fresh tab in the browser/sidebar from the report and confirm there is no
  white rectangle beyond the rows. Repeat in Chromium light and dark chrome.
- After deployment, verify the production HTML and new asset URLs, then confirm a
  fresh production tab shows the new mark rather than the cached square.

### Mobile non-regression

- Export the Expo web target and confirm it receives the transparent generated
  favicon.
- Run mobile tests, lint, typecheck, and an Expo export serially after stopping
  Metro and Gradle.
- Run a clean Android prebuild and compare launcher resources with the baseline.
- On the attached Pixel 7, use Maestro to search for Zero Agent, capture the
  current launcher icon, and open it. Do not create, edit, complete, or delete
  production entities. The white circular field must remain because it is the
  launcher's applied mask and background, and all task-count states must remain
  unclipped.
- Run `gob run env TURBO_CONCURRENCY=1 bin/ci`. If the documented NixOS
  `workerd` limitation stops untouched Worker checks, retain the passing touched
  package checks and leave the full Worker-backed gate to GitHub Actions.

## Documentation and changelog

- Update `apps/agent-mobile/README.md` under **Brand assets**: the approved source
  remains square and layered; browser favicons remove that background and use a
  tighter scale; native launcher and touch adapters remain opaque or mask-safe.
- Update `docs/prototypes/todo-icon/README.md` so it no longer says web receives
  the full square composition.
- Add a concise implemented item to `docs/todo-app.md` after verification. Do
  not rewrite the completed historical icon plans.
- Add a `2026-09-14` entry to `apps/agent-web/CHANGELOG.md` from the user's
  perspective, for example: “Browser tabs now show a larger graphite task mark
  without an extra white square.” Load the `changelog` skill before editing.
- Do not add a mobile changelog entry because native users should receive no
  visible change. Add one only if implementation intentionally changes a native
  result.

## Out of scope

- Changing the approved graphite geometry, gradients, row count, or material.
- Enlarging iOS, Android, Apple touch, splash, or in-app tab artwork.
- Making native launcher or Apple touch backgrounds transparent.
- Dynamic task-count favicons on the web.
- A web app manifest, service worker, PWA maskable icon, or install flow.
- App-store submission, preview APK publication, or unrelated application UI.
- Editing the unrelated untracked
  `docs/plans/todo-project-completion-dependency.md` file.

## Skills to use

- `expo-overview` and `expo-native-ui` — preserve Expo 57's distinct web,
  launcher, adaptive-icon, and splash contracts.
- `deep-modules` and `vocabulary` — keep every platform derivative behind the
  generator's small interface instead of adding another artwork source.
- `impeccable` — compare actual-size icon weight and inspect the final browser
  presentation.
- `browse` — verify the built and deployed assets and the browser rendering.
- `testing` and `reproducible-locally` — enforce alpha, coverage, determinism,
  and native byte-equality as observable outputs.
- `changelog` and `documentation` — update current product truth and user-facing
  history without rewriting historical plans.
- `git-commit` — commit source, generated outputs, docs, and changelog together.

## Acceptance criteria

- The browser SVG and PNG show only the graphite three-row mark; all four corners
  are transparent.
- The mark's largest rendered dimension occupies 88–92% of the square canvas,
  with balanced margins and no clipping at 16, 32, or 48 px.
- The favicon remains recognizable on white, screenshot-gray, and near-black
  browser chrome.
- In the reported browser sidebar, Zero no longer shows a white rectangle inside
  the sidebar's own rounded tile and has visual weight comparable to the four
  neighboring favicons.
- Browser links use fresh URLs, and production serves them with the declared
  image MIME types.
- Expo's web favicon uses the same transparent composition.
- Apple touch, iOS, Android legacy, all five Android adaptive/monochrome states,
  and splash outputs are byte-identical to the baseline.
- The Pixel 7 still shows the platform-masked white launcher icon, every dynamic
  state stays unclipped, and the app opens successfully without production-data
  writes.
- Generation is deterministic and fails on wrong web alpha, coverage, centering,
  dimensions, colors, native opacity, or Android safe-zone containment.
- Web and mobile package checks pass; whole-repository CI reaches only any
  already-documented local `workerd` limitation.
- README, prototype documentation, todo tracking, and the web changelog ship in
  the same change.

## Risks and mitigations

- **Transparent graphite can lose contrast in dark chrome.** Keep the mixed
  silver/graphite material, test at actual sizes on `#202020`, and introduce no
  theme-specific redesign unless real browser evidence fails.
- **A larger web mark can clip filter shadows.** Keep 8–12% total slack, validate
  the alpha bounds after rasterization, and inspect all three target sizes.
- **A shared-source edit can regress native safe zones.** Do not edit source
  geometry or scale; apply the tighter crop only in the web adapter and require
  byte-identical native outputs.
- **Browsers can retain the current square after deployment.** Change the linked
  asset URL and verify in a fresh browser profile before diagnosing the artwork.
- **The mobile-path favicon can be mistaken for a launcher asset.** Document that
  `assets/images/favicon.png` is Expo web-only and prove the generated Android
  resources are unchanged.

## Evidence

- `bin/generate-todo-icons` completed twice with identical hashes for all 27
  generated outputs. The 48 px browser PNG has transparent corners and a
  44 × 42 px content box; the 512 px validation render has a 462 × 442 px box,
  so maximum coverage is 90.2%. Rasterizing the generated SVG at 48 px produced
  zero differing pixels from the PNG fallback. An undersized 50%-coverage fixture
  was rejected.
- All 26 baseline source, Apple touch, splash, iOS/legacy, task-count,
  adaptive-foreground, and monochrome files remained byte-identical. A clean
  Android prebuild retained `MainActivity`, the default launcher alias, four
  disabled task-count aliases, separate adaptive foreground/background layers,
  and monochrome resources.
- Agent web passed 3 test files / 38 tests, lint with 6 existing React Compiler
  warnings, typecheck, and a production-configured build. Vite preview served
  `favicon-mark.svg` and `favicon-mark.png` as their declared image types; built
  HTML references only the fresh paths. Real Chromium rendering at 16, 32, and
  48 px stayed recognizable on white, `#dedee3`, and `#202023`. The Impeccable
  detector reported no findings.
- Mobile passed 21 suites / 140 tests, lint with 3 existing test-file warnings,
  typecheck, Android export, public Expo config inspection, and clean prebuild.
  Expo's public config points `web.favicon` at the new transparent PNG. A full
  Expo web export remains blocked before favicon emission by the existing
  `@op-engineering/op-sqlite` Node entry importing absent `better-sqlite3`; the
  shipped web product is `apps/agent-web`, whose build passed.
- On the attached Pixel 7, Maestro searched the launcher for Zero Agent and
  captured the unchanged, unclipped four-row icon at
  `~/.maestro/tests/2026-09-14_155128/verify-todo-launcher/takeScreenshot/transparent-favicon-native-unchanged.png`.
  Tapping the result opened the app and reached Home. No production entity was
  created or changed.
- `gob run env TURBO_CONCURRENCY=1 bin/ci` passed the touched mobile/web checks
  and stopped only when the untouched dashboard test suite attempted to start
  the dynamically linked `workerd` binary on NixOS, the documented local
  limitation.
