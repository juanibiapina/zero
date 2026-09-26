# @zero/agent-mobile — Zero Agent

Expo (React Native) app for Zero, built and distributed with **EAS Build** so no
Android Studio or Android SDK is needed locally or in CI. Native compilation runs
on Expo's servers; you only need Node and an Expo account.

## Identifiers

| Field             | Value                         |
| ----------------- | ----------------------------- |
| Display name      | `Zero Agent`                  |
| Package (npm)     | `@zero/agent-mobile`                |
| Expo slug         | `zero-agent`                  |
| Android package   | `dev.juanibiapina.zeroagent`  |
| Expo SDK          | 57 (React Native 0.86, React 19.2) |

## Prerequisites

- Node (repo `.nvmrc`, Node 22 LTS) and pnpm 10.21 (`pnpm install` at the repo root).
- A free [Expo account](https://expo.dev) and the EAS CLI: `pnpm dlx eas-cli`
  (or `npm i -g eas-cli`). Run `eas login` once.
- One-time project link: `eas init` from `apps/agent-mobile` (writes the EAS project id
  into `app.json`). Requires being logged in.

## Toolchain notes (divergence from the shared configs)

Expo's presets are used instead of the repo-shared configs, and are pinned
locally (pnpm isolated installs keep them scoped to this app):

- **ESLint**: `eslint-config-expo` (flat config in `eslint.config.js`), not
  `@zero/eslint-config`. Pinned to **eslint 9** here because
  `eslint-plugin-react` (pulled in by `eslint-config-expo`) does not yet run on
  the repo's eslint 10.
- **TypeScript**: extends `expo/tsconfig.base`, not `@zero/typescript-config`.

## Styling and UI

The app styles with **Uniwind** (Tailwind CSS **v4** for React Native), the same
Tailwind vocabulary as the web packages (`agent-web`, `dashboard-web`,
`landing`). You write `className="..."` on React Native components; Uniwind maps
it to styles through a Metro transform (no Babel preset).

- **Design tokens live in `global.css`.** Static `@theme` values own spacing,
  type, and radius; matching `@variant light` / `@variant dark` blocks own every
  semantic color and elevation (`--color-foreground`, `--color-accent`,
  `--shadow-raised`, `--text-title`, `--spacing-screen-x`, `--radius-dialog`,
  …). The app follows only the phone's system preference: no theme toggle or
  stored override. React Native reads them as classes (`bg-surface`,
  `text-foreground`, `text-title`, `px-screen-x`). No hex, font size, or spacing
  literal lives in a screen — change the token, not the screen.
- **String-typed color props read the token, not a class.** `@expo/ui`
  (`style`/`textStyle`), `NativeTabs` colors, and `android_ripple` take a color
  string, not a `className`. Read a semantic token with
  `useColor('--color-...')` from `src/lib/theme.ts` (a typed wrapper over
  Uniwind's `useCSSVariable`). A runtime-only adaptive token must be used by a
  class or declared in `@theme static`; `ListRow` contains a hidden
  `bg-ripple` consumer so its Android-only ripple token remains available.
  `TextInput` has `placeholderTextColorClassName`, so inputs use
  `text-placeholder` directly.
  Animated.View and `KeyboardStickyView` are not RN-core, so Uniwind does not
  map `className` onto them — use `useResolveClassNames(...)` (a resolved style)
  or an inline style there.
- **Config files**: `metro.config.js` (`withUniwindConfig`, **outermost** wrapper,
  `cssEntryFile: './global.css'`, generates `src/uniwind-types.d.ts`),
  `babel.config.js` (Expo preset + the reanimated worklets plugin only — no
  styling preset), `global.css` (`@import 'tailwindcss'; @import 'uniwind';` plus
  the `@theme` tokens, imported once in `src/app/_layout.tsx`),
  `src/uniwind-types.d.ts` (generated `className`/theme typings; committed so
  `typecheck` needs no Metro run — regenerate with `pnpm run uniwind:types`).
- **No native module**: Uniwind (free tier) is a Metro transform + JS runtime
  and adds no native code, so changing styles never needs an EAS rebuild — only
  `expo start --clear` after a config change.
- **Components**: shared UI lives in `src/components/ui/` (`Text`, `Input`, `Fab`,
  `CheckCircle`, `ListRow`, `ConfirmDialog`, `Sheet`) plus `ScreenHeader`,
  composed with the `cn()` helper in `src/lib/cn.ts` (clsx + tailwind-merge).
  `ListRow`/`CheckCircle` are the flat list-row shape used by Home, Projects,
  and Upcoming (now reached through the rightmost Browse tab).
- **System appearance is automatic.** `userInterfaceStyle` is `automatic` in
  `app.json`; Uniwind's light/dark variants update content, tabs, string color
  props, status icons, and native chrome together. This configuration is native:
  a fresh `development` dev-client build is required before device testing.
  Pure CSS/JS token changes then hot-reload normally.

### UI stack: `@expo/ui` vs Uniwind vs FlatList

Follow the `expo-ui` skill: reach for native `@expo/ui` controls first, and fall
back only where the native component does not fit.

- **Native controls -> `@expo/ui`.** The sign-in buttons use `<Button>` from
  `@expo/ui` (wrapped in `<Host>`; Jetpack Compose on Android). Prefer it over a
  hand-rolled Pressable for future buttons, switches, sliders, menus, and grouped
  form sections. `@expo/ui` is a **native module**: its views must be compiled
  into the installed dev client. The **first** use of any `@expo/ui` component
  needs a **new EAS dev build** (the sign-in Button first shipped in build 14) —
  JS hot-reload alone crashes on render on an older client that lacks the native
  view (same hazard as the Clerk `UserButton`). Once the module is in the client,
  further JS changes hot-reload normally.
- **The Captures list -> `FlatList`, never `@expo/ui` `List`.** `@expo/ui` `List` is
  native but **not virtualized**; Captures is unbounded, so it uses a reanimated
  `Animated.FlatList` (virtualized, with row fade + layout animation).
- **Kept custom on purpose.** The keyboard-attached quick-add bar
  (`KeyboardStickyView` + reanimated) and the in-tree `ConfirmDialog` stay
  hand-rolled: `@expo/ui` has no keyboard-attached quick-add primitive, and the
  only native dialog (RN `Alert`) dismisses the keyboard, which would regress the
  rapid-capture discard flow. The `Fab` is a floating circular button, not a
  native `Button` shape.
- **Verify a bundle without a device**: `pnpm exec expo export --platform android
  --output-dir /tmp/x` compiles through Metro + Babel + Uniwind and surfaces
  styling/bundle wiring errors that typecheck alone misses.

## Brand assets

Two approved layered square sources own the app's white/graphite identity:

- `assets/brand/todo-icon.svg` is the source for Android's primary APK icon and
  the static iOS, touch, splash, and web adapters.
- `assets/brand/task-count/template.svg` plus the state definitions in
  `bin/generate-todo-icons` own Android's launcher family. A checkmark represents
  an empty Home; one to three tasks show that many rows; four or more show four.

Both sources use a full-bleed white square and a separate artwork group. They do
not draw circular or rounded launcher masks. `bin/generate-todo-icons` publishes
the opaque composite for Android's primary legacy icon, iOS, and Apple touch;
removes the background and enlarges the artwork to about 90% of the canvas for
browser and Expo web favicons; removes the background at its authored scale for
the splash; and scales static and task-count Android foregrounds into the
adaptive safe zone.
Android and iOS apply their own launcher masks. The mobile
`assets/images/favicon.png` file is an Expo web asset, not a native launcher
input.

Run the generator from the repository root (Python 3, ImageMagick 7, and DejaVu
Sans) to regenerate the mobile PNGs, state SVGs, comparison sheet, and
`apps/agent-web/public` favicons. It validates dimensions, full-bleed corners,
transparency, neutral pixels, Android's safe zone, and deterministic output. Do
not edit generated PNGs, state SVGs, comparison image, or web copy independently.

Android's primary APK and pre-hydration launcher icon is the static three-row
mark. Five native activity aliases provide the hydrated Home-count states — the
empty checkmark plus one to four rows — with transparent foregrounds over white
and matching monochrome silhouettes. The local `home-app-icon` native module
leaves `MainActivity` enabled for Expo dev-client launches, the app scheme, and
Clerk's hosted callback; only its six aliases carry the launcher filter. The app
derives the state from the same hydrated `homeTasks` list Home renders, queues
only a changed count bucket, and applies it when the app enters the background.
Signed-out state restores the three-row default. Remote or date-based changes
made while the process is stopped appear after the next app sync and background
transition. iOS, the splash mark, the tab icon, and web remain static.

Launcher and splash changes require a new native build. Application UI colors
are independent of these assets. The EAS archive rules exclude generated
`android/` and `ios/` directories so prebuild always applies `app.json`. A stale
git-ignored native project otherwise silently overrides icon configuration. For
the attached Pixel, use the `development-pixel` profile: it inherits the
development client and builds only ARM64. The regular development and preview
profiles retain all architectures.

## Authentication and environment

The app signs in with **Clerk**, against the **same Clerk instance as the web
app**, so a user has one account across web and mobile. Sign-in is now the entry
screen: signed-out users see "Continue with Google" (Google OAuth via Clerk's
`useSSO`); after signing in they reach the home screen. The Clerk session is
persisted in `expo-secure-store`, so it survives app restarts. The root provider
also enables Clerk's `resourceCache` (`__experimental_resourceCache`), backed by
SecureStore, so a previously signed-in user can cold-start offline. Token caching
alone is not enough: Clerk also needs its cached client and environment resources.
First sign-in still requires a connection.

The Clerk SDK is **`@clerk/expo` v4 (Core 3)**. The old `@clerk/clerk-expo`
(Core 2) is deprecated. Google sign-in goes through `useSSO` (a Custom Tab +
`sso-callback` deep link), **not** the native `useSignInWithGoogle`, so the
optional `@clerk/expo-google-signin` package and its config plugin are not
needed. Core 3 also exposes native components under `@clerk/expo/native`.

The home header uses one of these: `<UserButton />` from `@clerk/expo/native` —
a circular avatar that opens the native profile (manage account, security, sign
out). It renders a real native view (Jetpack Compose on Android) and is **Beta**,
so expect occasional API changes. Two consequences:

- The `@clerk/expo` **config plugin** is now in `app.json` (`["@clerk/expo",
  { "appleSignIn": false }]`; Apple sign-in off since the app is Android-only).
  It autolinks the native module and adds Android packaging tweaks. Because it is
  a native module, it needs a **new EAS dev build** to run on the phone — a JS
  hot-reload alone will not add it.
- Do **not** hot-reload the `UserButton` JS onto an older dev client that lacks
  the native view: it resolves `requireNativeView('ClerkUserButtonView')` and the
  home screen crashes. Rebuild the dev client first, then reload JS as usual.

To theme the native surface toward the app's brand later, pass a `theme` JSON
path to the plugin (see Clerk's "Theming Expo native components").

Environment variables (Expo inlines `EXPO_PUBLIC_*` at build time):

| Variable                            | Required | Default                          | Purpose                                             |
| ----------------------------------- | -------- | -------------------------------- | --------------------------------------------------- |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes      | —                               | Clerk publishable key (same value the web app uses) |
| `EXPO_PUBLIC_API_URL`               | no       | `https://zero.juanibiapina.dev` | Base URL for normal authenticated `/api/*` calls    |
| `EXPO_PUBLIC_HERMETIC_E2E`          | no       | —                               | Selects the complete local E2E runtime profile      |

The Clerk **publishable** key is public by design (`pk_...`, already shipped in
the web bundle). The `preview` profile reads it from the EAS `preview`
environment. Other build profiles keep it in their `eas.json` `env` block. For
local `expo start`, export the same value or put it in
`apps/agent-mobile/.env.local` (gitignored):

```bash
export EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
```

### Clerk dashboard: native OAuth setup (required)

Native sign-in needs two one-time settings in the Clerk dashboard, under
**Configure → Native applications** (production instance):

1. **Enable Native API** — toggle it on and click **Save** in the "Unsaved
   changes" bar. `@clerk/expo` fails to initialise without it (the app
   hangs on a loading spinner, and the Frontend API returns
   `native_api_disabled`).
2. **Allowlist the SSO redirects** — add both `zeroagent://` and
   `zeroagent://sso-callback` to "Allowlist for mobile SSO redirect". The app
   uses the `sso-callback` path; the app scheme is set in `app.json`.

After OAuth, Clerk's Custom Tab redirects to `zeroagent://sso-callback`. Android
delivers that to expo-router as a deep link, so the app has an `sso-callback`
route (`src/app/sso-callback.tsx`) that bounces to `/` and lets the auth gate
route to home. Without it the app lands on a dead route after sign-in.

## Develop / test loop (no Android Studio)

1. Build a **development build** (dev client) once on EAS and install it on your
   phone (see below).
2. Iterate on JS with hot reload:
   ```bash
   pnpm --filter @zero/agent-mobile exec expo start
   ```
   Scan the QR with the installed dev client; saves hot-reload over wifi.
3. Only rebuild on EAS when **native** code/modules change (e.g. adding
   `expo-location`). Pure-JS changes never need a rebuild.

After a fresh install, clear the Metro cache once:
`pnpm --filter @zero/agent-mobile exec expo start --clear`.

The app uses the **default** `expo/metro-config` — no custom monorepo Metro
config is needed (SDK 52+ auto-detects the workspace, SDK 54+ supports pnpm
isolated installs).

**NixOS dev box:** `expo start` crashes on this machine while auto-installing the
React Native DevTools binary (`NixOS cannot run dynamically linked executables`,
exit 127). Start it headless to skip that step:
`EXPO_UNSTABLE_HEADLESS=1 pnpm --filter @zero/agent-mobile exec expo start`.
Headless prints no QR, so connect the dev client by entering the URL manually
(`exp://<LAN-IP>:8081`). After a dependency upgrade, also pass `--clear`, or Metro
serves a stale transform cache and the app red-boxes with a native/JS mismatch
(e.g. `Cannot read property 'EventEmitter' of undefined`) — which also means the
installed dev client must be rebuilt (new versionCode) to match bumped native
modules.

## Checks

Joins the root Turbo pipeline (`turbo run lint | typecheck | test`). It defines
no `build` script, so it is excluded from `turbo run build` and the web/api
deploy path.

```bash
pnpm --filter @zero/agent-mobile lint
pnpm --filter @zero/agent-mobile typecheck
pnpm --filter @zero/agent-mobile test
```

Mobile Jest hides `console.*` output by default. Enable it for one diagnostic
run without changing the shared configuration:

```bash
pnpm --filter @zero/agent-mobile exec jest --runInBand --silent=false <test>
```

### Run checks on a starved box (the `mini` host)

The `mini` dev host has 2 CPUs and 7.6 GB RAM. These checks are cheap in
isolation (typecheck and test each finish in under 10 seconds), but they slow
down 10-50x when they compete for memory and the box swaps. A measured
`tsc --noEmit` that takes 7 seconds idle took 320-355 seconds while Metro,
`jest`, and a gradle JVM ran alongside it; a plain `git checkout` took 5 minutes
in the same window. The checks are not slow, the box is out of memory.

Before running checks on `mini`:

1. **Stop Metro first.** `expo start` is persistent and holds 1-2 GB for the
   whole session. Kill it, run the checks, then restart it.
2. **Do not run a local build next to checks.** A local `gradlew` or
   `eas build --local` starts a JVM that alone takes 1.5 GB resident. Prefer an
   EAS cloud build (see [Builds](#builds)), which keeps the box's memory free.
3. **Lower parallelism on 2 cores.** Run `jest --runInBand` (or
   `--maxWorkers=1`) and, when running the whole pipeline, `turbo ...
   --concurrency=1`. The defaults fan out one worker per core, and each React
   Native transform is memory-heavy.

## End-to-end tests (Pixel + Maestro)

The default behavioral proof runs the current checkout on the attached Pixel 7:

```bash
pnpm --filter @zero/agent-mobile e2e:pixel
```

The Pixel must have the existing development client installed, be USB-connected,
and appear as `model:Pixel_7` in `adb devices -l`. Rootless Podman and Maestro
must be available. The command refuses a missing or non-debuggable app and never
installs an APK.

`run-metro-e2e.sh` owns the full run:

1. It records checksums for the production collection and outbox files.
2. It starts a fresh local Worker in Podman on port 8787.
3. It starts headless Metro on port 8082 with
   `EXPO_PUBLIC_HERMETIC_E2E=1` and opens the development client through USB.
4. It runs the four non-fixture behavior flows in `.maestro/hermetic/` once each; the
   selector flow creates and completes its own throwaway Project and Task.
5. It requires `E2E loose task` in the UI before and after restart, proves a
   Project description survives Back and reopening, checks Backlog assignment
   and moving the Task back to loose, then requires exactly that Task and
   described Project through the Worker's authenticated HTTP interface.
6. It saves both Worker responses with the run artifacts.
7. It verifies production file checksums, launcher alias state, and installed
   package identity.
8. It removes E2E files, reverse ports, containers, and child processes.

The one hermetic toggle selects fake Clerk modules, the fixed
`http://localhost:8787` origin, separate SQLite and AsyncStorage names, disabled
launcher-count synchronization, disabled EAS Update, and E2E cleartext policy.
It also aliases Clerk's token cache and resource cache to inert local fakes.
Normal Metro startup restores real Clerk, normal URL selection, production
storage names, EAS Update, and launcher synchronization.

To run the extended TinyBase persistence proof, use
`E2E_TASKDO_PROOF=1 pnpm --filter @zero/agent-mobile e2e:pixel`. The three
additional flows prove loose-Task offline restart and REST sync, then Project
and linked-Task offline restart and Worker REST sync. Every signed-in account
uses one account-scoped TinyBase SQLite file under Expo's `files/SQLite/`.
The historical filename prefix remains `taskdo-fixture-` so an installed app
continues opening the already-migrated file. The harness cleans only its test
account's file. Home lists raw conflicts and offers safe local repairs for
missing Project links, invalid recurrence, and invalid After relationships.

| State | Normal | Hermetic E2E |
| --- | --- | --- |
| Todo replica | `taskdo-fixture-<account-id>.sqlite` | `taskdo-fixture-taskdo-proof-mobile.sqlite` |
| Timezone key | `zero.timezone.synced` | `zero.e2e.timezone.synced` |
| Icon-suggestion key | `zero.icon-suggestions.v1` | `zero.e2e.icon-suggestions.v1` |

A successful run prints one `PASS` line with a flow count derived from the
hermetic YAML files. A failed run prints the failed stage, the artifact
directory, the JUnit summary, and a relevant log tail. The artifact
directory retains Metro, Worker, Maestro, logcat, screenshot, and UI hierarchy
evidence. Set `E2E_VERBOSE=1` for a diagnostic rerun.

For later behavior changes, keep pure state rules in Jest and add or update a
behavior-named flow in `.maestro/hermetic/` when native rendering, persistence,
gestures, routing, or screen composition matters. Use manual inspection only
for visual, auditory, tactile, accessibility-judgment, or otherwise
non-assertable acceptance criteria.

Two manual emulator workflows remain separate:

- **Mobile E2E** runs `.maestro/ci/` against real Clerk to check signed-out
  initialization and OAuth redirect handling. These flows clear app state.
- **Mobile Release E2E** builds the standalone hermetic APK and runs the same
  `.maestro/hermetic/` behavior through `run-release-emulator.sh` against a
  runner-local Worker. It is optional and never runs on push or pull request.

Both workflows upload screenshots, logcat, and UI hierarchies. The local dev box
has no KVM, so emulator execution stays in GitHub Actions.

## Physical device testing (Pixel 7 on `mini`)

A real **Pixel 7** (`adb` serial shown as model `Pixel_7`, device `panther`) is
USB-attached to the `mini` host and available for on-device testing. It is set
up **declaratively in `juanibiapina/dotfiles`**, not by hand:

- `nix/hosts/mini/modules/android.nix` installs `android-tools` (adb), `scrcpy`,
  and **`maestro`** (from nixpkgs; it bundles its own JRE, no separate JDK), plus
  a udev rule + `adbusers` group so the headless `juan` user can reach the device
  over USB.
- `nix/modules/homemanager/android.nix` ships the shared adb key (via agenix) so
  `mini` presents the same identity the phone already authorized ("Always allow
  from this computer"), surviving reboots.

Confirm it is connected: `adb devices` should list the `Pixel_7`. Wake it with
`adb shell input keyevent KEYCODE_WAKEUP` (screen lock is off on this test
device).

> **This device is dev-client-only. It always runs the `development` (dev
> client) build and NEVER a `preview`/`production` build.** A dev client loads
> JS from Metro, so pure-JS changes hot-reload over `adb reverse` — that is this
> device's whole job. A `preview`/`production` build is **standalone**: its JS is
> baked into the APK and it ignores Metro entirely, so installing one here
> silently kills all unreleased-JS testing (the app just keeps running its
> embedded bundle, which looks exactly like "stuck on old code"). If a non-dev
> build ever lands on it, reinstall the dev client:
> `eas build -p android --profile development` (or the local build below) →
> `adb install`. Validate `preview`/`production` (standalone) builds off this
> device — see [Builds](#builds).

### Drive it with the Maestro CLI (element-based — preferred)

Prefer Maestro over raw `adb input tap`: it selects by on-screen element and
auto-waits/retries, so it does not fight coordinate math, screen-doze, or dev
overlays (a stray React Native LogBox banner silently ate `adb` taps on the FAB).

```bash
maestro --no-ansi hierarchy --compact                 # dump compact CSV for the current screen
maestro --no-ansi test apps/agent-mobile/.maestro/<flow>.yaml   # run a saved flow
maestro studio                                        # interactive: inspect the live screen, author taps
```

A flow is declarative and element-based, e.g.:

```yaml
appId: dev.juanibiapina.zeroagent
---
- launchApp
- assertVisible: "Home"
- takeScreenshot: home     # RELATIVE name only; absolute paths are rejected
```

`takeScreenshot` writes under the run folder
(`~/.maestro/tests/<timestamp>/.../<name>.png`), not an arbitrary path.

**Take a screenshot and send it whenever it is relevant.** On-device
verification is visual: after a change lands on the Pixel, capture the screen
(`maestro` `takeScreenshot`, or `adb exec-out screencap -p > shot.png`) and send
the image back — show the new UI, the before/after of a fix, or the state that
proves the bug is gone. A description of what you saw is not the same as showing
it; a screenshot is the proof the reviewer can check. Default to sending one for
any user-visible change; skip it only when the change has no visible surface.

Do not run `.maestro/ci/` on the Pixel: those flows clear app state and remove
the real Clerk session. Use `e2e:pixel` for signed-in behavior. Use the manual
Metro loop below only for visual or otherwise non-assertable inspection, and do
not mutate existing production entities.

### Test unreleased local JS on the device (dev client + Metro over USB)

The installed **dev client** loads JS from Metro on `mini` over the USB bridge:

```bash
adb reverse tcp:8081 tcp:8081                                  # phone localhost:8081 -> mini
EXPO_UNSTABLE_HEADLESS=1 pnpm --filter @zero/agent-mobile exec expo start   # headless (NixOS)
adb shell am start -a android.intent.action.VIEW \
  -d "zeroagent://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" \
  dev.juanibiapina.zeroagent                                  # launch pointed at Metro
```

Pure-JS changes hot-reload; only new native modules need a fresh EAS dev build.

### Verify system appearance

`userInterfaceStyle` changes native configuration, so first install a fresh
**development** dev-client build. With Metro running, switch the attached Pixel
and capture each appearance:

```bash
adb shell cmd uimode night yes
maestro --no-ansi test apps/agent-mobile/.maestro/dev/screens.yaml
adb shell cmd uimode night no
```

While the app stays open, switch `yes`, `no`, then `yes`: content, NativeTabs,
status icons, keyboard, and native sheets must update together. Restore `night
no` when finished. Use only this development client; never install a preview or
production build on the Pixel.

## Builds

From `apps/agent-mobile`:

```bash
# Dev client (install once, then hot-reload JS from `expo start`)
eas build -p android --profile development

# Installable standalone APK (internal distribution)
eas build -p android --profile preview
```

`eas.json` sets `appVersionSource: remote` (EAS manages `versionCode`) and pins
`node`/`pnpm` per profile to avoid EAS corepack/pnpm-detection issues. The
`preview` profile produces a sideloadable **APK** (not an AAB); `production`
produces an AAB for the Play Store (defined but unused for now). The `preview`
build (a **distributable artifact**) is not sideloaded onto the mini Pixel, which
stays on the dev client (see the callout under Physical device testing).

Routine JavaScript and asset releases use EAS Update after CI passes. Native
fingerprint changes require a new preview APK. The complete release procedure is
in **[Mobile releases](../../docs/mobile-releases.md)**.

Native builds run **locally on `mini`** by default (next section). Use the cloud
(EAS) build path only when the user asks for it.

### Local builds on the `mini` NixOS box (no EAS quota)

Build the **dev client** APK **locally on `mini`** and install it on the Pixel
(this device is dev-client-only — see the callout above). Use a Nix dev shell that
ships the Android toolchain for Expo SDK 57 / React Native 0.86 (SDK platform 36,
build-tools 36.0.0, React Native NDK 27.1.12297006, Android Gradle Plugin default
NDK 27.0.12077973, cmake 3.22.1, JDK 17). The shell lives in
`juanibiapina/dotfiles` (`nix/shells/android.nix`, exposed as the flake output
`devShells.x86_64-linux.android`) — it is a dev shell, so it needs **no**
`nixos-rebuild` / system change.

The one NixOS-specific fix it applies: gradle otherwise downloads an `aapt2`
binary that cannot run on NixOS, so `GRADLE_OPTS` points the Android Gradle
Plugin at the Nix-store `aapt2` instead (the canonical fix from the nixpkgs
manual). `ANDROID_HOME`/`ANDROID_SDK_ROOT`/`ANDROID_NDK_ROOT`/`JAVA_HOME` are set
by the shell.

`eas-cli` is **not installed** (no global, not a repo dependency). Invoke it with
`pnpm dlx eas-cli@latest` — inside the Nix shell `pnpm`/`node` stay on `PATH` from
the outer environment. It authenticates from the existing Expo session in
`~/.expo/state.json` (no `EXPO_TOKEN` needed on this box); `eas whoami` should
print `juanibiapina@gmail.com`.

```bash
# from the zero repo root, on mini — builds the DEV CLIENT for this device
export NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1
nix develop ~/workspace/juanibiapina/dotfiles#android --command bash -c '
  cd apps/agent-mobile
  pnpm dlx eas-cli@latest build --platform android --profile development --local \
    --non-interactive --output /tmp/local-devclient.apk
'
adb install -r -d /tmp/local-devclient.apk
```

Do **not** build `--profile preview`/`production` and `adb install` it here — a
standalone build breaks hot-reload on this device (see the callout above). A
standalone **preview** APK is a distributable artifact. Build it locally and
publish it to Google Drive. Never sideload it onto the mini Pixel. The native
release path lives in **[Mobile releases](../../docs/mobile-releases.md)**.

Notes on local builds:
- `eas build --local` still fetches the signing keystore from EAS ("Using remote
  Android credentials"), so the local APK installs over the existing app with no
  uninstall. It runs the same prebuild + gradle steps as the cloud, just on this
  box in the Nix shell.
- The first build is slow (gradle ~20 min: it compiles op-sqlite, reanimated,
  worklets and expo-modules-core native for all four ABIs). Later builds reuse
  the gradle/pnpm caches.
- The SDK/NDK download on the first `nix develop` is multi-GB and cached in the
  Nix store afterwards.
- Plain `pnpm`/`node` from the outer environment stay on `PATH` inside the shell,
  so the repo's package manager is used as usual.

## Releases (EAS Update and preview APK)

Routine JavaScript and asset releases publish to the EAS `preview` channel after
green `main` CI. Native fingerprint changes use a locally built preview APK and
the dedicated Drive folder. Both paths live in
**[Mobile releases](../../docs/mobile-releases.md)**.

The manual `mobile-build` CI job creates a cloud preview APK only through
`workflow_dispatch`. The automatic `mobile-update` job publishes compatible
Android updates after relevant `main` pushes. Both jobs use the `EXPO_TOKEN`
secret.

The `lint` / `typecheck` / `test` jobs still run on every push and PR and include
this app through Turbo.
