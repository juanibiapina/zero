# Mobile releases (`apps/agent-mobile` preview APK)

A release is a self-contained, sideloadable **preview** APK (production Clerk +
`https://zero.juanibiapina.dev` API baked in) handed to a real device, then
published to a dedicated Google Drive folder so exactly one release APK is live
at a time. This is separate from the dev-client build the `mini` Pixel runs (see
`apps/agent-mobile/README.md`).

Three rules govern a release:

1. **Build locally by default.** Build the APK on `mini` in the Nix dev shell
   with `--profile preview --local`. Build in the cloud only when explicitly
   asked (see [Cloud build](#cloud-build-only-when-asked)).
2. **Publish replaces.** Upload the new APK, then delete the previous one, so the
   Drive folder holds exactly one APK.
3. **One dedicated folder.** The APK lives in the Drive folder **`Zero Agent
   releases`** (`folderId` `1aQScniH9VH9sT7ejWUWhMvXtNvs6CWY_`), never in My Drive
   root.

## 1. Build locally (default)

The build runs on `mini` in the Nix `android` dev shell. That shell (toolchain
pins, the NixOS `aapt2` fix, `pnpm dlx eas-cli`, Expo-session auth) is documented
once in the README section [Local builds on the `mini` NixOS
box](../apps/agent-mobile/README.md#local-builds-on-the-mini-nixos-box-no-eas-quota);
this doc does not restate it.

The build takes ~50 min (gradle compiles native for all four ABIs). It runs with
`appVersionSource: remote` + `autoIncrement`, so EAS bumps the remote
`versionCode` (e.g. 60 → 61) and prints it. The app `version` is in `app.json`
(`expo.version`, e.g. `1.0.0`).

```bash
# From the zero repo root, on mini. ~50 min.
export NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1
nix develop ~/workspace/juanibiapina/dotfiles#android --command bash -c '
  cd apps/agent-mobile
  pnpm dlx eas-cli@latest build --platform android --profile preview --local \
    --non-interactive --output /tmp/zero-agent-preview.apk
'
# The log ends with "Incremented versionCode from N to N+1" and
# "You can find the build artifacts in /tmp/zero-agent-preview.apk".

# Name it <version>-vc<versionCode>, matching the Drive convention.
mv /tmp/zero-agent-preview.apk /tmp/zero-agent-v1.0.0-vc61-preview.apk
```

Notes:
- `eas build --local` still fetches the signing keystore from EAS ("Using remote
  Android credentials"), so the APK installs over the existing app with no
  uninstall. It runs the same prebuild + gradle steps as the cloud, on this box.
- Never `adb install` a `preview`/`production` APK onto the `mini` Pixel — a
  standalone build breaks hot-reload there (see the README callout). The release
  APK is for other devices.

## 2. Publish to Drive (replace)

Always upload the new APK into the `Zero Agent releases` folder, share it, then
delete every older APK so exactly one remains.

```bash
FOLDER=1aQScniH9VH9sT7ejWUWhMvXtNvs6CWY_

# 1) Upload into the folder.
gdcli juanibiapina@gmail.com upload /tmp/zero-agent-v1.0.0-vc61-preview.apk --folder $FOLDER

# 2) Make the new file link-shareable; the printed link is the install URL.
gdcli juanibiapina@gmail.com share <newFileId> --anyone

# 3) Delete every other APK in the folder so only the latest remains.
gdcli juanibiapina@gmail.com ls $FOLDER
gdcli juanibiapina@gmail.com delete <oldFileId>
```

`gdcli delete` moves the old APK to Trash (recoverable). The `--anyone` link is
what a phone opens to sideload (allow "install from unknown sources").

If the folder is ever lost, recreate it and update the `folderId` above:

```bash
gdcli juanibiapina@gmail.com mkdir "Zero Agent releases"
```

## 3. Install on a physical Android device

1. Open the shared `--anyone` link from step 2 on the phone.
2. Allow **install from unknown sources** if prompted, then install.
3. Launch **Zero Agent** — it opens to the sign-in screen; sign in with Google to
   reach the home screen.

## Cloud build (only when asked)

Build on EAS instead of locally only when explicitly requested (e.g. the local
Nix shell is unavailable). This spends the EAS free-tier Android quota (30
builds/month).

```bash
# From apps/agent-mobile. EAS prints a build URL with a QR code when done.
eas build -p android --profile preview
```

On the phone, open the URL / scan the QR from the EAS build page, then install as
above. After the cloud build finishes, download the artifact and publish it to
Drive with the same [replace step](#2-publish-to-drive-replace).

Find past builds and their install URLs:

```bash
eas build:list
```

### CI build (manual)

A `mobile-build` job in `.github/workflows/ci.yml` runs an EAS `preview` build.
It is gated on **`workflow_dispatch`** (manual) — not on every push — to conserve
the free EAS quota. Trigger it from the GitHub Actions tab ("Run workflow"). It
requires an `EXPO_TOKEN` repository secret (create a token in the Expo dashboard →
Account settings → Access tokens).
