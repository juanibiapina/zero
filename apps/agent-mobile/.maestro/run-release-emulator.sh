#!/usr/bin/env bash
# Runs inside the android-emulator-runner for the hermetic RELEASE suite. The
# fake-auth APK is already signed in; it talks to a local worker the CI job
# started on the runner host (port 8787). `adb reverse` maps the device's
# localhost:8787 to that host port, so the same http://localhost:8787 the device
# harness uses works on the emulator too. Installs the APK, runs the release
# flows, and always captures a screenshot + UI hierarchy so failures are
# inspectable from CI artifacts.
set -uo pipefail

APK="${RUNNER_TEMP}/apk/app-release.apk"
OUT="${RUNNER_TEMP}"

# Trim background apps that contend for CPU on the underpowered CI emulator and
# make SystemUI ANR (an ANR dialog masks the app).
for pkg in com.google.android.googlequicksearchbox \
           com.google.android.apps.messaging com.google.android.youtube \
           com.google.android.apps.photos com.google.android.videos; do
  adb shell pm disable-user --user 0 "$pkg" || true
done

adb wait-for-device

# Route the device's localhost:8787 to the worker running on the runner host.
adb reverse tcp:8787 tcp:8787

adb install -r "$APK"
adb logcat -c
adb logcat > "${OUT}/logcat.txt" &

# Let the system settle before driving the UI, so SystemUI is not still busy.
sleep 20

mkdir -p "${OUT}/maestro"
# The CI emulator occasionally throws a transient SystemUI ANR that masks the
# app; retry the suite once before treating it as a real failure. Re-establish
# the reverse tunnel each attempt in case a restart dropped it.
CODE=0
for attempt in 1 2; do
  adb reverse tcp:8787 tcp:8787 || true
  maestro --no-ansi test apps/agent-mobile/.maestro/release \
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
