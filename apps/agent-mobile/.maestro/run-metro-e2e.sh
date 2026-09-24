#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MOBILE_DIR="${REPO_ROOT}/apps/agent-mobile"
HERMETIC_FLOW_DIR="${MOBILE_DIR}/.maestro/hermetic"
PACKAGE="dev.juanibiapina.zeroagent"
METRO_PORT=8082
WORKER_PORT=8787
TASK_TEXT="E2E loose task"
PROJECT_TITLE="E2E described project"
PROJECT_DESCRIPTION="E2E durable project description"
FLOW_COUNT="$(find "$HERMETIC_FLOW_DIR" -maxdepth 1 -type f -name '*.yaml' | wc -l | tr -d '[:space:]')"
IMAGE="node:22-slim"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
ARTIFACT_DIR="${E2E_ARTIFACT_ROOT:-/tmp/zero-mobile-e2e}/${RUN_ID}"
PERSIST_DIR="$(mktemp -d -t zero-mobile-e2e-worker.XXXXXX)"
CONTAINER="zero-mobile-e2e-${RUN_ID,,}"
CONTAINER="${CONTAINER//[^a-z0-9_.-]/-}"
STAGE="preflight"
STARTED_AT="$(date +%s)"
SUCCESS=0
DIAGNOSTICS_CAPTURED=0
PRODUCTION_SNAPSHOT_TAKEN=0
METRO_PID=""
WORKER_PID=""
LOGCAT_PID=""
SERIAL=""

mkdir -p "$ARTIFACT_DIR/maestro"
: > "$ARTIFACT_DIR/metro.log"
: > "$ARTIFACT_DIR/worker.log"
: > "$ARTIFACT_DIR/maestro.log"
: > "$ARTIFACT_DIR/logcat.txt"

verbose() {
  if [[ "${E2E_VERBOSE:-0}" == "1" ]]; then
    printf '[%s] %s\n' "$STAGE" "$*"
  fi
}

port_is_listening() {
  ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}

adb_device() {
  adb -s "$SERIAL" "$@"
}

production_checksums() {
  local command
  command='cd databases 2>/dev/null || exit 0; for f in zero-app.sqlite* zero-app-outbox-v2.sqlite*; do if [ -f "$f" ]; then sha256sum "$f"; fi; done'
  adb_device shell "run-as $PACKAGE sh -c '$command'" 2>/dev/null | tr -d '\r' | sort
}

package_identity() {
  {
    adb_device shell pm path "$PACKAGE"
    adb_device shell dumpsys package "$PACKAGE" | grep -E 'versionCode=|versionName=' | head -2
  } | tr -d '\r'
}

launcher_alias_state() {
  adb_device shell dumpsys package "$PACKAGE" | awk '
    /disabledComponents:|enabledComponents:/ { section=$1 }
    /Queries:/ { section="" }
    section != "" && /MainActivityIcon/ { print section, $1 }
  ' | tr -d '\r' | sort
}

delete_e2e_stores() {
  local command
  command='cd databases 2>/dev/null || exit 0; rm -f zero-app-e2e.sqlite* zero-app-e2e-outbox-v2.sqlite*'
  adb_device shell "run-as $PACKAGE sh -c '$command'" >/dev/null 2>&1 || true
}

capture_diagnostics() {
  if [[ "$DIAGNOSTICS_CAPTURED" == "1" ]]; then return; fi
  DIAGNOSTICS_CAPTURED=1
  set +e
  if [[ -n "$SERIAL" ]]; then
    timeout 15 adb -s "$SERIAL" exec-out screencap -p > "$ARTIFACT_DIR/screen.png" 2>/dev/null
    timeout 15 maestro --no-ansi hierarchy --compact > "$ARTIFACT_DIR/hierarchy.txt" 2>&1
    timeout 15 adb -s "$SERIAL" shell uiautomator dump /sdcard/zero-e2e-ui.xml >/dev/null 2>&1
    timeout 15 adb -s "$SERIAL" pull /sdcard/zero-e2e-ui.xml "$ARTIFACT_DIR/ui.xml" >/dev/null 2>&1
  fi
  set -e
}

print_failure() {
  printf 'FAIL: %s (artifacts: %s)\n' "$STAGE" "$ARTIFACT_DIR" >&2
  if [[ -s "$ARTIFACT_DIR/maestro/report.xml" ]]; then
    grep -E '<testsuite|<failure|<error' "$ARTIFACT_DIR/maestro/report.xml" | tail -8 >&2 || true
  fi
  case "$STAGE" in
    worker*) tail -30 "$ARTIFACT_DIR/worker.log" >&2 || true ;;
    metro*|launch*) tail -30 "$ARTIFACT_DIR/metro.log" >&2 || true ;;
    maestro*) tail -30 "$ARTIFACT_DIR/maestro.log" >&2 || true ;;
    postcondition*)
      tail -20 "$ARTIFACT_DIR/maestro.log" >&2 || true
      tail -20 "$ARTIFACT_DIR/worker.log" >&2 || true
      ;;
    storage*) cat "$ARTIFACT_DIR/storage-check.txt" >&2 2>/dev/null || true ;;
    launcher*) diff -u "$ARTIFACT_DIR/launcher-before.txt" "$ARTIFACT_DIR/launcher-after.txt" >&2 || true ;;
  esac
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e

  if [[ "$SUCCESS" != "1" ]]; then capture_diagnostics; fi

  if [[ -n "$SERIAL" ]]; then
    adb_device shell am force-stop "$PACKAGE" >/dev/null 2>&1 || true
    if [[ "$PRODUCTION_SNAPSHOT_TAKEN" == "1" ]]; then
      production_checksums > "$ARTIFACT_DIR/production-after.txt" 2>/dev/null || true
      if ! cmp -s "$ARTIFACT_DIR/production-before.txt" "$ARTIFACT_DIR/production-after.txt"; then
        {
          echo 'Production database checksums changed:'
          diff -u "$ARTIFACT_DIR/production-before.txt" "$ARTIFACT_DIR/production-after.txt" || true
        } > "$ARTIFACT_DIR/storage-check.txt"
        if [[ "$SUCCESS" == "1" ]]; then
          SUCCESS=0
          STAGE="storage isolation"
          code=1
        fi
      fi
    fi
    delete_e2e_stores
    adb_device reverse --remove "tcp:$METRO_PORT" >/dev/null 2>&1 || true
    adb_device reverse --remove "tcp:$WORKER_PORT" >/dev/null 2>&1 || true
  fi

  [[ -n "$LOGCAT_PID" ]] && kill "$LOGCAT_PID" >/dev/null 2>&1 || true
  [[ -n "$METRO_PID" ]] && kill -- "-$METRO_PID" >/dev/null 2>&1 || true
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" >/dev/null 2>&1 || true
  podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [[ -n "$METRO_PID" ]] && wait "$METRO_PID" >/dev/null 2>&1 || true
  [[ -n "$WORKER_PID" ]] && wait "$WORKER_PID" >/dev/null 2>&1 || true
  rm -rf "$PERSIST_DIR"

  if [[ "$SUCCESS" == "1" ]]; then
    for _ in $(seq 1 20); do
      if ! port_is_listening "$METRO_PORT" && ! port_is_listening "$WORKER_PORT"; then
        break
      fi
      sleep 0.25
    done
    if port_is_listening "$METRO_PORT" || port_is_listening "$WORKER_PORT"; then
      SUCCESS=0
      STAGE="process cleanup"
      code=1
    fi
  fi

  if [[ -n "$SERIAL" && -f "$ARTIFACT_DIR/package-before.txt" ]]; then
    package_identity > "$ARTIFACT_DIR/package-after.txt" 2>/dev/null || true
    if ! cmp -s "$ARTIFACT_DIR/package-before.txt" "$ARTIFACT_DIR/package-after.txt"; then
      SUCCESS=0
      STAGE="dev-client identity"
      code=1
    fi
  fi
  if [[ -n "$SERIAL" && -f "$ARTIFACT_DIR/launcher-before.txt" ]]; then
    launcher_alias_state > "$ARTIFACT_DIR/launcher-after.txt" 2>/dev/null || true
    if ! cmp -s "$ARTIFACT_DIR/launcher-before.txt" "$ARTIFACT_DIR/launcher-after.txt"; then
      SUCCESS=0
      STAGE="launcher isolation"
      code=1
    fi
  fi

  if [[ "$SUCCESS" == "1" && "$code" == "0" ]]; then
    local flow_label="flows"
    [[ "$FLOW_COUNT" == "1" ]] && flow_label="flow"
    printf 'PASS: %s %s in %ss (Pixel 7, hermetic Metro)\n' \
      "$FLOW_COUNT" "$flow_label" "$(( $(date +%s) - STARTED_AT ))"
    exit 0
  fi

  if [[ "$code" == "0" ]]; then code=1; fi
  print_failure
  exit "$code"
}
trap cleanup EXIT
trap 'STAGE="interrupted"; exit 130' INT TERM

for command in adb curl jq maestro node podman pnpm setsid ss timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

mapfile -t PIXELS < <(adb devices -l | awk '$2 == "device" && /model:Pixel_7/ { print $1 }')
if [[ "${#PIXELS[@]}" -ne 1 ]]; then
  echo "Expected exactly one connected Pixel 7; found ${#PIXELS[@]}" >&2
  exit 1
fi
SERIAL="${PIXELS[0]}"
adb_device wait-for-device

if ! adb_device shell pm path "$PACKAGE" | grep -q '^package:'; then
  echo "The Zero Agent package is not installed on the Pixel 7" >&2
  exit 1
fi
if ! adb_device shell dumpsys package "$PACKAGE" | grep -q 'DEBUGGABLE'; then
  echo "The installed Zero Agent package is not a development client" >&2
  exit 1
fi
if ! adb_device shell "run-as $PACKAGE true" >/dev/null 2>&1; then
  echo "The installed Zero Agent package does not allow debug storage isolation" >&2
  exit 1
fi
for port in "$METRO_PORT" "$WORKER_PORT"; do
  if port_is_listening "$port"; then
    echo "Dedicated E2E port $port is already in use" >&2
    exit 1
  fi
done

package_identity > "$ARTIFACT_DIR/package-before.txt"
adb_device shell am force-stop "$PACKAGE" >/dev/null
launcher_alias_state > "$ARTIFACT_DIR/launcher-before.txt"
production_checksums > "$ARTIFACT_DIR/production-before.txt"
PRODUCTION_SNAPSHOT_TAKEN=1
delete_e2e_stores

STAGE="worker startup"
verbose "starting local Worker"
podman run --rm --name "$CONTAINER" \
  --network host \
  -v "$REPO_ROOT":/repo \
  -v zero-release-node-modules:/repo/node_modules \
  -v zero-release-pnpm-store:/pnpm-store \
  -v "$PERSIST_DIR":/persist \
  -w /repo/apps/agent-api \
  "$IMAGE" \
  bash -lc '
    set -e
    corepack enable
    pnpm config set store-dir /pnpm-store
    cd /repo
    CI=true pnpm install --frozen-lockfile
    cd /repo/apps/agent-api
    exec pnpm exec wrangler dev --config wrangler.e2e.jsonc \
      --persist-to /persist --ip 0.0.0.0 --port 8787
  ' > "$ARTIFACT_DIR/worker.log" 2>&1 &
WORKER_PID=$!

STAGE="worker readiness"
worker_code=""
for _ in $(seq 1 120); do
  worker_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:$WORKER_PORT/api/tasks" 2>/dev/null || true)"
  [[ "$worker_code" == "401" ]] && break
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then break; fi
  sleep 2
done
if [[ "$worker_code" != "401" ]]; then
  echo "Worker readiness returned ${worker_code:-no response}" >> "$ARTIFACT_DIR/worker.log"
  exit 1
fi
empty_tasks_response="$(curl -fsS "http://localhost:$WORKER_PORT/api/tasks" -H 'Authorization: Bearer e2e-test-user')"
if ! jq -e '.tasks == []' <<< "$empty_tasks_response" >/dev/null; then
  printf 'Expected an empty local task list; received %s\n' "$empty_tasks_response" >> "$ARTIFACT_DIR/worker.log"
  exit 1
fi
empty_projects_response="$(curl -fsS "http://localhost:$WORKER_PORT/api/projects" -H 'Authorization: Bearer e2e-test-user')"
if ! jq -e '.projects == []' <<< "$empty_projects_response" >/dev/null; then
  printf 'Expected an empty local Project list; received %s\n' "$empty_projects_response" >> "$ARTIFACT_DIR/worker.log"
  exit 1
fi

STAGE="metro startup"
verbose "starting hermetic Metro"
CLERK_KEY="$(node -p "require('${MOBILE_DIR}/eas.json').build.development.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY")"
env -u EXPO_PUBLIC_API_URL \
  EXPO_PUBLIC_HERMETIC_E2E=1 \
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY="$CLERK_KEY" \
  EXPO_UNSTABLE_HEADLESS=1 \
  setsid bash -c '
    cd "$1"
    exec pnpm exec expo start --dev-client --localhost --port "$2" --clear
  ' _ "$MOBILE_DIR" "$METRO_PORT" > "$ARTIFACT_DIR/metro.log" 2>&1 &
METRO_PID=$!

STAGE="metro readiness"
metro_status=""
for _ in $(seq 1 120); do
  metro_status="$(curl -fsS "http://localhost:$METRO_PORT/status" 2>/dev/null || true)"
  [[ "$metro_status" == *"packager-status:running"* ]] && break
  if ! kill -0 "$METRO_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$metro_status" != *"packager-status:running"* ]]; then
  echo "Metro readiness returned ${metro_status:-no response}" >> "$ARTIFACT_DIR/metro.log"
  exit 1
fi

STAGE="launch dev client"
adb_device reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT" >/dev/null
adb_device reverse "tcp:$WORKER_PORT" "tcp:$WORKER_PORT" >/dev/null
adb_device logcat -c
adb_device logcat > "$ARTIFACT_DIR/logcat.txt" 2>&1 &
LOGCAT_PID=$!
adb_device shell am start -W \
  -a android.intent.action.VIEW \
  -d "zeroagent://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${METRO_PORT}" \
  "$PACKAGE" > "$ARTIFACT_DIR/launch.txt"

STAGE="launch readiness"
for _ in $(seq 1 90); do
  timeout 10 maestro --no-ansi hierarchy --compact \
    > "$ARTIFACT_DIR/launch-hierarchy.txt" 2>&1 || true
  if grep -Eq 'text=Browse|accessibilityText=Browse' "$ARTIFACT_DIR/launch-hierarchy.txt"; then
    break
  fi
  sleep 2
done
if ! grep -Eq 'text=Browse|accessibilityText=Browse' "$ARTIFACT_DIR/launch-hierarchy.txt"; then
  echo 'The development client did not load the app bundle' >> "$ARTIFACT_DIR/metro.log"
  exit 1
fi

STAGE="maestro flow"
verbose "running Maestro flow"
MAESTRO_COMMAND=(
  maestro --no-ansi test "$HERMETIC_FLOW_DIR"
  --format junit
  --output "$ARTIFACT_DIR/maestro/report.xml"
  --debug-output "$ARTIFACT_DIR/maestro"
)
if [[ "${E2E_VERBOSE:-0}" == "1" ]]; then
  set +e
  "${MAESTRO_COMMAND[@]}" 2>&1 | tee "$ARTIFACT_DIR/maestro.log"
  maestro_code=${PIPESTATUS[0]}
  set -e
else
  set +e
  "${MAESTRO_COMMAND[@]}" > "$ARTIFACT_DIR/maestro.log" 2>&1
  maestro_code=$?
  set -e
fi
if [[ "$maestro_code" -ne 0 ]]; then exit "$maestro_code"; fi

capture_diagnostics

STAGE="postcondition"
tasks_response=""
projects_response=""
for _ in $(seq 1 30); do
  tasks_response="$(curl -fsS "http://localhost:$WORKER_PORT/api/tasks" -H 'Authorization: Bearer e2e-test-user' 2>/dev/null || true)"
  projects_response="$(curl -fsS "http://localhost:$WORKER_PORT/api/projects" -H 'Authorization: Bearer e2e-test-user' 2>/dev/null || true)"
  if jq -e --arg text "$TASK_TEXT" \
      '.tasks | length == 1 and .[0].text == $text' \
      <<< "$tasks_response" >/dev/null 2>&1 \
    && jq -e --arg title "$PROJECT_TITLE" --arg description "$PROJECT_DESCRIPTION" \
      '.projects | length == 1 and .[0].title == $title and .[0].description == $description' \
      <<< "$projects_response" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
printf '%s\n' "$tasks_response" > "$ARTIFACT_DIR/worker-tasks-postcondition.json"
printf '%s\n' "$projects_response" > "$ARTIFACT_DIR/worker-projects-postcondition.json"
if ! jq -e --arg text "$TASK_TEXT" \
    '.tasks | length == 1 and .[0].text == $text' \
    <<< "$tasks_response" >/dev/null; then
  exit 1
fi
if ! jq -e --arg title "$PROJECT_TITLE" --arg description "$PROJECT_DESCRIPTION" \
    '.projects | length == 1 and .[0].title == $title and .[0].description == $description' \
    <<< "$projects_response" >/dev/null; then
  exit 1
fi

STAGE="storage isolation"
adb_device shell am force-stop "$PACKAGE" >/dev/null
production_checksums > "$ARTIFACT_DIR/production-after.txt"
if ! cmp -s "$ARTIFACT_DIR/production-before.txt" "$ARTIFACT_DIR/production-after.txt"; then
  {
    echo 'Production database checksums changed:'
    diff -u "$ARTIFACT_DIR/production-before.txt" "$ARTIFACT_DIR/production-after.txt" || true
  } > "$ARTIFACT_DIR/storage-check.txt"
  exit 1
fi

SUCCESS=1
