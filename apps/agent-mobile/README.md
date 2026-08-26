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

The app styles with **NativeWind v4** (Tailwind for React Native), matching the
web packages (`agent-web`, `dashboard-web`, `landing`), which use Tailwind +
shadcn. You write `className="..."` on React Native components.

- **Tailwind version**: NativeWind v4 pairs with **Tailwind CSS v3**, so this app
  pins its own `tailwindcss@3` devDep, separate from the web packages on
  Tailwind 4. NativeWind v5 (Tailwind 4) is still preview — do not adopt it here.
- **Config files**: `babel.config.js` (NativeWind JSX runtime + preset),
  `metro.config.js` (`withNativeWind`, CSS entry `./global.css`),
  `tailwind.config.js` (design tokens live in `theme.extend`), `global.css`
  (Tailwind directives, imported once in `src/app/_layout.tsx`),
  `nativewind-env.d.ts` (types for `className` + the CSS side-effect import).
- **pnpm note**: `react-native-css-interop` (NativeWind's engine) is listed as a
  direct dependency so Metro can resolve it under pnpm's strict `node_modules`.
  Without it, bundling fails with `Unable to resolve module
  react-native-css-interop/jsx-runtime`.
- **No native module**: NativeWind adds no native code, so changing styles never
  needs an EAS rebuild — only `expo start --clear`.
- **Components**: shared UI lives in `src/components/ui/` (e.g. `Button`,
  `Text`), composed with the `cn()` helper in `src/lib/cn.ts` (clsx +
  tailwind-merge), the same pattern as the web shadcn components.
- **Verify a bundle without a device**: `pnpm exec expo export --platform android
  --output-dir /tmp/x` compiles through Metro + Babel and surfaces NativeWind
  wiring errors that typecheck alone misses.

## Authentication and environment

The app signs in with **Clerk**, against the **same Clerk instance as the web
app**, so a user has one account across web and mobile. Sign-in is now the entry
screen: signed-out users see "Continue with Google" (Google OAuth via Clerk's
`useSSO`); after signing in they reach the home screen. The Clerk session is
persisted in `expo-secure-store`, so it survives app restarts.

The Clerk SDK is **`@clerk/expo` v4 (Core 3)**. The old `@clerk/clerk-expo`
(Core 2) is deprecated. Google sign-in goes through `useSSO` (a Custom Tab +
`sso-callback` deep link), **not** the native `useSignInWithGoogle`, so the
optional `@clerk/expo-google-signin` package and its config plugin are not
needed. Core 3 also exposes native components under `@clerk/expo/native`.

Environment variables (Expo inlines `EXPO_PUBLIC_*` at build time):

| Variable                            | Required | Default                          | Purpose                                             |
| ----------------------------------- | -------- | -------------------------------- | --------------------------------------------------- |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes      | —                                | Clerk publishable key (same value the web app uses) |
| `EXPO_PUBLIC_API_URL`               | no       | `https://zero.juanibiapina.dev`  | Base URL for authenticated `/api/*` calls           |

The Clerk **publishable** key is public by design (`pk_...`, already shipped in
the web bundle), so it is committed in the `env` block of every `eas.json` build
profile — it is **not** an EAS Secret. For local `expo start`, export the same
value in your shell or put it in `apps/agent-mobile/.env.local` (gitignored):

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

## End-to-end tests (emulator + Maestro)

Automated UI tests run a real APK on an Android emulator and drive it with
[Maestro](https://maestro.mobile.dev). They live in `apps/agent-mobile/.maestro/` and
run in CI via the **Mobile E2E** workflow (`.github/workflows/mobile-e2e.yml`),
because the local dev box has no KVM to run an emulator.

The workflow has two jobs:

- **Build APK** — `expo prebuild` + `gradlew assembleRelease` (x86_64,
  debug-signed), producing a self-contained APK (no Metro). The APK is cached by
  a hash of the app sources, so flow/harness-only changes skip the ~24 min
  rebuild and the run finishes in ~10 min.
- **E2E** — boots an emulator, installs the APK, and runs `run-e2e.sh`, which
  drives the Maestro flows and always uploads a **screenshot, logcat, and UI
  hierarchy** as artifacts (so failures are inspectable without a device).

Flows:

- `sign-in.yaml` — smoke: the app boots to the sign-in screen (catches Clerk
  init hangs / crashes). The Google OAuth round-trip needs a real browser +
  Google account and is not automated here.

Trigger it from the GitHub Actions tab (**Run workflow**). To debug a failure,
download the `mobile-e2e-artifacts` and open `screen.png` / `ui.xml` / `logcat.txt`.

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
produces an AAB for the Play Store (defined but unused for now).

## Install on a physical Android device

1. Run `eas build -p android --profile preview` (or trigger the manual CI job
   below). EAS prints a build URL with a QR code when done.
2. On the phone, open the URL / scan the QR from the EAS build page.
3. Allow **install from unknown sources** if prompted, then install.
4. Launch **Zero Agent** — it opens to the sign-in screen; sign in with Google to
   reach the home screen.

Find past builds and their install URLs:

```bash
eas build:list
```

## CI build (manual)

A `mobile-build` job in `.github/workflows/ci.yml` runs an EAS `preview` build.
It is gated on **`workflow_dispatch`** (manual) — not on every push — to conserve
the free EAS quota (30 builds/month). Trigger it from the GitHub Actions tab
("Run workflow"). It requires an `EXPO_TOKEN` repository secret (create a token
in the Expo dashboard → Account settings → Access tokens).

The `lint` / `typecheck` / `test` jobs still run on every push and PR and include
this app via Turbo.
