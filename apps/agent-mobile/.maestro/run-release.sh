#!/usr/bin/env bash
# Device harness for the hermetic RELEASE suite on the Pixel 7 attached to
# `mini`. NixOS cannot start `workerd` directly, so the local worker runs in a
# rootless podman container serving `wrangler dev` on the test config against a
# throwaway `--persist-to` dir (wiped per run for a clean Durable Object). The
# container publishes 8787; `adb reverse` maps the phone's localhost:8787 to it,
# matching the URL baked into the e2e APK. Always captures a screenshot + UI
# hierarchy of the final state.
#
# Prereqs: the fake-auth e2e APK is already installed on the Pixel
# (`eas build -p android --profile e2e --local` then `adb install -r`, or the
# gradle path in README), rootless podman works for the user, and `adb devices`
# lists the phone.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$(mktemp -d)"
PERSIST="$(mktemp -d)"
CONTAINER="zero-release-worker"
IMAGE="node:22-slim"

cleanup() {
  podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$PERSIST"
}
trap cleanup EXIT

echo "Starting local worker container (this installs deps on first run)..."
podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Mount the repo so the container builds the worker from source; a named volume
# keeps node_modules across runs so only the first run pays the install cost.
# --network host: rootless podman's default pasta NAT intermittently resets
# connections under load, which flakes the device traffic; host networking binds
# workerd straight to the host's 8787 with no NAT.
podman run -d --name "$CONTAINER" \
  --network host \
  -v "$REPO_ROOT":/repo \
  -v zero-release-node-modules:/repo/node_modules \
  -v "$PERSIST":/persist \
  -w /repo/apps/agent-api \
  "$IMAGE" \
  bash -lc '
    set -e
    corepack enable
    cd /repo
    pnpm install --frozen-lockfile
    cd /repo/apps/agent-api
    exec pnpm exec wrangler dev --config wrangler.e2e.jsonc \
      --persist-to /persist --ip 0.0.0.0 --port 8787
  '

echo "Waiting for the worker to answer on http://localhost:8787 ..."
for _ in $(seq 1 120); do
  # A missing bearer must 401; that proves the /api guard is up.
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/api/tasks || true)
  [ "$code" = "401" ] && break
  sleep 5
done
if [ "$code" != "401" ]; then
  echo "Worker did not come up (last code: ${code:-none}). Logs:"
  podman logs "$CONTAINER" 2>&1 | tail -30
  exit 1
fi

# Sanity: a task round-trips through the local worker with the fake bearer.
curl -s -X POST http://localhost:8787/api/tasks \
  -H 'Authorization: Bearer e2e-test-user' \
  -H 'Content-Type: application/json' \
  -d '{"id":"11111111-1111-4111-8111-111111111111","text":"smoke","showUpDate":"2026-01-01"}' \
  >/dev/null || true

adb wait-for-device
adb reverse tcp:8787 tcp:8787

adb logcat -c
adb logcat > "${OUT}/logcat.txt" &
LOGCAT_PID=$!
trap 'kill "$LOGCAT_PID" >/dev/null 2>&1 || true; cleanup' EXIT

mkdir -p "${OUT}/maestro"
maestro test "${REPO_ROOT}/apps/agent-mobile/.maestro/release" \
  --format junit \
  --output "${OUT}/maestro/report.xml" \
  --debug-output "${OUT}/maestro"
CODE=$?

adb exec-out screencap -p > "${OUT}/screen.png" || true
if adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; then
  adb pull /sdcard/ui.xml "${OUT}/ui.xml" || true
fi

echo "Artifacts in: ${OUT}"
exit "$CODE"
