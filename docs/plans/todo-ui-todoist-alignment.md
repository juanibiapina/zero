# Plan: Todoist-aligned UI pass for the mobile todo app

## Goal

Make the mobile todo app (`apps/agent-mobile`) look and feel like Todoist on
the elements it already has, and move the styling tech from NativeWind v4 to
Uniwind (Tailwind 4) so every visual value comes from one CSS token block. No
new UI elements and no behavior changes: the same screens, rows, sheets,
dialog, quick-add, and tab bar, restyled.

Success is: all three tabs (Captures, Upcoming, Projects) read as a flat,
dense, Todoist-style task list; every color, size, radius, and shadow in the
app resolves to a token in `global.css`'s `@theme` block (React Native and
`@expo/ui` alike); NativeWind and Tailwind 3 are gone; and the existing unit
tests, Maestro flows, and behaviors pass unchanged.

Scope is the mobile app only. `apps/agent-web` is a separate React-DOM app on
Tailwind 4 + shadcn, shares no UI code with mobile, and gets its own pass
later. Sharing one token file between the two is a named follow-up.

## Background a fresh agent needs

- **The app.** Expo SDK 57, React Native 0.86, React 19.2, New Architecture,
  React Compiler on (`experiments.reactCompiler` in `app.json`). Routes live in
  `src/app/`; the signed-in tree is a `NativeTabs` navigator
  (`src/app/(signed-in)/_layout.tsx`) with three tab screens: `index.tsx`
  (Captures), `upcoming.tsx`, `projects.tsx`. Shared primitives live in
  `src/components/ui/` (`Text`, `Input`, `Fab`, `ConfirmDialog`, `Sheet`) and
  the quick-add composite in `src/components/quick-add.tsx` +
  `quick-add-bar.tsx`. Classes are composed with `cn()` in `src/lib/cn.ts`
  (clsx + tailwind-merge).
- **Styling today.** NativeWind v4 on Tailwind v3: `babel.config.js` sets
  `jsxImportSource: 'nativewind'` + the `nativewind/babel` preset,
  `metro.config.js` wraps with `withNativeWind`, `tailwind.config.js` holds one
  token (`primary: '#208AEF'`), `global.css` has the v3 `@tailwind` directives,
  `nativewind-env.d.ts` provides types. 58 `className` sites across 10 files.
  The detail sheets (`Sheet` wraps the universal `@expo/ui` `BottomSheet`)
  render `@expo/ui` `Column` / `Row` / `Text` / `Button` / `TextInput`, which
  take inline `style` / `textStyle` objects, cannot take `className`, and so
  carry hex literals (`backgroundColor: '#f5f5f5'`, `placeholderTextColor
  ="#9ca3af"`).
- **Why Uniwind.** Researched in
  `docs/investigations/mobile-ui-styling-tech.md`. In short: no Babel preset
  (the NativeWind JSX runtime is why `jest.setup.js` and two screen tests
  carry "no JSX in a `jest.mock` factory" workarounds); Tailwind 4 with tokens
  in CSS `@theme`, the same syntax `apps/agent-web/src/index.css` uses;
  `Uniwind.getCSSVariable` / `useCSSVariable` / `useResolveClassNames` read
  tokens as strings, which is what `@expo/ui` needs (`textStyle.color` is
  typed `string`); light/dark/custom themes via `@variant` with no provider;
  JS-only free tier (MIT), so no dev-client rebuild; named in Expo's Tailwind
  guide and shipped as the official `expo/examples/with-router-uniwind` on
  SDK 57; 1.12.0 released 2026-09-04, monthly cadence. NativeWind v5 is a
  stalled preview.
- **Uniwind mechanics (from its docs).** Install `uniwind` + `tailwindcss@4`.
  `global.css` starts with `@import 'tailwindcss'; @import 'uniwind';` and
  lives at the project root (Tailwind scans from that directory). Import it
  once in the root layout, never in the entry file. `withUniwindConfig(config,
  { cssEntryFile: './global.css', dtsFile: './src/uniwind-types.d.ts' })` must
  be the **outermost** Metro wrapper. Metro generates the `.d.ts` on first
  run (typecheck needs it to exist). `className` merging is not deduplicated;
  keep `cn()` (tailwind-merge v3 supports Tailwind 4). Reanimated animates via
  `style`, never `className` (free tier); the swipe row and quick-add already
  do this. Theme changes re-render in the free tier, fine at this size.
- **NativeWind has no native module and neither does Uniwind**, so the swap
  needs no EAS rebuild. After changing `babel.config.js` / `metro.config.js`,
  start Metro with `--clear` (documented cache gotcha in the README).
- **Testing reality.** Unit tests (`jest-expo`, `@testing-library/react-native`)
  query by accessibility label, text, placeholder, and `testID`; none assert on
  styles or snapshots. Those strings are the contract to preserve (see
  "Strings that must not change"). Under jest there is no Metro, so a
  `className` prop is inert; the spike confirms no mock is needed. The Maestro
  release flows (`.maestro/release/*.yaml`) tap `"Capture"`, `'Process
  "<text>"'`, and assert the `"Captures"` title. A real Pixel 7 is attached to
  the `mini` host for on-device screenshots via `maestro` (see the README's
  "Physical device testing"). This dev box cannot run an emulator.
- **Automatic appearance (completed 2026-09-05).** `app.json` uses
  `userInterfaceStyle: "automatic"`; matching `@variant light` and
  `@variant dark` tokens keep content and native chrome in step. See
  `todo-dark-mode.md` for implementation and device-proof details.
- **In-flight plan to keep consistent:** `docs/plans/todo-capture-animations.md`
  documents `babel.config.js` as having the `nativewind/babel` preset. Phase 1
  removes that preset; update that plan's babel note in the same change.

## Decisions

1. **Uniwind (free tier) replaces NativeWind.** Alternatives considered:
   - *Plain `StyleSheet` + a `src/theme/` token module* (Expo's default
     template pattern). Zero dependencies and what the Expo skills prescribe,
     but dark mode, theme switching, and web token sharing are hand-rolled,
     and the app loses the Tailwind vocabulary the rest of the repo uses.
     Kept as the fallback if the spike fails.
   - *Keep NativeWind v4 and grow `tailwind.config.js`.* Leaves the Babel/jest
     friction and Tailwind 3, and still cannot style `@expo/ui`. Rejected.
   - *Unistyles 3 / Tamagui / a component kit (HeroUI Native, React Native
     Reusables).* Native modules or a foreign design language; nothing here
     needs them. Rejected for this pass.
2. **Tokens live in CSS, not JS.** `global.css` `@theme` is the single source.
   Code that needs a value as a string (`@expo/ui` props, `NativeTabs` color
   props, `placeholderTextColor`, `android_ripple`) reads it with
   `useCSSVariable` (in components) or `Uniwind.getCSSVariable` (module
   scope), never a hex literal.
3. **Keep the Zero blue accent (`#208AEF`).** Alignment with Todoist is about
   layout, density, typography, and interaction feel, not its red brand. The
   splash and adaptive icon are already blue.
4. **No new elements.** No date chips, priority colors, illustrations,
   snackbars, calendar strip, project counts, or icons that do not exist today.
   The `▸`/`▾` text glyph on collapsible headers stays. Pressed feedback
   (ripple / opacity) is a *state*, not an element, and is in scope.
5. **Spike first, then two phases on one branch.** A one-hour spike proves
   Uniwind works with this app's jest, React Compiler, and `@expo/ui` bridge.
   Phase 1 migrates NativeWind → Uniwind at visual parity so the diff is
   mechanical; phase 2 restyles. A reviewer can screenshot-diff phase 1
   against the baseline and read phase 2 as a pure design change.

## What to change and why

### Phase 0 — Spike and baseline

**Spike (time-boxed to one hour, throwaway branch).** Follow Uniwind's
"Migrate from NativeWind" guide on the app and check:

1. `pnpm --filter @zero/agent-mobile test` passes with `className` inert
   under jest and no Uniwind mock. If a mock is needed, note the shape.
2. The Captures screen renders on the Pixel with React Compiler on and
   `expo start --clear`; swipe, drag, quick-add, and the sheet still work.
3. A `@theme` token reaches an `@expo/ui` `TextInput` via `useCSSVariable`.
4. `expo export --platform android --output-dir /tmp/x` succeeds.
5. Where `uniwind-types.d.ts` should live; decide to commit it (recommended:
   commit, so `typecheck` works in CI without a Metro run) or gitignore it
   and add a generation step.

If any check fails without a documented fix, fall back to decision 1's
`StyleSheet` alternative and rewrite phase 1 accordingly.

**Baseline screenshots.** Capture "before" screenshots of every screen state
on the Pixel with a Maestro flow at `.maestro/dev/screens.yaml` (a new folder;
`ci/` and `release/` are run by workflows and must stay untouched). Use
`launchApp` without `clearState` so the signed-in session survives. States:
Captures (empty, rows, quick-add open with keyboard, detail sheet open,
discard dialog open); Upcoming (empty, two day sections); Projects (empty,
grouped list with one collapsed section, detail sheet open, a row mid-Undo);
Sign-in. Screenshots land under `~/.maestro/tests/<timestamp>/`; copy them
somewhere durable for the comparison.

### Phase 1 — NativeWind → Uniwind at visual parity

**Dependencies.** `npx expo install uniwind tailwindcss@4`. Remove
`nativewind`, `react-native-css-interop`, and the Tailwind 3 devDep. Keep
`clsx` and `tailwind-merge` (`cn()` stays). Run `pnpm install` so the
lockfile updates.

**Config.**
- `global.css` (project root): replace the `@tailwind` directives with
  `@import 'tailwindcss'; @import 'uniwind';` and add an `@theme` block that
  reproduces today's values exactly, so phase 1 is visually identical:
  `--color-background: #ffffff`, `--color-surface: #ffffff`,
  `--color-surface-muted: #f5f5f5` (today's `neutral-50` / `#f5f5f5`),
  `--color-foreground: #171717` (`neutral-900`), `--color-foreground-secondary:
  #525252` (`neutral-600`), `--color-foreground-muted: #a3a3a3`
  (`neutral-400`), `--color-placeholder: #9ca3af`, `--color-border: #e5e5e5`
  (`neutral-200`), `--color-checkbox: #a3a3a3`, `--color-accent: #208AEF`,
  `--color-on-accent: #ffffff`, `--color-danger: #dc2626` (`red-600`),
  `--color-swipe-postpone: #059669` (`emerald-600`), `--color-scrim:
  rgb(0 0 0 / 0.4)`. Spacing and radius use Tailwind's defaults for now
  (phase 2 names the ones the design needs).
- `metro.config.js`: drop `withNativeWind`; export
  `withUniwindConfig(config, { cssEntryFile: './global.css', dtsFile:
  './src/uniwind-types.d.ts' })` as the **outermost** wrapper around the
  fake-auth resolver config.
- `babel.config.js`: drop `jsxImportSource: 'nativewind'` and the
  `nativewind/babel` preset; keep `react-native-worklets/plugin` last.
- Delete `tailwind.config.js` and `nativewind-env.d.ts`; remove the latter
  from `tsconfig.json` `include`. Keep the `declare module '*.css'` shim if
  the CSS import still needs it (check after the spike).
- `src/app/_layout.tsx` keeps the single `global.css` import.

**Classes.** Replace Tailwind-3-only class names with their v4 equivalents
(e.g. `shadow-lg` semantics, `gap-*` unchanged); replace raw palette classes
(`bg-neutral-50`, `text-neutral-900`, `border-neutral-200`, `bg-emerald-600`,
`text-red-600`, `bg-primary`) with the token classes above (`bg-surface-muted`,
`text-foreground`, `border-border`, `bg-swipe-postpone`, `text-danger`,
`bg-accent`). Component contracts keep `className?: string` merged with
`cn()`.

**Hex literals → tokens.** The two remaining literals (`Input`'s
`placeholderTextColor`, the capture-detail `TextInput` background) read their
value with `useCSSVariable('--color-placeholder')` /
`useCSSVariable('--color-surface-muted')`.

**Jest.** `jest.setup.js` and two screen tests carry comments and shapes
chosen to keep JSX out of `jest.mock` factories because of the NativeWind
transform. Rewrite those comments to state the present (the factories may use
JSX now); simplifying the factories themselves is optional. Tests must pass
with no behavior edits. Add the spike's Uniwind mock only if the spike showed
one is needed.

**Docs.** Rewrite the README's "Styling and UI" section (Uniwind on Tailwind
4, tokens in `global.css` `@theme`, `useCSSVariable` for `@expo/ui` and other
string-typed color props, the generated `uniwind-types.d.ts`, `--clear` after
config changes, the `expo export` check) and the "UI stack" subsection's
NativeWind references. Update `docs/todo-app.md` ("Mobile UI on NativeWind v4
+ `@expo/ui`") and the babel note in `docs/plans/todo-capture-animations.md`.

**Parity check.** Re-run the phase 0 flow; screens must match the baseline to
the eye.

### Phase 2 — Todoist alignment, element by element

Todoist's numbers are not published; the values below are close reads of the
Android app and are the starting point. Tune on device with screenshots, and
when a value changes, change the token in `global.css`, not the screen.

**Palette (retune `@theme`).** `--color-foreground: #202020`;
`--color-foreground-secondary: #808080`; `--color-foreground-muted: #b3b3b3`;
`--color-divider: #eeeeee` (new); `--color-checkbox: #999999`;
`--color-surface-muted: #f5f5f5`; `--color-accent` unchanged;
`--color-danger: #dc4c3e`; `--color-swipe-postpone: #ad6200` with
`on-accent` white text (Todoist colors "Tomorrow" orange; the darker shade
keeps white text at ≥4.5:1); `--color-ripple: rgb(0 0 0 / 0.08)` (new). Rows
stop using `border`.

**Typography (`@theme` text tokens + `Text` variants).** Define
`--text-title: 26px` / `--text-title--line-height: 32px` / weight 700;
`section-header` 15/20/600 on `foreground` (new `Text` variant); `body`
16/22/400; `subtitle` 14/20/400 on `foreground-secondary`; `caption` 13
on `foreground-secondary`; `button` 15/600; `error` 13 on `danger`. System
font (Roboto on Android). No font size outside `global.css` + `text.tsx`.

**Spacing and radius (`@theme`).** Name the steps the design uses:
`--spacing-row-y: 12px`, `--spacing-screen-x: 16px`, and rely on Tailwind's
4-point scale for the rest. Radius: `--radius-dialog: 28px` (Material
dialog), Tailwind `rounded-2xl` (16) for the quick-add surface, `rounded-full`
for the FAB.

**Screen shell (all three tabs).** Extract a `ScreenHeader` primitive
(title + `UserButton`, safe-area top padding from `useSafeAreaInsets`
instead of the fixed `pt-16`, `px-screen-x`). Screen background
`bg-background`. List content has no horizontal padding; rows carry their
own so a ripple and the divider span the content width.

**Rows (Captures, Upcoming, Projects).** Flat: no card, no border, no radius,
no gap between rows. `py-row-y px-screen-x gap-3` between the check circle
and text. A hairline divider (`StyleSheet.hairlineWidth`, `bg-divider`)
under each row, inset from the left to the text start (screen-x + 22 + 12).
Check circle: `h-[22px] w-[22px] rounded-full border-[1.5px] border-checkbox`,
keep the `hitSlop`. Row pressed feedback: `android_ripple={{ color:
useCSSVariable('--color-ripple') }}` on the row `Pressable`, `active:opacity-70`
elsewhere. Text `body`. Because rows are now flat, the Captures row must set
an opaque `bg-background` so the swipe's "Tomorrow" layer only shows in the
gap the card opens; the wrapper keeps `overflow-hidden` without a radius.
Projects rows keep the emoji leading slot (22dp box, centered) so the title
aligns with the Captures text column. Mid-Undo rows: `text-foreground-muted
line-through`, Undo in `text-accent` `button`.

Extract the shared shell as `src/components/ui/list-row.tsx` (`ListRow`: the
padded, rippled, divided container with leading / body / trailing slots) and
`CheckCircle` (the process circle with its accessibility label). Three screens
render this same shape; the row look is the thing most likely to be re-tuned,
so it should live in one place. Gesture wrappers and inline editors stay in
the screens.

**Section headers (Upcoming days, Projects statuses).** `section-header`
label, count in `text-foreground-secondary`, `pt-6 pb-2`, hairline divider
under the header, opaque `bg-background` (Projects headers are sticky). Keep
the `▸`/`▾` glyph and the tap-to-collapse.

**FAB.** `h-14 w-14 rounded-full bg-accent shadow-lg`, white `+`, pinned
`right-4 bottom-4`. `size: 'md' | 'sm'` prop replaces the `className="h-12
w-12"` override in the bar (sm = `h-10 w-10`). Disabled: `opacity-40`.
Verify Uniwind's `shadow-*` renders on Android; if not, use `boxShadow` via a
`@utility` in `global.css`, never at a call site.

**Quick-add bar.** A full-width surface docked to the keyboard: `bg-surface
rounded-t-2xl p-4` with `borderCurve: 'continuous'` and a top shadow. Input
borderless, `body`, placeholder `--color-placeholder`. Submit is the `sm`
FAB, right-aligned; render it in the disabled look while the trimmed text is
empty (the empty-submit-closes-bar behavior stays as is). Helper text
(Projects) sits above the input in `caption`.

**Detail sheets (Capture edit, Project detail).** Sheet content is `@expo/ui`;
style through its `style` / `textStyle` props with values from
`useCSSVariable` only. Capture edit: input on `--color-surface-muted`,
`borderRadius 12`, 18/500 `--color-foreground`; Done button unchanged. Project
detail: the `Icon` / `Title` / `Notes` / `Status` labels in `caption` color
and size; inputs on `--color-surface-muted` with `borderRadius 12`; the Delete
button stays a plain `Pressable` in `text-danger`. Keep the existing `Column
spacing` values.

**Confirm dialog.** Material dialog proportions: `rounded-dialog p-6`, title
20/500, message `subtitle`, text buttons `button` right-aligned with `gap-6`,
overlay shadow, `bg-scrim`.

**Tab bar.** Pass tokens to `NativeTabs` via `useCSSVariable`:
`tintColor` = `--color-accent`, `backgroundColor` = `--color-surface`,
`iconColor` = `--color-foreground-secondary`, `labelStyle` from the caption
size, Android `indicatorColor` / `rippleColor`. These are JS props on the
already-compiled navigator; no rebuild.

**Empty and loading states.** Center the existing text vertically in the
list area, `subtitle`. No illustration.

**Sign-in.** Token classes only; layout unchanged.

**`app.json`.** `userInterfaceStyle: "light"`.

### Phase 3 — Verify and ship

- `pnpm --filter @zero/agent-mobile lint | typecheck | test` (run
  `jest --runInBand` on `mini`; stop Metro first).
- `pnpm --filter @zero/agent-mobile exec expo export --platform android
  --output-dir /tmp/x` compiles through Metro + Uniwind with the new config.
- On the Pixel: `expo start --clear` (config changed), run
  `.maestro/dev/screens.yaml`, compare against the phase 0 baseline; run
  `.maestro/release/*` via `run-release.sh` to prove the flows still pass.
- Self-critique pass (from `expo-design-system`): hierarchy, proximity,
  repetition, alignment. A failing check is fixed in `global.css` or a
  primitive, never in a screen.
- Changelog entry in `apps/agent-mobile/CHANGELOG.md`, same commit as phase 2.

## Strings that must not change

Tests and Maestro flows select by these; keep them byte-identical:
titles `Captures`, `Upcoming`, `Projects`; FAB labels `Capture`, `New project`;
placeholders `Capture a thought`, `Run a 5K under 30 min`; row labels
`Process "<text>"`, `Edit "<text>"`; `Dismiss quick add`; `Undo`; `Done`;
`Delete project`; dialog copy `Discard changes?`, `The changes you've made will
not be saved.`, `Cancel`, `Discard`; empty states `No captures yet. Capture
something.`, `No projects yet. Name your first outcome.`, `Nothing scheduled
ahead.`; loading `Loading your captures…`; `testID="capture-edit-input"`; the
mocked sheet's `accessibilityLabel="sheet"` in tests.

## Tests

- Existing suites pass unchanged in behavior. Where a test's comment explains a
  NativeWind constraint, rewrite the comment.
- Add `src/components/ui/__tests__/list-row.test.tsx`: renders leading / body /
  trailing slots, fires `onPress` and `onLongPress`, exposes the accessibility
  label; `CheckCircle` fires its handler and carries `Process "<text>"`.
- Add `src/components/__tests__/screen-header.test.tsx`: renders the title text.
- `fab.test.tsx`: cover `size` and the disabled look (accessibility state).
- No style-value assertions; the visual result is verified by screenshots.

## Docs

- `apps/agent-mobile/README.md` — rewrite "Styling and UI" and the "UI stack"
  subsection (Uniwind on Tailwind 4, `@theme` tokens in `global.css`,
  `useCSSVariable` for string-typed color props, the generated
  `uniwind-types.d.ts`, `withUniwindConfig` outermost, `--clear` after config
  changes, the `expo export` check).
- `docs/todo-app.md` — the "Mobile UI on NativeWind v4 + `@expo/ui`" sentence.
- `docs/plans/todo-capture-animations.md` — the babel config note.
- `apps/agent-mobile/CHANGELOG.md` — one user-facing bullet for phase 2
  (flat Todoist-style list, denser rows, keyboard-docked quick-add surface,
  circular add button, tab bar in the app's colors). Phase 0/1 are internal
  and get no entry.
- `jest.setup.js` comments — state the present.

## Skills to use

- `expo-overview` — load first; routes to the leaf skills and carries the
  shared setup rules (SDK 57 docs, `npx expo install` for dep changes).
- `expo-tailwind-setup` — Tailwind 4 `@theme` / `@variant` / platform
  media-query patterns; its NativeWind v5 + react-native-css wiring does not
  apply (Uniwind replaces that layer), so take the CSS conventions only.
- `expo-design-system` — token naming and scales, component contract
  (variant / size / state / `className` merged last), and the drift audit.
- `expo-native-ui` — styling rules: `boxShadow`, `borderCurve: 'continuous'`,
  pressed feedback on every tappable, safe-area handling, gap over margin.
- `expo-ui` — `@expo/ui` `style` / `textStyle` props on `Button`, `Text`,
  `TextInput`, `BottomSheet`.
- `impeccable` — the visual critique of the phase 2 screenshots (hierarchy,
  spacing, alignment) before calling it done.
- `testing` — the primitive tests at their interfaces; no style assertions.
- `changelog` — the phase 2 entry.
- `git-commit` — one commit per phase.

## Acceptance criteria

1. `rg -i nativewind` and `rg css-interop` in `apps/agent-mobile` return
   nothing; `nativewind`, `react-native-css-interop`, and `tailwindcss@3` are
   gone from `package.json` and the lockfile; `uniwind` and `tailwindcss@4`
   are present.
2. Every hex color, font size, spacing, radius, and shadow in `src/` resolves
   to `global.css` (`rg '#[0-9a-fA-F]{3,6}' src` and `rg 'fontSize:' src`
   return only commented one-offs; `@expo/ui` props read `useCSSVariable`).
3. Phase 1 screenshots match the phase 0 baseline.
4. Phase 2 screenshots show: flat rows with hairline dividers, 22dp check
   circles, 26pt bold screen titles under the safe area, circular accent FAB,
   keyboard-docked full-width quick-add surface with a borderless input,
   section headers with a divider, and tab bar tinted with the accent. Native
   chrome and content match in both system appearances.
5. `lint`, `typecheck`, `test`, and `expo export --platform android` pass;
   the two release Maestro flows pass on the Pixel.
6. Every string in "Strings that must not change" is unchanged.
7. README, `docs/todo-app.md`, the animations plan, and the mobile changelog
   are updated in the same commits as the code they describe.

## Risks and mitigations

- **Spike fails (jest, React Compiler, or `@expo/ui` bridge).** Fall back to
  the `StyleSheet` + `src/theme/` alternative in decision 1; phases 2–3 are
  unchanged in intent, only the token storage differs.
- **`uniwind-types.d.ts` missing in CI.** Metro generates it; commit it (or
  add a `uniwind generate-artifacts` step before `typecheck`) so `tsc` passes
  without a Metro run.
- **Swipe reveal bleeds behind flat rows.** The card used to be an opaque
  rounded surface over the "Tomorrow" layer. Give the row an explicit opaque
  `bg-background` and keep `overflow-hidden` on the wrapper; verify the
  reveal and the snap-back on device.
- **Drag-to-reorder look.** `react-native-reorderable-list` lifts the row; a
  flat row with a divider may need a raised shadow while active. Check on
  device; style it via a token class.
- **Sticky Projects headers.** Must stay opaque (`bg-background`) or rows
  scroll through them.
- **Shadows on Android.** Verify Uniwind's `shadow-*` output on the New
  Architecture; if it does not render, define a `boxShadow` `@utility` in
  `global.css`.
- **Metro cache.** Babel and Metro config change: start with `--clear` or the
  app red-boxes on stale transforms.
- **Free-tier limits.** No `className` animations and re-render on theme
  change; neither is used or needed. Uniwind Pro is commercial; do not adopt
  it without a separate decision.
- **Dark-mode phones (resolved 2026-09-05).** Matching light/dark tokens and
  `userInterfaceStyle: "automatic"` now keep the app and native chrome aligned;
  see `todo-dark-mode.md`.

## Completed follow-up

- Automatic light/dark appearance — shipped 2026-09-05; see
  `todo-dark-mode.md`.

## Follow-ups (out of scope here)

- Share one token CSS file between `apps/agent-web` and `apps/agent-mobile`
  (Uniwind converts the web's `oklch()` values).
- Upcoming rows edit inline while Captures rows open a sheet; unify on the
  sheet.
- Web app visual alignment (`apps/agent-web`), a separate plan.
- Haptics on swipe commit (needs `expo-haptics`, a native module → dev-client
  rebuild).
