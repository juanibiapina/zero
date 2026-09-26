#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d -t zero-tinybase-android.XXXXXX)"
CONTAINER="zero-tinybase-android-$$"
PROOF_ID="proof-$(date +%s)-$$"
MOBILE_PORT=8093
WORKER_PORT=8787
METRO_PID=""

cleanup() {
  adb shell am force-stop host.exp.exponent >/dev/null 2>&1 || true
  adb reverse --remove "tcp:$MOBILE_PORT" >/dev/null 2>&1 || true
  adb reverse --remove "tcp:$WORKER_PORT" >/dev/null 2>&1 || true
  [[ -n "$METRO_PID" ]] && kill -- "-$METRO_PID" >/dev/null 2>&1 || true
  podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [[ "${PROOF_KEEP_ARTIFACTS:-0}" == "1" ]]; then
    echo "Proof artifacts: $TEMP"
  else
    rm -rf "$TEMP"
  fi
}
trap cleanup EXIT

for port in "$MOBILE_PORT" "$WORKER_PORT"; do
  if ss -H -ltn "sport = :$port" | grep -q .; then
    echo "Port $port is occupied. Stop the other proof servers." >&2
    exit 1
  fi
done
if ! adb shell pm path host.exp.exponent >/dev/null 2>&1; then
  echo 'Install the official Expo Go 57 Android APK from https://expo.dev/go?sdkVersion=57&platform=android&device=true' >&2
  exit 1
fi

start_worker() {
  podman run -d --rm --name "$CONTAINER" --network host \
    -v "$ROOT:/app" -v "$TEMP/persist:/persist" -w /app \
    node:22-slim ./node_modules/.bin/wrangler dev \
      --persist-to /persist --ip 0.0.0.0 --port "$WORKER_PORT" \
    >/dev/null
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$WORKER_PORT/health" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  podman logs "$CONTAINER" >&2 || true
  exit 1
}
ui() { maestro --no-ansi hierarchy --compact 2>/dev/null; }
wait_ui() {
  local expected="$1" result
  for _ in $(seq 1 50); do
    result="$(ui || true)"
    if grep -Fq "text=$expected" <<< "$result"; then echo "PASS Android: $expected"; return; fi
    if grep -Fq 'text=Continue;' <<< "$result"; then
      adb shell input tap 540 2165 >/dev/null
    fi
    sleep 1
  done
  echo "Expected Android text: $expected" >&2
  ui | tail -45 >&2 || true
  tail -25 "$TEMP/metro.log" >&2 || true
  exit 1
}
tap_text() {
  local bounds x1 y1 x2 y2
  bounds="$(ui | grep -F "text=$1;" | head -1 | grep -oE 'bounds=\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]' || true)"
  [[ -n "$bounds" ]] || { echo "Cannot tap $1" >&2; exit 1; }
  read -r x1 y1 x2 y2 <<< "$(sed -E 's/[^0-9]+/ /g' <<< "$bounds")"
  adb shell input tap "$(((x1+x2)/2))" "$(((y1+y2)/2))" >/dev/null
}
launch() {
  adb shell am force-stop host.exp.exponent >/dev/null
  adb shell monkey -p host.exp.exponent 1 >/dev/null 2>&1
  adb shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:$MOBILE_PORT" -p host.exp.exponent >/dev/null
}
wait_server_task() {
  local expected="$1" data
  for _ in $(seq 1 60); do
    data="$(curl -fsS "http://127.0.0.1:$WORKER_PORT/api/state" -H 'Authorization: Bearer proof-user-a')"
    if jq -e --arg id "mobile-$PROOF_ID" --arg text "$expected" '.tasks[$id].text == $text' <<< "$data" >/dev/null; then
      echo "PASS server: Android Task = $expected"; return
    fi
    sleep 1
  done
  echo "Android Task did not reach server as $expected" >&2
  exit 1
}

mkdir -p "$TEMP/persist"
start_worker
(
  cd "$ROOT/mobile"
  EXPO_PUBLIC_PROOF_ID="$PROOF_ID" EXPO_NO_TELEMETRY=1 CI=1 \
    exec setsid ./node_modules/.bin/expo start --go --localhost \
      --port "$MOBILE_PORT" --clear >"$TEMP/metro.log" 2>&1
) &
METRO_PID=$!
for _ in $(seq 1 100); do
  if curl -fsS "http://localhost:$MOBILE_PORT/status" 2>/dev/null | grep -q packager-status:running; then break; fi
  sleep 1
done
curl -fsS "http://localhost:$MOBILE_PORT/status" | grep -q packager-status:running
adb reverse "tcp:$MOBILE_PORT" "tcp:$MOBILE_PORT" >/dev/null
adb reverse "tcp:$WORKER_PORT" "tcp:$WORKER_PORT" >/dev/null
curl -fsS "http://127.0.0.1:$WORKER_PORT/api/projects" \
  -X POST -H 'Authorization: Bearer proof-user-a' -H 'Content-Type: application/json' \
  -d "{\"id\":\"server-$PROOF_ID\",\"title\":\"From REST\"}" >/dev/null

launch
wait_ui 'SAVED AND SYNCED'
wait_server_task 'created on Android'
podman stop -t 10 "$CONTAINER" >/dev/null
launch
wait_ui 'RESTORED FROM SQLITE'
tap_text 'EDIT OFFLINE'
wait_ui 'OFFLINE EDIT SAVED'
launch
wait_ui 'RESTORED OFFLINE EDIT'
start_worker
launch
wait_ui 'RESTORED AND SYNCED'
wait_server_task 'edited offline'
OTHER="$(curl -fsS "http://127.0.0.1:$WORKER_PORT/api/state" -H 'Authorization: Bearer proof-user-b')"
jq -e --arg id "mobile-$PROOF_ID" '.tasks[$id] == null' <<< "$OTHER" >/dev/null
echo 'PASS Android: a real offline edit survives force-stop, syncs after reconnect, and remains account-isolated.'
