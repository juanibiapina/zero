# @zero/mobile — Zero Agent

Expo (React Native) app for Zero, built and distributed with **EAS Build** so no
Android Studio or Android SDK is needed locally or in CI. Native compilation runs
on Expo's servers; you only need Node and an Expo account.

## Identifiers

| Field             | Value                         |
| ----------------- | ----------------------------- |
| Display name      | `Zero Agent`                  |
| Package (npm)     | `@zero/mobile`                |
| Expo slug         | `zero-agent`                  |
| Android package   | `dev.juanibiapina.zeroagent`  |
| Expo SDK          | 57 (React Native 0.86, React 19.2) |

## Prerequisites

- Node (repo `.nvmrc`, Node 22 LTS) and pnpm 10.21 (`pnpm install` at the repo root).
- A free [Expo account](https://expo.dev) and the EAS CLI: `pnpm dlx eas-cli`
  (or `npm i -g eas-cli`). Run `eas login` once.
- One-time project link: `eas init` from `apps/mobile` (writes the EAS project id
  into `app.json`). Requires being logged in.

## Toolchain notes (divergence from the shared configs)

Expo's presets are used instead of the repo-shared configs, and are pinned
locally (pnpm isolated installs keep them scoped to this app):

- **ESLint**: `eslint-config-expo` (flat config in `eslint.config.js`), not
  `@zero/eslint-config`. Pinned to **eslint 9** here because
  `eslint-plugin-react` (pulled in by `eslint-config-expo`) does not yet run on
  the repo's eslint 10.
- **TypeScript**: extends `expo/tsconfig.base`, not `@zero/typescript-config`.

## Authentication and environment

The app signs in with **Clerk**, against the **same Clerk instance as the web
app**, so a user has one account across web and mobile. Sign-in is now the entry
screen: signed-out users see "Continue with Google" (Google OAuth via Clerk's
`useSSO`); after signing in they reach the home screen. The Clerk session is
persisted in `expo-secure-store`, so it survives app restarts.

Environment variables (Expo inlines `EXPO_PUBLIC_*` at build time):

| Variable                            | Required | Default                          | Purpose                                             |
| ----------------------------------- | -------- | -------------------------------- | --------------------------------------------------- |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes      | —                                | Clerk publishable key (same value the web app uses) |
| `EXPO_PUBLIC_API_URL`               | no       | `https://zero.juanibiapina.dev`  | Base URL for authenticated `/api/*` calls           |

The Clerk **publishable** key is public by design (`pk_...`, already shipped in
the web bundle), so it is committed in the `env` block of every `eas.json` build
profile — it is **not** an EAS Secret. For local `expo start`, export the same
value in your shell or put it in `apps/mobile/.env.local` (gitignored):

```bash
export EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
```

### Clerk dashboard: native OAuth redirect

Native OAuth completes via the app scheme (`zeroagent://`, set in `app.json`). If
Google sign-in fails at the redirect step on a device, add `zeroagent://` as an
allowed redirect in the Clerk dashboard (Native applications / SSO redirect
allow-list). This affects on-device sign-in only; it does not change unit tests.

## Develop / test loop (no Android Studio)

1. Build a **development build** (dev client) once on EAS and install it on your
   phone (see below).
2. Iterate on JS with hot reload:
   ```bash
   pnpm --filter @zero/mobile exec expo start
   ```
   Scan the QR with the installed dev client; saves hot-reload over wifi.
3. Only rebuild on EAS when **native** code/modules change (e.g. adding
   `expo-location`). Pure-JS changes never need a rebuild.

After a fresh install, clear the Metro cache once:
`pnpm --filter @zero/mobile exec expo start --clear`.

The app uses the **default** `expo/metro-config` — no custom monorepo Metro
config is needed (SDK 52+ auto-detects the workspace, SDK 54+ supports pnpm
isolated installs).

## Checks

Joins the root Turbo pipeline (`turbo run lint | typecheck | test`). It defines
no `build` script, so it is excluded from `turbo run build` and the web/api
deploy path.

```bash
pnpm --filter @zero/mobile lint
pnpm --filter @zero/mobile typecheck
pnpm --filter @zero/mobile test
```

## Builds

From `apps/mobile`:

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
