# Todo dark mode — mobile and web

> **Status:** implemented locally — package checks pass; fresh-dev-client device proof pending

## Verification findings (adversarial review)

Reviewed against source, the installed `uniwind@1.12.0` package, its docs, and
current Clerk docs. Most of the plan holds up; the mechanism choices are correct.
One resolved blocker and three accuracy fixes.

### Resolved during implementation — `useColor`-only theme tokens remain available

The plan moves **all** adaptive color variables out of the static `@theme` block
into `@variant light` / `@variant dark` blocks under `@layer theme`. Two tokens
are read **only** through `useColor()` and never appear in any Tailwind
`className`:

- `--color-placeholder` — `src/components/ui/input.tsx:19`
- `--color-ripple` — `src/components/ui/list-row.tsx:49`

Uniwind's own rule (docs, "Making Variables Available"; enforced by
`dist/common/hooks/useCSSVariable/useCSSVariable.js`, which `Logger.warn`s
`"We couldn't find your variable … used at least once in your className, or
define it in a static theme"`) is: `getCSSVariable`/`useCSSVariable` resolves a
variable only if it is (1) used in a `className`, or (2) declared in
`@theme static`. A theme variable that lives only in `@variant` blocks and is
never referenced by a `className` is not guaranteed available — the artifact
generator (`dist/common/bundler/artifacts/css/themes.js`) emits it as plain
`@theme { --x: unset; }`, which is **non-static** and therefore tree-shakeable.

Consequence: after the move, `useColor('--color-placeholder')` and
`useColor('--color-ripple')` can return `undefined` (wrong/transparent color)
with only a dev-mode `warn`. **None of the plan's automated gates catch this** —
the `uniwind:types` "missing variable" check (see next finding) only compares the
two variant blocks against each other; it never checks `getCSSVariable`
availability.

Implemented fix: `Input` now uses Uniwind's native
`placeholderTextColorClassName="text-placeholder"`, so the placeholder token is
consumed in a class. `ListRow` renders a hidden `bg-ripple` consumer, which
keeps the Android-only string token available to
`useColor('--color-ripple')` without changing layout or appearance; ripple stays
in both adaptive variant blocks. (A static `light-dark(...)` fallback was
rejected because the Android export reports a Uniwind Color Processor error.)
The input test asserts the placeholder class path. The fresh-dev-client device
proof still verifies both resolved colors in light and dark.
`--color-accent`, `--color-surface`, `--color-surface-muted`,
`--color-foreground`, and `--color-foreground-secondary` are also read via
`useColor` but each appears in a `className` too.

### Fix — the "missing theme variable" gate does not fail the build

The warning the plan relies on exists (`dist/.../artifacts/css/themes.js`:
`Logger.error("Theme … is missing variable …")` and
`"All themes must have the same variables"`), but it is a **logged error, not a
thrown exception** — `generateCSSForthemes` sets `hasErrors` and continues, so
`uniwind:types` can still exit `0`. The plan's acceptance ("output must contain
no missing-theme-variable warning") is correct only if the check greps
stdout/stderr text; make that explicit and do not rely on exit code.

### Fix — `--color-border` is dead

`--color-border` is referenced nowhere (no `className`, no `useColor`; only
defined in `global.css`). The plan lists it in the dark palette table and says to
define it in both variants — that just carries dead tokens forward. Drop it, or
note it is intentionally unused.

### Fix — `docs/todo-app.md` has no dark-mode text to remove

The plan says to "remove dark mode from future work" in `docs/todo-app.md`, but
that file contains no dark-mode or future-work-dark mention at all. The live
"future work / interim `light`" dark-mode text is in
`docs/plans/todo-ui-todoist-alignment.md` (lines ~78-92, 394, 426), which the plan
already references. Change the `todo-app.md` step to "add the shipped note" only.

### Confirmed correct (spot-checked against source/docs)

- Uniwind token-per-theme syntax `@layer theme { :root { @variant light{…}
  @variant dark{…} } }` is the documented approach (docs: Platform Variants /
  Custom Themes).
- Uniwind ships built-in `light`/`dark` custom variants that are class- **or**
  media-driven (`prefers-color-scheme`); `adaptiveThemes` defaults on and nothing
  in `metro.config.js` or the app overrides it or calls `setTheme`. So flipping
  `app.json` `userInterfaceStyle` to `automatic` is sufficient for live
  system-driven switching, and `useColor` re-renders on theme change.
- Three mobile `shadow-lg` sites confirmed: `ui/fab.tsx:34`,
  `quick-add-bar.tsx:40`, `ui/confirm-dialog.tsx:37`.
- `app.json` currently pins `userInterfaceStyle: "light"`; splash `#208AEF`.
- Web `index.css` has `@custom-variant dark (&:is(.dark *))`, full `:root` +
  `.dark` blocks, and `body { @apply bg-background text-foreground }`. There are
  **zero** `dark:` utilities in web source, so removing the custom variant is
  inert for existing utilities.
- **Clerk claim verified and stronger than stated.** Current Clerk docs
  (react/…/appearance-prop/themes): the default theme "supports both light and
  dark modes, with light mode displaying by default unless a `color-scheme` is
  defined … set `color-scheme` … `@media (prefers-color-scheme: dark) { :root {
  color-scheme: dark } }`." The plan's `color-scheme` steps match exactly; no
  `@clerk/themes`/`@clerk/ui` package needed. Web renders the prebuilt
  `<SignIn />` (`App.tsx`) and `<UserButton />`; mobile sign-in is custom (only a
  Clerk avatar in `screen-header.tsx`), so the Clerk surface that must go dark is
  web-only. Caveat: this is version-sensitive (`@clerk/react@^6.12.10`) — the
  plan's browser proof (verify computed `color-scheme` on the Clerk portal)
  covers it; keep that step.
- `index.html` has no `color-scheme`/`theme-color` meta (plan correct to add
  them). Web hardcoded color literals are limited to `text-white` on the
  destructive button and `bg-black/40` on the sheet overlay — both
  theme-agnostic, so the plan's "literals confined to the token file" is slightly
  off but benign.

---

> **Original status:** ready to implement

## Goal

Make both todo surfaces follow the device/browser light or dark preference
automatically:

- `apps/agent-mobile` (Expo / React Native / Uniwind)
- `apps/agent-web` (Vite / React / Tailwind / shadcn)

Every app-owned surface, native/browser control, and piece of system chrome must
change together without a relaunch or page refresh. Preserve each surface's
current layout, behavior, copy, accessibility interface, and visual language.
Add no theme toggle or other visible element.

## Decisions

1. **System preference is the only authority.** There is no stored theme choice,
   settings UI, React theme provider, or manual class toggle. A future explicit
   preference can be designed separately if users ask for it.
2. **Each existing token module remains authoritative for its surface.** Mobile
   keeps `apps/agent-mobile/global.css`; web keeps
   `apps/agent-web/src/index.css`. They have different semantic vocabularies and
   different incumbent designs, so this change does not introduce a shared CSS
   file or force palette parity.
3. **No screen receives theme logic.** Mobile screens continue using semantic
   Uniwind classes and `useColor()`; web continues using shadcn semantic classes.
   Theme activation and values stay at each app's root.
4. **Light mode is a regression baseline.** Preserve all current light values.
   Dark mode changes color and elevation only; structure and interaction stay
   unchanged.
5. **No new dependency.** Both styling systems already support adaptive dark
   mode. Clerk's default web theme follows CSS `color-scheme`, so no Clerk theme
   package is needed.

## Current state

### Mobile

- Expo SDK 57 / React Native 0.86 with Uniwind 1.12 and Tailwind 4.
- `global.css` has one light-only `@theme` token set. React Native views use
  classes such as `bg-background`, `text-foreground`, and `border-divider`.
- String-only color props (`@expo/ui`, `NativeTabs`, input placeholders, Android
  ripple) read the same variables through `src/lib/theme.ts`'s `useColor()`.
- `app.json` forces `userInterfaceStyle: "light"`, which also holds native
  sheets, tabs, status/navigation chrome, and `Appearance` in light mode.
- Uniwind provides adaptive `light`/`dark` themes by default. Its scalable token
  form is `@layer theme { :root { @variant light { … } @variant dark { … } } }`;
  both variants must define the same variables.

### Web

- Vite / React / Tailwind 4 with shadcn's New York neutral token set.
- `src/index.css` already contains complete `:root` light variables and a
  complete `.dark` variable block. All reviewed pages and shared UI use semantic
  classes; color literals are confined to the token file.
- Dark mode never activates: `@custom-variant dark (&:is(.dark *))` requires a
  `.dark` ancestor, but no module adds one.
- Tailwind's default dark variant already uses
  `prefers-color-scheme: dark`. Removing the class override restores that
  behavior. The dark variable block can use the same media query directly.
- The document has no `color-scheme` or theme-color metadata. Browser controls,
  canvas, and Clerk's default SignIn/UserButton surfaces therefore begin light.

## Mobile implementation

### 1. Define one complete adaptive palette

In `apps/agent-mobile/global.css`:

- Keep spacing, typography, and radius tokens in the static `@theme` block.
- Move all adaptive color variables into matching `@variant light` and
  `@variant dark` blocks under `@layer theme` / `:root`.
- Preserve every existing light value exactly.
- Define every adaptive variable in both variants. Treat Uniwind's “missing
  variable” or “all themes must have the same variables” warning as a failed
  build.
- Regenerate and commit `src/uniwind-types.d.ts`; its registered theme list stays
  `['light', 'dark']`.

Use this dark palette as the device-review baseline:

| Token | Dark value | Purpose |
|---|---:|---|
| `--color-background` | `#1f1f1f` | list and screen background |
| `--color-surface` | `#282828` | quick-add, dialog, raised surfaces |
| `--color-surface-muted` | `#333333` | native text-field fill |
| `--color-divider` | `#343434` | row and section separators |
| `--color-foreground` | `#f2f2f2` | primary text (14.7:1 on background) |
| `--color-foreground-secondary` | `#b3b3b3` | secondary text |
| `--color-foreground-muted` | `#8a8a8a` | inactive/completed text (≥4.5:1) |
| `--color-placeholder` | `#969696` | input placeholders |
| `--color-border` | `#414141` | outlined controls |
| `--color-checkbox` | `#8f8f8f` | incomplete check circles |
| `--color-accent` | `#208aef` | unchanged Zero blue; 4.6:1 on background |
| `--color-on-accent` | `#ffffff` | FAB glyph and swipe label |
| `--color-danger` | `#ff746a` | destructive text |
| `--color-swipe-postpone` | `#ad6200` | unchanged; white remains 4.6:1 |
| `--color-scrim` | `rgb(0 0 0 / 0.55)` | overlay separation |
| `--color-ripple` | `rgb(255 255 255 / 0.12)` | Android press feedback |

Add a semantic `--shadow-raised` token to both variants and replace the three
mobile `shadow-lg` call sites (FAB, quick-add, confirm dialog) with
`shadow-raised`. Keep the light shadow visually equivalent to today and use a
stronger black alpha in dark mode. If Uniwind does not compile a
variant-defined `--shadow-*` utility, keep the standard shadow and use semantic
surface contrast plus `border-divider`; never scatter inline shadows.

The exact dark neutrals may move during device critique, but only in this token
module.

### 2. Let native chrome follow the same system setting

In `apps/agent-mobile/app.json`, change `userInterfaceStyle` from `light` to
`automatic`. Keep the theme-independent blue splash screen.

In the root layout:

- Render Expo `StatusBar` with `style="auto"` so icon contrast tracks appearance.
- Resolve `--color-background` once with `useColor()` and apply it to the
  `GestureHandlerRootView` and Stack content. Those wrappers do not accept
  Uniwind `className`; the root background prevents white navigation flashes.

In the signed-in layout:

- Keep `NativeTabs` fed by `useColor()` for accent, surface, and icon colors;
  those hooks update when Uniwind changes theme.
- Give the authentication-loading container `bg-background` instead of an
  unthemed StyleSheet-only surface.

Native `@expo/ui` BottomSheet, Button, Column/Row, and TextInput should follow
`Appearance` once app configuration is automatic. Keep explicit field/label
colors token-backed. Add an `@expo/ui` theme JSON only if fresh-build device
evidence shows a native control does not follow the OS; do not introduce a
speculative second palette.

Changing `userInterfaceStyle` is native app configuration. No dependency is
added, but the attached Pixel needs a fresh **development** dev-client build;
Metro/OTA alone cannot prove this part.

## Web implementation

### 3. Activate the existing dark palette with CSS media preference

In `apps/agent-web/src/index.css`:

- Remove `@custom-variant dark (&:is(.dark *))`. Tailwind then returns to its
  default media-driven `dark:` variant for current or future utilities.
- Keep the current `:root` light token values unchanged.
- Replace `.dark { … }` with
  `@media (prefers-color-scheme: dark) { :root { … } }`, preserving the existing
  dark shadcn values. No component needs `dark:` classes because its semantic
  variables change underneath it.
- Set `color-scheme: light` in the light root and `color-scheme: dark` in the
  media block. This themes native form controls, scrollbars, browser defaults,
  and Clerk's default components consistently.

Do not add `matchMedia` React state, `localStorage`, a provider, or a script that
mutates `.dark`. The media query updates live and runs before React.

### 4. Prevent light browser chrome and first-paint flashes

In `apps/agent-web/index.html`:

- Add `<meta name="color-scheme" content="light dark">` so the user agent knows
  both schemes are supported before the JS-imported stylesheet loads.
- Add paired `theme-color` meta entries with media queries: white for light and
  the existing dark background's sRGB equivalent (approximately `#171717`) for
  dark. Comment that these two bootstrap values mirror the CSS backgrounds,
  since metadata cannot consume CSS variables.

The existing `body { @apply bg-background text-foreground; }` remains the root
web surface. Verify all routes, Radix sheet portals, native select/textarea
controls, Clerk SignIn, and UserButton popovers. Fix any escaped color at the
semantic token or shared shadcn module; do not add page-local dark overrides.

## Cross-surface boundaries

- The shared product rule is automatic system preference and equivalent semantic
  intent. Exact token names and color syntax remain surface-specific.
- Do **not** share a CSS file in this change. Mobile Uniwind theme variants and
  web shadcn variables have different compilation/runtime contracts; forcing a
  shared file would couple two independent implementations without reducing the
  theme interface.
- Do not restyle the web app to match the new flat mobile layout. Web visual
  alignment remains a separate project.
- Do not change entity behavior, routes, strings, placeholders, accessibility
  labels, Maestro flows, or web interaction tests except where verification
  needs theme-aware setup.

## Tests and verification

### Automated checks

Mobile:

- `pnpm --filter @zero/agent-mobile run uniwind:types`; output must contain no
  missing-theme-variable warning.
- `pnpm --filter @zero/agent-mobile run lint`
- `pnpm --filter @zero/agent-mobile run typecheck`
- `pnpm --filter @zero/agent-mobile exec jest --runInBand`
- `pnpm --filter @zero/agent-mobile exec expo export --platform android
  --output-dir /tmp/zero-agent-mobile-dark`
- `pnpm --filter @zero/agent-mobile exec expo config --type public`; resolved
  `userInterfaceStyle` must be `automatic`.

Web:

- Existing Vitest page tests remain behavior-focused; jsdom does not render CSS
  media queries, so do not fake visual confidence with class-name assertions.
- `pnpm --filter @zero/agent-web run lint`
- `pnpm --filter @zero/agent-web run typecheck`
- `pnpm --filter @zero/agent-web run test`
- `pnpm --filter @zero/agent-web run build`
- Run the Impeccable detector once over changed web targets after implementation.

Repository acceptance uses `gob run bin/ci`; on this NixOS host, if unrelated
`workerd` stages hit the documented local limitation, retain the direct package
results and let GitHub Actions cover the full deploy dry run.

### Mobile device proof (Pixel 7)

1. Build and install a fresh `development` dev client. Never put a preview or
   production build on this development-only phone.
2. Start headless Metro with `--clear`, run
   `adb reverse tcp:8081 tcp:8081`, and launch the dev client.
3. Set dark mode with `adb shell cmd uimode night yes`; cold-launch and run
   `.maestro/dev/screens.yaml`. Extend the dev-only sweep to capture quick-add,
   discard dialog, Capture sheet, and Project sheet if needed.
4. While foregrounded, switch `yes → no → yes`. React content, `NativeTabs`,
   status icons, keyboard, and native sheets must change together without stale
   surfaces or a relaunch.
5. Run `.maestro/run-release.sh` once to prove behavior is unchanged. Retain
   screenshot sets for both themes, then restore the phone with
   `adb shell cmd uimode night no`.

Review swipe-to-Tomorrow coverage, sticky Project headers, dark keyboard docking,
FAB/quick-add/dialog elevation, and cold-launch flashes.

### Web browser proof

1. Run the Vite app and API using the repository's documented dev commands.
2. In Chrome DevTools Rendering, emulate `prefers-color-scheme: light`, capture
   desktop and phone-width screenshots of Captures, Upcoming, Projects, detail
   sheets, Settings/onboarding, and Clerk surfaces.
3. Switch emulation to dark while each page is open. The page, fixed nav,
   Radix portals, form controls, scrollbars, and Clerk popovers must update
   without refresh.
4. Reload directly into a dark preference and confirm no white first paint.
   Inspect the two theme-color media entries and computed `color-scheme`.
5. Run one bounded visual critique across desktop/mobile and light/dark:
   hierarchy, contrast, proximity, repetition, alignment, focus visibility, and
   disabled/error states. Batch token fixes, then make at most one confirmation
   screenshot pass.

## Documentation and changelogs

Ship documentation with the implementation:

- `apps/agent-mobile/README.md`: replace “Light theme only” with adaptive theme
  structure, system-only policy, fresh-build requirement, and screenshot steps.
- `docs/todo-app.md`: add one shipped cross-surface dark-mode note and remove dark
  mode from future work.
- `docs/plans/todo-ui-todoist-alignment.md`: point its mobile dark-mode follow-up
  to this plan; mark it completed once shipped instead of duplicating details.
- `apps/agent-mobile/CHANGELOG.md`: user-facing bullet that mobile follows the
  phone's light or dark appearance.
- `apps/agent-web/CHANGELOG.md`: user-facing bullet that web follows the device
  light or dark appearance.

Use the implementation date and commit each changelog with its corresponding
surface change.

## Skills to use

- `expo-overview` — confirm Expo SDK/config constraints.
- `expo-design-system` — keep mobile adaptive values in the existing token module.
- `expo-native-ui` and `expo-ui` — validate native chrome and `@expo/ui` controls.
- `expo-dev-client` — create the fresh development build required by app config.
- `shadcn` — preserve web semantic-token conventions and avoid manual dark classes.
- `impeccable` — perform the bounded cross-viewport web visual critique.
- `browse` — inspect and screenshot web pages and portal states.
- `changelog` — write both product-specific user-facing entries.
- `testing` — preserve behavior tests and choose integration proof for CSS media.
- `git-commit` and `open-pr` — ship the implementation and shepherd CI when asked.

## Acceptance criteria

1. Both surfaces follow the system preference by default, including live changes,
   with no toggle, storage, provider, or manual theme class.
2. Mobile dark cold launch has no white flash; all screens, list rows, quick-add,
   dialogs, sheets, keyboard, status icons, and native tabs are dark and legible.
3. Web dark first paint has no white flash; app pages, fixed navigation, Radix
   portals, browser controls, scrollbars, Clerk surfaces, and browser theme color
   are dark and legible.
4. Switching OS/browser preference while each app is open updates all relevant
   surfaces without restart/refresh or mixed-theme remnants.
5. Current light screenshots remain visually unchanged except for an equivalent
   semantic raised-shadow implementation on mobile.
6. Mobile themes define identical adaptive variable sets; web retains one
   complete light and one complete dark shadcn variable set. No screen owns a
   theme-specific palette.
7. Text, controls, focus rings, borders, dividers, error/destructive states, and
   disabled states meet WCAG AA for their rendered size and role.
8. Mobile Uniwind generation, lint, typecheck, Jest, Expo export, release Maestro,
   and both-theme screenshots pass; web lint, typecheck, Vitest, build, and
   desktop/mobile both-theme screenshots pass.
9. A fresh mobile development build proves `userInterfaceStyle: automatic`; both
   changelogs and shared documentation ship with the code.

## Risks and mitigations

- **Old mobile dev client stays light.** `userInterfaceStyle` is build-time
  configuration. Install a fresh development build before diagnosing Uniwind.
- **Uniwind variables diverge.** Keep light/dark blocks adjacent and fail on
  artifact warnings about missing variables.
- **Native and React mobile surfaces disagree.** Verify automatic app config and
  fresh build first; add an `@expo/ui` override only with device evidence.
- **Web CSS is dark but Clerk stays light.** Confirm computed `color-scheme` on
  the document and Clerk portal. Clerk's default theme supports system schemes;
  only then consider a token-backed provider appearance, without a new package.
- **Web first paint flashes white.** Verify `color-scheme` and theme-color metadata
  are in `index.html` before the module script; avoid a late React effect.
- **Dark shadows disappear.** Prefer semantic surface contrast and one raised
  token rather than page/screen elevation literals.
- **Cross-surface token sharing expands scope.** Keep the behavioral policy
  shared and the two token implementations independent in this change.
