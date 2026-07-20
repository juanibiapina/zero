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
4. Launch **Zero Agent** — it opens to the blank home screen.

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
