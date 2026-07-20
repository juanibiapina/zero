#!/usr/bin/env bash
# Runs inside the android-emulator-runner. Installs the APK, runs the Maestro
# flows, and always captures a screenshot + UI hierarchy of the final state so
# failures are inspectable from CI artifacts. Kept as a file (not inline YAML)
# so multi-line shell and quoting are reliable.
set -uo pipefail

APK="${RUNNER_TEMP}/apk/app-release.apk"
OUT="${RUNNER_TEMP}"

# Trim background apps that contend for CPU on the underpowered CI emulator and
# make SystemUI ANR (an ANR dialog masks the app). Chrome also has an
# uninitialised first-run screen that can pop over the app; disable it for the
# smoke check. The real OAuth flow (which needs a browser) is covered separately.
for pkg in com.android.chrome com.google.android.googlequicksearchbox \
           com.google.android.apps.messaging com.google.android.youtube \
           com.google.android.apps.photos com.google.android.videos; do
  adb shell pm disable-user --user 0 "$pkg" || true
done

adb install -r "$APK"
adb logcat -c
adb logcat > "${OUT}/logcat.txt" &

# Let the system settle before driving the UI, so SystemUI is not still busy.
sleep 20

mkdir -p "${OUT}/maestro"
# The CI emulator occasionally throws a transient SystemUI ANR that masks the
# app; retry the flow once before treating it as a real failure.
CODE=0
for attempt in 1 2; do
  maestro test apps/mobile/.maestro \
    --format junit \
    --output "${OUT}/maestro/report.xml" \
    --debug-output "${OUT}/maestro"
  CODE=$?
  [ "$CODE" -eq 0 ] && break
  echo "Maestro attempt $attempt failed (code $CODE); settling and retrying..."
  adb shell am force-stop dev.juanibiapina.zeroagent || true
  sleep 15
done

# Capture the final on-screen state and view hierarchy regardless of result.
adb exec-out screencap -p > "${OUT}/screen.png" || true
if adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; then
  adb pull /sdcard/ui.xml "${OUT}/ui.xml" || true
fi

exit "$CODE"
