# Investigation: styling and UI tech for the mobile todo app (2026-09-05)

Historical input to the mobile Todoist-alignment work. Question: which styling
and UI stack should `apps/agent-mobile` (Expo SDK 57, RN 0.86, React Compiler
on, Android-only today) use for the Todoist-alignment pass and after?

## Conclusion

Two viable stacks; both remove NativeWind v4.

1. **Uniwind (free tier) + Tailwind 4 + `@expo/ui`** — recommended, pending a
   one-hour spike (jest, React Compiler, `@expo/ui` bridging). Keeps the
   `className` workflow, upgrades to Tailwind 4 so the mobile theme can share
   the web app's `@theme` CSS token block, gives light/dark/custom themes
   without a provider, needs no Babel preset and no native module.
2. **Plain `StyleSheet` + `src/theme/` tokens + `@expo/ui`** — fallback and
   what Expo's default template and its `expo-native-ui` /
   `expo-design-system` skills prescribe. Zero dependencies, zero bundler
   config; dark mode and web token sharing are hand-rolled.

Keep `@expo/ui` for the native pieces already in use (BottomSheet, Button,
TextInput). Do not adopt a component kit for this pass.

## Findings

### Styling libraries

| Option | State (Sept 2026) | Native module? | Fit here |
|---|---|---|---|
| **NativeWind v4** (current) | 4.2.6 (June 2026); v5 stuck at `5.0.0-preview.4`, last nightly July; 68 open issues; community threads recommend moving off it | no | Babel JSX runtime complicates jest mocks; Tailwind 3 only; cannot style `@expo/ui` |
| **Uniwind** (Codemask, the Unistyles authors) | 1.12.0 released 2026-09-04, monthly releases, 4 open issues; listed in Expo's Tailwind guide next to NativeWind; official `expo/examples/with-router-uniwind` on SDK 57; HeroUI Native and React Native Reusables target it | no (free tier is Metro + JS; Expo Go compatible). Pro tier is a paid C++ engine (zero re-renders, Reanimated `className` animations, native theme transitions) and needs a dev client | Tailwind 4 `@theme` CSS = same token syntax as `apps/zero-web/src/index.css`; no Babel preset; `withUniwind` / `useResolveClassNames` / `Uniwind.getCSSVariable` bridge tokens into `@expo/ui` `style` / `textStyle`; `@variant dark` and custom themes without a ThemeProvider; `withUniwindConfig` must be the outermost Metro wrapper |
| **Unistyles 3** | 3.3.0; same authors, say Unistyles 4 is next | yes (`react-native-nitro-modules`) → dev-client rebuild | StyleSheet-flavored with themes and variants; no advantage over Uniwind for a Tailwind-literate repo |
| **Tamagui** | active, 14k stars | compiler + large surface | overkill for a 10-file app |
| **Plain StyleSheet + theme tokens** | Expo default template (`constants/theme.ts`, `ThemedText`), Expo skills' recommendation | no | simplest; `boxShadow`, `borderCurve`, `Pressable` style functions cover the needs; dark mode and token sharing are manual |

Community sentiment (r/reactnative, Jan–Apr 2026): Uniwind "easier to
install, maintain, update, and faster"; "lots of people moving projects over";
NativeWind "still the safer default" per one blog, mostly on ecosystem size.

### Native UI (`@expo/ui`)

- Stable since SDK 56 (SwiftUI and Jetpack Compose APIs, universal layer;
  web still experimental). SDK 57 universal set: `BottomSheet`, `Button`,
  `Checkbox`, `Collapsible`, `Column`, `FieldGroup`, `Host`, `Icon` (Material
  Symbol on Android via `@expo/material-symbols`), `List`/`ListItem`,
  `Picker`, `RNHostView`, `Row`, `ScrollView`, `Slider`, `Spacer`, `Switch`,
  `Text`, `TextInput`.
- `List` is still not lazily rendered; Expo's own docs recommend FlashList or
  Legend List for large lists. The Captures list stays on
  `react-native-reorderable-list` (a FlatList).
- `@expo/ui/jetpack-compose` also exposes Material 3 `FloatingActionButton`,
  `Snackbar`, `AlertDialog`, `Divider`, `ListItem`, `Surface`, and the
  Material color palette. An Android-only app could build its chrome from
  these, but it would read as Material/Google rather than Todoist, each first
  use needs a dev-client rebuild, and mixing Compose views with the
  gesture-driven RN list is untested here. Not for this pass.
- `Color` from `expo-router` (typed `PlatformColor`) cannot feed `@expo/ui`
  (`textStyle.color` is `string`), so the palette must be plain strings.

### Component kits

| Kit | State | Notes |
|---|---|---|
| **HeroUI Native** | 1.0.9 (Aug 2026), Uniwind + Tailwind 4, 3.6k stars, 7 open issues | Full kit (Button, Checkbox, TextField, BottomSheet, Dialog, Toast, ListGroup…). Peer deps include `@gorhom/bottom-sheet`, `react-native-svg`, `expo-blur` → rebuild. Brings its own design language. |
| **React Native Reusables** | CLI 0.7.1, shadcn port on NativeWind or Uniwind, 8.6k stars | Copy-paste components on `@rn-primitives`; matches the web's shadcn vocabulary. |
| **gluestack v3 / RN Paper** | active | Universal / Material 3 kits; not aligned with a Todoist look. |

None needed for "no new elements". If a kit is wanted later, Reusables
matches the web app's shadcn conventions; HeroUI is the more polished default.

### Uniwind details that matter for the plan

- Install: `uniwind` + `tailwindcss@4`; `global.css` with `@import
  'tailwindcss'; @import 'uniwind';`; `withUniwindConfig(config, {
  cssEntryFile, dtsFile })` outermost in `metro.config.js`; import the CSS in
  the root layout (never in the entry file). No `babel.config.js` changes
  beyond removing NativeWind's preset (the worklets plugin stays).
- Theming: `@theme` in CSS; `@variant dark { … }` and named extra themes;
  `useUniwind()` for the active theme; `useCSSVariable` / `Uniwind.getCSSVariable`
  for reading tokens as strings (what `@expo/ui` needs); `useResolveClassNames`
  to turn a class string into a style object for third-party `style` props.
- Free tier: theme changes re-render (fine at this size); Reanimated must use
  `style`, not `className` (already the case in the swipe row and quick-add).
- Unknowns to spike: (1) jest — `className` should be inert without Metro, so
  tests keep passing without a mock; confirm. (2) React Compiler — no
  documented conflict; confirm on the Captures screen. (3) Generated
  `uniwind-types.d.ts` needs Metro to run once; decide where it lives and
  whether it is committed. (4) `expo export --platform android` as the CI
  bundle check.

## Open questions

- Share one token CSS file between `apps/zero-web` and `apps/agent-mobile`
  (e.g. `packages/ui/tokens.css` imported by both `@theme` blocks)? Uniwind
  makes it possible; the web uses `oklch()` values, which Uniwind converts
  (it depends on `culori`). Worth a follow-up, not this pass.
- Dark mode: with Uniwind it is a `@variant dark` block plus dropping the
  `userInterfaceStyle: light` pin; with plain StyleSheet it is a second
  palette and a `useTheme()` hook. Either way it is a follow-up.
- Uniwind Pro is commercial; the free tier is MIT and sufficient. Note the
  vendor's incentive to keep some features Pro-only.

## Sources

- Expo Tailwind guide: https://docs.expo.dev/guides/tailwind (names NativeWind and Uniwind)
- Expo example: https://github.com/expo/examples/tree/master/with-router-uniwind (SDK 57)
- Expo UI stable (SDK 56): https://expo.dev/blog/expo-ui-stable-sdk-56; SDK 57 universal list: https://docs.expo.dev/versions/v57.0.0/sdk/ui/universal
- Uniwind docs: https://docs.uniwind.dev (quickstart, migration from NativeWind, pro-version, third-party components, get-css-variable)
- Uniwind announcement: https://reactnativecrossroads.com/posts/introducing-uniwind-the-fastest-tailwind-bindings-for-react-native
- npm: `uniwind` 1.12.0 (2026-09-04); `nativewind` latest 4.2.6, preview 5.0.0-preview.4; `react-native-unistyles` 3.3.0; `heroui-native` 1.0.9
- GitHub (2026-09-05): uni-stack/uniwind 1.7k★ 4 issues; nativewind 8.1k★ 68 issues; heroui-native 3.6k★; react-native-reusables 8.6k★
- Reddit r/reactnative threads: "What's your go-to Tailwind package" (Jan 2026), "Is NativeWind worth it in 2026" (Apr 2026), "Tamagui vs Tailwind/UniWind" (Feb 2026)
