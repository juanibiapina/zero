# Mobile releases (`apps/agent-mobile` Android preview)

The mobile app has two release paths:

1. **Routine release:** GitHub publishes a compatible EAS Update after CI passes on `main`.
2. **Native release:** Build and replace the preview APK when the native fingerprint changes.

The app uses the EAS `preview` channel and environment. The runtime policy is
`fingerprint`, so an incompatible update cannot load on an older APK.

The USB Pixel 7 on `mini` remains a development-client device. Never install a
preview or production APK on it. Use a separate device for preview APK and EAS
Update tests.

## Routine release: EAS Update

A push to `main` publishes an Android update after lint, typecheck, build, and
tests pass. The CI job publishes only for changes to these paths:

- `apps/agent-mobile/`
- `packages/agent-core/`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `package.json`
- `patches/`

CI runs this command from `apps/agent-mobile`:

```bash
eas update \
  --channel preview \
  --platform android \
  --environment preview \
  --message "<commit subject> (<short SHA>)" \
  --non-interactive
```

The `preview` environment contains the public
`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. The app uses
`https://zero.juanibiapina.dev` when `EXPO_PUBLIC_API_URL` is not present.

The update check does not block startup. On a cold launch, the app starts its
cached code and downloads a compatible update. The app uses that update on a
later cold launch.

No APK build, Drive download, or reinstall is necessary for this path.

### Server compatibility

Older installed apps continue to use the server after a mobile release. Keep
server interfaces backward-compatible.

If mobile code needs a new server interface, release the server change first.
Then release the mobile caller in a later `main` push.

### Recovery

Prefer a fix or revert on `main`. Green CI publishes the next compatible update.

Republish an older update only when it is compatible with data from the newer
code:

```bash
eas update:republish --group <group-id> --platform android
```

An update changes application code. It does not undo local or remote data
changes.

Use EAS Update insights after the metrics become available:

```bash
eas update:list --branch preview --json --non-interactive
eas update:insights <group-id> --platform android
eas channel:insights --channel preview --runtime-version <runtime-version>
```

## Native release: preview APK

Build a new APK when the native fingerprint changes. Native inputs include Expo
configuration, config plugins, native modules, native dependencies, and the Expo
SDK.

A CI update with a new fingerprint is safe. Existing APKs reject it until a
compatible APK is installed.

Three rules govern an APK release:

1. **Build locally by default.** Use the Nix Android shell on `mini`.
2. **Replace the Drive file.** Keep exactly one live APK in the release folder.
3. **Use a preview device.** Do not install the APK on the USB Pixel 7.

Bump `expo.version` for each native release. EAS manages and increments Android
`versionCode` through `appVersionSource: remote`.

### 1. Build the APK locally

The Android toolchain and NixOS requirements live in the mobile README section
[Local builds on the `mini` NixOS box](../apps/agent-mobile/README.md#local-builds-on-the-mini-nixos-box-no-eas-quota).

Run this command from the repository root on `mini`:

```bash
export NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1
nix develop ~/workspace/juanibiapina/dotfiles#android --command bash -c '
  cd apps/agent-mobile
  pnpm dlx eas-cli@latest build --platform android --profile preview --local \
    --non-interactive --output /tmp/zero-agent-preview.apk
'
```

The preview profile uses the EAS `preview` environment and remote Android
credentials. The local build does not consume cloud-build quota.

Rename the file with its app version and EAS-managed version code:

```bash
mv /tmp/zero-agent-preview.apk /tmp/zero-agent-v1.1.0-vc80-preview.apk
```

Replace the example version code with the value from the build log.

### 2. Replace the APK in Drive

The dedicated folder is **`Zero Agent releases`**. Its folder ID is
`1aQScniH9VH9sT7ejWUWhMvXtNvs6CWY_`.

```bash
FOLDER=1aQScniH9VH9sT7ejWUWhMvXtNvs6CWY_

gdcli juanibiapina@gmail.com upload \
  /tmp/zero-agent-v1.1.0-vc80-preview.apk --folder "$FOLDER"
gdcli juanibiapina@gmail.com share <newFileId> --anyone
gdcli juanibiapina@gmail.com ls "$FOLDER"
gdcli juanibiapina@gmail.com delete <oldFileId>
```

Upload and share the new APK before you delete the old APK. `gdcli delete` moves
the old file to Trash.

If the folder is lost, create it again and update the folder ID in this file:

```bash
gdcli juanibiapina@gmail.com mkdir "Zero Agent releases"
```

### 3. Install and test the APK

1. Open the shared Drive link on the preview device.
2. Allow installation from unknown sources when Android requests it.
3. Install the APK over the existing app.
4. Launch Zero Agent and sign in with Google.
5. Make sure that the app opens while the device is offline.

Do not change existing production entities during the test. Use throwaway
entities for a test that requires a write. Remove those entities after the test.

## First EAS Update bootstrap

Every tester must install the first update-enabled APK once. APKs before version
`1.1.0` do not contain `expo-updates` and cannot receive updates.

Use this sequence for the first release:

1. Build and install `development-pixel` on the USB Pixel 7.
2. Make sure that the development client still loads headless Metro.
3. Build and publish the `1.1.0` preview APK.
4. Install the APK on a separate preview device.
5. Re-run the successful CI workflow for the same commit.
6. Cold-launch the preview app once to download the update.
7. Stop the app fully.
8. Cold-launch the app again to use the update.
9. Stop network access and cold-launch the app again.

This sequence proves that the GitHub update fingerprint matches the APK from
`mini`. A cross-machine fingerprint mismatch prevents the update from loading.

The fake-auth E2E APK has remote updates disabled. It always uses its embedded
test bundle and local worker.

## Cloud build: explicit request only

Use a cloud build only when the user asks for one. The Expo Free plan includes
15 Android and 15 iOS cloud builds.

```bash
cd apps/agent-mobile
eas build --platform android --profile preview
```

Download the artifact after the build. Then use the same Drive replacement
procedure.

Use this command to list past builds:

```bash
eas build:list
```

The manual `mobile-build` job in `.github/workflows/ci.yml` also creates a cloud
preview build. Start it with `workflow_dispatch`. The job uses the GitHub
`EXPO_TOKEN` secret.
