# Frequent private Android releases with EAS Update

## Bottom line

Add EAS Update to the existing Android preview app. After one new `1.1.0`
preview APK is installed, a mobile-relevant `main` push that passes CI publishes
only JavaScript and bundled assets to one `preview` channel. Compatible installs
download the update automatically on a cold launch and run it on a later cold
launch. No APK build, Drive download, or reinstall is needed for that routine
path.

Keep native releases separate. Expo's `fingerprint` runtime policy prevents an
update from loading when native dependencies or configuration changed. Those
changes still use the existing local `mini` build and Google Drive replacement
process. The initial `1.1.0` APK is the one-time native bootstrap for EAS Update.

Use Expo's default nonblocking update behavior. Do not add an application update
module, startup wait, prompt, or forced reload.

## Goal

Make the common release path automatic and short:

```text
mobile-relevant main push → existing CI passes → publish EAS Update
```

A maintainer builds a new APK only when the native fingerprint changes. Testers
install the bootstrap APK once, then receive compatible updates without action.

## Confirmed current state

- `apps/agent-mobile` uses Expo SDK 57 and Continuous Native Generation.
- `expo-updates` is not installed. `expo-updates-interface`, present through
  `expo-dev-client`, cannot receive release updates.
- The linked EAS project is `@juanibiapina-zero/zero-agent`, ID
  `6811ec14-b903-4039-a2b9-83d659769de1`.
- The EAS project has no update channel, branch, update group, or project-scoped
  `preview` environment value.
- GitHub already has an `EXPO_TOKEN` secret and uses it for the manual EAS build
  job.
- Preview APKs are signed internal builds made locally on `mini`, then placed in
  the dedicated `Zero Agent releases` Drive folder. Local builds do not consume
  EAS cloud-build quota.
- The app version is still `1.0.0`; EAS remotely increments Android
  `versionCode` for every binary.
- Preview builds use production Clerk and the default production server URL,
  `https://zero.juanibiapina.dev`.
- The USB Pixel 7 must remain a development client. A separate preview device is
  required to prove real OTA delivery.
- Expo's Free plan currently allows unlimited update publications for 1,000
  update MAUs, 100 GiB bandwidth, and 20 GiB storage. Its cloud-build allowance
  is 15 Android and 15 iOS builds.

Official references:

- [EAS Update setup](https://docs.expo.dev/eas-update/getting-started/)
- [Default download behavior](https://docs.expo.dev/eas-update/download-updates/)
- [Runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/)
- [GitHub Actions](https://docs.expo.dev/eas-update/github-actions/)

## What to change

### 1. Configure one safe update runtime

Install the SDK-compatible `expo-updates` package with Expo's installer. Run
`eas update:configure`, inspect its output, and retain these app-config changes:

- `updates.url` is
  `https://u.expo.dev/6811ec14-b903-4039-a2b9-83d659769de1`;
- `runtimeVersion.policy` is `fingerprint`;
- `expo.version` becomes `1.1.0` for the first OTA-enabled APK.

Do not add `updates.checkAutomatically` or `updates.fallbackToCacheTimeout`.
Expo SDK 57 already defaults to `ON_LOAD` and `0`: launch cached code immediately,
check and download in the background, then apply on a later cold launch. Omitting
explicit defaults keeps the native configuration smaller without changing
behavior.

Keep release identifiers separate:

- `expo.version` is the human-readable native release version;
- Android `versionCode` remains EAS-managed and increments for every binary;
- `runtimeVersion` is the generated native fingerprint;
- each OTA release is identified by its EAS update group, Git SHA, and message.

Bump `expo.version` deliberately for every later native release. Routine OTA
updates do not change it. Keep `fingerprint` as the compatibility guard because a
missed app-version bump must not expose an old binary to incompatible JavaScript.

### 2. Give preview builds and updates one environment and channel

In `apps/agent-mobile/eas.json`:

- set the `preview` build profile's `channel` to `preview`;
- set its EAS `environment` to `preview`;
- remove the profile's inline Clerk key after the remote value exists.

Create one project-scoped plaintext EAS `preview` environment value:

- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` with the current production publishable
  key.

The publishable key is public by design. `EXPO_TOKEN` remains the only CI
credential. Do not add `EXPO_PUBLIC_API_URL` remotely: `src/lib/env.ts` already
owns the production default, and both builds and updates use it when no override
is present.

Use one same-named EAS branch and channel, `preview`. Do not add dogfood,
production, per-feature, or percentage-rollout paths for this small trusted
cohort.

### 3. Keep the hermetic E2E APK offline from EAS Update

When `EXPO_PUBLIC_E2E_FAKE_AUTH=1`, extend `app.config.js` to set
`updates.enabled` to `false` in addition to installing the existing cleartext
plugin. Leave the `e2e` profile without a channel.

The fake-auth release suite must always run its embedded test bundle and local
worker. Development builds continue to load Metro; Expo disables release-update
methods in development mode.

### 4. Publish one update after existing CI succeeds

Add a path-gate job and a `mobile-update` job to `.github/workflows/ci.yml`.
The gate checks the full pushed commit range with `fetch-depth: 0` and exposes a
boolean output. It reports true only when the push changed
`apps/agent-mobile/**`, `packages/agent-core/**`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, root `package.json`, or `patches/**`.

Keep concurrency on the publisher, not the gate. Otherwise, an irrelevant push
can cancel an active relevant publication before its own diff step skips.

The `mobile-update` job must:

1. depend on the path gate and the existing `lint-and-typecheck` and `build` jobs;
2. run only for a relevant push to `main`, never for pull requests or manual CI;
3. use job-level `preview` concurrency with `cancel-in-progress: true`, so a
   superseded relevant run cannot become the final published update;
4. install the repository's Node and pnpm versions with a frozen lockfile;
5. configure EAS with the existing GitHub `EXPO_TOKEN`;
6. run this command from `apps/agent-mobile`:

```bash
eas update \
  --channel preview \
  --platform android \
  --environment preview \
  --message "<commit subject> (<short SHA>)" \
  --non-interactive
```

Use the EAS CLI's normal output and dashboard link. Do not add custom fingerprint
comparison, runtime warnings, JSON parsing, variable-name preflights, or GitHub
summaries. EAS runtime matching already prevents an incompatible update from
loading.

Automatic publication assumes any new server interface is already live and
backward-compatible. Land required server support in an earlier `main` push,
then land the mobile caller. This sequencing is necessary anyway because older
installed clients continue using the server.

### 5. Bootstrap the OTA-enabled cohort

After the implementation reaches `main` and CI passes:

1. Build `development-pixel` locally, install it on the USB Pixel, and prove it
   still loads headless Metro.
2. Build `preview` locally on `mini` with EAS remote credentials and the next
   EAS-managed `versionCode`.
3. Replace the APK in the existing Drive folder, preserving the one-live-file
   rule.
4. Install the `1.1.0` APK over the existing app on a separate preview device.
5. Ask each tester to install this baseline once. Older APKs do not contain
   `expo-updates` and cannot join the OTA cohort.
6. Re-run the successful GitHub CI workflow after the baseline is installed so
   GitHub publishes a newer update group from the same commit and runtime.
7. Cold-launch the preview app once to download the update, kill it fully, then
   cold-launch it again to run the update.

This final test also proves that a fingerprint produced by GitHub matches the APK
built on `mini`. Cross-machine fingerprint mismatches have occurred in Expo
monorepos, so the real APK-to-update round trip is the test surface; synthetic
edits of temporary files are not.

For a later native fingerprint change, the CI publication is harmless but old
APKs cannot load it. Build and replace the preview APK through the same local
release procedure.

## Recovery

The normal recovery path is a fix or revert on `main`; green CI publishes the
next compatible update. Republish an older update group only after proving it is
compatible with any local or remote data written by newer code:

```bash
eas update:republish --group <group-id> --platform android
```

Prefer fix-forward after cache, outbox, or server-shape changes. EAS rollback
changes application code, not data already written by that code.

EAS Update insights are an operational aid, not an implementation gate. Use
`eas update:insights` or `eas channel:insights` after metrics have propagated
when diagnosing adoption or failed launches.

## Test strategy

### Automated and configuration checks

- Resolve normal Expo config and confirm the exact update URL, `fingerprint`
  policy, version `1.1.0`, and EAS project ID.
- Resolve config with `EXPO_PUBLIC_E2E_FAKE_AUTH=1` and confirm remote updates are
  disabled while the cleartext plugin remains enabled.
- Generate the Android preview fingerprint twice from identical inputs and
  require identical hashes.
- Run mobile Jest, lint, typecheck, and Android Expo export.
- Run `gob run bin/ci`. If the documented NixOS `workerd` limitation prevents
  completion, record it and run the directly affected package checks; GitHub CI
  remains the complete repository gate.
- Validate the changed GitHub workflow syntax before push.

Do not test Expo's fingerprint implementation by mutating temporary TypeScript or
native files. Do not require delayed EAS metrics to pass implementation.

### Device proof

- On the USB Pixel, install only the rebuilt development client and verify Metro,
  app startup, and one read-only navigation path.
- On a separate preview device, install `1.1.0`, complete the two-cold-launch OTA
  round trip, and confirm the app still opens offline afterward.
- Update delivery requires no production-data mutation. Do not edit the user's
  existing entities.
- Leave the USB Pixel on its development client and restore device networking.

## Documentation

- Rewrite `docs/mobile-releases.md` around two paths: automatic EAS Updates and
  local native APK replacement. Keep the Drive folder, bootstrap instructions,
  recovery command, and current quotas there.
- Update the mobile README only where it says every release is an APK or no local
  Android toolchain is needed. Link to the release runbook instead of duplicating
  it.
- Update the repository `AGENTS.md` summary so future agents use EAS Update for
  routine releases and local APKs for native changes.
- Update `docs/todo-app.md` with shipped status and proof; keep update-group
  history in EAS rather than duplicating it in the tracking document.
- Load the `changelog` skill and add a newest-first entry to
  `apps/agent-mobile/CHANGELOG.md`: “Preview installs now download compatible
  releases automatically, so most updates arrive after reopening the app without
  downloading another APK.”
- Correct the release runbook's stale 30-build statement to 15 Android and 15 iOS
  cloud builds.

## Skills to use

- `expo-overview` — preserve Expo SDK 57 setup rules.
- `eas-app-stores` — configure build profiles and produce the native bootstrap.
- `testing` and `reproducible-locally` — verify config, CI, offline startup, and
  the real APK-to-update path.
- `eas-update-insights` — investigate adoption only after publication.
- `vocabulary` and `deep-modules` — rely on Expo's deep native update module
  instead of adding an application wrapper.
- `documentation` and `changelog` — maintain the release source of truth and
  mobile release note.
- `gdcli` — replace the Drive APK without leaving stale files.
- `git-commit` — commit package, lockfile, config, CI, changelog, and docs
  together.

## Acceptance criteria

- The signed `1.1.0` preview APK contains `expo-updates`, the exact EAS project
  URL, the `preview` channel, and a fingerprint runtime.
- Preview build and update bundles use the same Clerk key and production server.
- The E2E APK cannot contact EAS Update, and the USB Pixel remains a Metro-loaded
  development client.
- A mobile-relevant `main` push publishes one Android update only after existing
  CI passes. Pull requests, manual CI runs, irrelevant pushes, failed checks, and
  superseded runs publish nothing.
- A compatible preview APK downloads an update without user action and runs it
  after a later cold launch.
- The initial real-device round trip proves the GitHub-produced runtime matches
  the locally built APK.
- A native-incompatible update does not load on an older APK; native changes use
  the local build and Drive replacement path.
- Update checks do not block offline startup or reload active work.
- The mobile changelog and release documentation ship with the implementation.

## Out of scope

- Google Play, public production release, iOS, and TestFlight.
- Automatic installation of native APK changes. Sideloaded Android apps still
  require an approved install; Google Play internal testing is the later path for
  automatic native updates.
- EAS Workflows, Expo's experimental continuous-deploy-fingerprint GitHub action,
  per-PR previews, multiple channels, percentage rollouts, channel surfing,
  mandatory updates, background tasks, and an in-app update screen.
- Changing the todo data model, server interface, entity cache version, offline
  outbox version, or feature behavior.

## Risks and mitigations

- **GitHub and `mini` produce different fingerprints.** Prove the real bootstrap
  APK consumes a GitHub-published update before declaring the work complete.
- **A native update is published but reaches no existing APK.** Fingerprint
  matching makes this safe; the maintainer follows the documented native release
  path when native inputs changed.
- **Mobile code requires server behavior that is not live.** Land backward-compatible
  server support first, then the automatically published mobile caller.
- **A rollback meets data written by newer code.** Prefer fix-forward and test
  data compatibility before republishing an older group.
- **An old APK is assumed to support updates.** Require the one-time `1.1.0`
  bootstrap install; earlier APKs cannot receive EAS Updates.
