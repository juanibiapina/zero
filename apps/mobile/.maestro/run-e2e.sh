#!/usr/bin/env bash
# Runs inside the android-emulator-runner. Installs the APK, runs the Maestro
# flows, and always captures a screenshot + UI hierarchy of the final state so
# failures are inspectable from CI artifacts. Kept as a file (not inline YAML)
# so multi-line shell and quoting are reliable.
set -uo pipefail

APK="${RUNNER_TEMP}/apk/app-release.apk"
OUT="${RUNNER_TEMP}"

# The emulator's Chrome has an uninitialised first-run screen that can pop over
# the app when the sign-in screen warms up Custom Tabs. Disable it for the smoke
# check so it cannot mask the app. The real OAuth flow is covered separately.
adb shell pm disable-user --user 0 com.android.chrome || true

adb install -r "$APK"
adb logcat -c
adb logcat > "${OUT}/logcat.txt" &

mkdir -p "${OUT}/maestro"
maestro test apps/mobile/.maestro \
  --format junit \
  --output "${OUT}/maestro/report.xml" \
  --debug-output "${OUT}/maestro"
CODE=$?

# Capture the final on-screen state and view hierarchy regardless of result.
adb exec-out screencap -p > "${OUT}/screen.png" || true
if adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; then
  adb pull /sdcard/ui.xml "${OUT}/ui.xml" || true
fi

exit "$CODE"
