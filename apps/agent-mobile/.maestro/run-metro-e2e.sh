#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MOBILE_DIR="${REPO_ROOT}/apps/agent-mobile"
CRITICAL_FLOW_DIR="${MOBILE_DIR}/.maestro/critical"
PROOF_FLOW_DIR="${MOBILE_DIR}/.maestro/proofs"
PACKAGE="dev.juanibiapina.zeroagent"
METRO_PORT=8082
METRO_DEEP_LINK="zeroagent://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${METRO_PORT}"
WORKER_PORT=8787
ACCOUNT_A="e2e-account-a"
ACCOUNT_B="e2e-account-b"
GUEST_TASK_TEXT="E2E guest task"
SERVER_TASK_TEXT="E2E server task"
LAUNCHER_ICON_PROOF="${E2E_LAUNCHER_ICON_PROOF:-0}"
if [[ "$LAUNCHER_ICON_PROOF" != "0" && "$LAUNCHER_ICON_PROOF" != "1" ]]; then
  echo 'E2E_LAUNCHER_ICON_PROOF must be unset, "0", or "1"' >&2
  exit 1
fi
IMAGE="node:22-slim"
ARTIFACT_ROOT="${E2E_ARTIFACT_ROOT:-/tmp/zero-mobile-e2e}"
KEEP_FAILED_RUNS=10
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
ARTIFACT_DIR="${ARTIFACT_ROOT}/${RUN_ID}"
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/zero-mobile-e2e"
PERSIST_DIR="$(mktemp -d -t zero-mobile-e2e-worker.XXXXXX)"
CONTAINER="zero-mobile-e2e-${RUN_ID,,}"
CONTAINER="${CONTAINER//[^a-z0-9_.-]/-}"
STAGE="preflight"
STARTED_AT="$SECONDS"
TIMINGS=()
FLOW_COUNT=0
FAILED_FLOW=""
SUCCESS=0
DIAGNOSTICS_CAPTURED=0
PRODUCTION_SNAPSHOT_TAKEN=0
METRO_PID=""
WORKER_PID=""
SERIAL=""

mkdir -p "$ARTIFACT_DIR/maestro"
: > "$ARTIFACT_DIR/runner.log"
: > "$ARTIFACT_DIR/metro.log"
: > "$ARTIFACT_DIR/worker.log"
: > "$ARTIFACT_DIR/maestro.log"

verbose() {
  if [[ "${E2E_VERBOSE:-0}" == "1" ]]; then
    printf '[%s] %s\n' "$STAGE" "$*"
  fi
}

note() {
  printf '%s\n' "$*" >> "$ARTIFACT_DIR/runner.log"
}

duration() {
  local total="$1"
  if (( total >= 60 )); then
    printf '%dm%02ds' "$((total / 60))" "$((total % 60))"
  else
    printf '%ds' "$total"
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
  command='cd files/SQLite 2>/dev/null || exit 0; for f in taskdo-*.sqlite*; do [ -f "$f" ] || continue; case "$f" in taskdo-workspace-hermetic-e2e-guest.sqlite*|taskdo-fixture-e2e-account-a.sqlite*|taskdo-fixture-e2e-account-b.sqlite*|taskdo-workspace-medicine-proof.sqlite*) continue;; esac; sha256sum "$f"; done'
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

source "$MOBILE_DIR/.maestro/launcher-icon-proof.sh"

delete_e2e_stores() {
  local command
  command='rm -f files/SQLite/taskdo-workspace-hermetic-e2e-guest.sqlite* files/SQLite/taskdo-fixture-e2e-account-a.sqlite* files/SQLite/taskdo-fixture-e2e-account-b.sqlite* files/SQLite/taskdo-workspace-medicine-proof.sqlite*'
  adb_device shell "run-as $PACKAGE sh -c '$command'" >/dev/null 2>&1 || true
}

reset_marker_count() {
  grep -c 'zero-e2e: reset-' "$ARTIFACT_DIR/metro.log" || true
}

reset_e2e_phone_state() {
  local timeout="${1:-90}" before deadline resend_at=0
  before="$(reset_marker_count)"
  deadline=$((SECONDS + timeout))
  if ! adb_device shell pidof "$PACKAGE" >/dev/null 2>&1; then
    adb_device shell am start -W -a android.intent.action.VIEW \
      -d "$METRO_DEEP_LINK" "$PACKAGE" >/dev/null
  fi
  while (( SECONDS < deadline )); do
    if (( SECONDS >= resend_at )); then
      adb_device shell am start -W -a android.intent.action.VIEW \
        -d "zeroagent:///e2e-reset" "$PACKAGE" >/dev/null
      resend_at=$((SECONDS + 20))
    fi
    if (( $(reset_marker_count) > before )); then
      if grep 'zero-e2e: reset-' "$ARTIFACT_DIR/metro.log" | tail -1 | grep -q 'reset-done'; then
        adb_device shell am force-stop "$PACKAGE" >/dev/null
        # Once the app has closed SQLite, exact-file cleanup cannot match real
        # guest or account databases.
        delete_e2e_stores
        return 0
      fi
      note 'The app-owned hermetic state reset failed'
      return 1
    fi
    sleep 1
  done
  note "The app-owned hermetic state reset did not finish within ${timeout}s"
  return 1
}

capture_diagnostics() {
  if [[ "$DIAGNOSTICS_CAPTURED" == "1" ]]; then return; fi
  DIAGNOSTICS_CAPTURED=1
  set +e
  if [[ -n "$SERIAL" ]]; then
    timeout 15 adb -s "$SERIAL" exec-out screencap -p > "$ARTIFACT_DIR/screen.png" 2>/dev/null
    timeout 15 maestro --no-ansi hierarchy --compact > "$ARTIFACT_DIR/hierarchy.txt" 2>&1
    timeout 15 adb -s "$SERIAL" logcat -d -t 5000 > "$ARTIFACT_DIR/logcat.txt" 2>&1
  fi
  set -e
}

print_failure() {
  local screenshot="" log
  if [[ -n "$FAILED_FLOW" ]]; then
    printf 'FAIL: %s\n' "$FAILED_FLOW" >&2
    grep -E '^\[Failed\]' "$ARTIFACT_DIR/maestro.log" | tail -1 >&2 || true
    if [[ -d "$ARTIFACT_DIR/maestro/$FAILED_FLOW" ]]; then
      screenshot="$(find "$ARTIFACT_DIR/maestro/$FAILED_FLOW" -path '*/screenshots/*.png' | sort | tail -1)"
    fi
    [[ -n "$screenshot" ]] || screenshot="$ARTIFACT_DIR/screen.png"
    printf 'screenshot: %s\n' "$screenshot" >&2
  else
    printf 'FAIL: %s\n' "$STAGE" >&2
    case "$STAGE" in
      worker*) log=worker.log ;;
      metro*|launch*|phone*) log=metro.log ;;
      *) log="" ;;
    esac
    tail -5 "$ARTIFACT_DIR/runner.log" >&2 || true
    if [[ "$STAGE" == maestro* ]]; then
      grep -E '^\[Failed\]' "$ARTIFACT_DIR/maestro.log" | tail -1 >&2 || true
    fi
    if [[ -n "$log" ]]; then tail -10 "$ARTIFACT_DIR/$log" >&2 || true; fi
  fi
  printf 'artifacts: %s\n' "$ARTIFACT_DIR" >&2
}

prune_failed_runs() {
  find "$ARTIFACT_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +"$((KEEP_FAILED_RUNS + 1))" | cut -d' ' -f2- \
    | xargs -r rm -rf
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e

  if [[ "$SUCCESS" != "1" ]]; then capture_diagnostics; fi

  if [[ -n "$SERIAL" ]]; then
    adb_device shell am force-stop "$PACKAGE" >/dev/null 2>&1 || true
    if [[ "$LAUNCHER_ICON_PROOF" == "1" && -f "$ARTIFACT_DIR/launcher-before.txt" ]]; then
      if ! restore_launcher_aliases; then
        SUCCESS=0
        STAGE="launcher restoration"
        code=1
      fi
    fi
    if [[ "$PRODUCTION_SNAPSHOT_TAKEN" == "1" ]]; then
      production_checksums > "$ARTIFACT_DIR/production-after.txt" 2>/dev/null || true
      if ! cmp -s "$ARTIFACT_DIR/production-before.txt" "$ARTIFACT_DIR/production-after.txt"; then
        {
          echo 'Production database checksums changed:'
          diff -u "$ARTIFACT_DIR/production-before.txt" "$ARTIFACT_DIR/production-after.txt" || true
        } >> "$ARTIFACT_DIR/runner.log"
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
      note "Port $METRO_PORT or $WORKER_PORT is still listening"
      code=1
    fi
  fi

  if [[ -n "$SERIAL" && -f "$ARTIFACT_DIR/package-before.txt" ]]; then
    package_identity > "$ARTIFACT_DIR/package-after.txt" 2>/dev/null || true
    if ! cmp -s "$ARTIFACT_DIR/package-before.txt" "$ARTIFACT_DIR/package-after.txt"; then
      SUCCESS=0
      STAGE="dev-client identity"
      note 'The installed development client changed during the run'
      code=1
    fi
  fi
  if [[ -n "$SERIAL" && -f "$ARTIFACT_DIR/launcher-before.txt" ]]; then
    launcher_alias_state > "$ARTIFACT_DIR/launcher-after.txt" 2>/dev/null || true
    if ! cmp -s "$ARTIFACT_DIR/launcher-before.txt" "$ARTIFACT_DIR/launcher-after.txt"; then
      SUCCESS=0
      STAGE="launcher isolation"
      diff -u "$ARTIFACT_DIR/launcher-before.txt" "$ARTIFACT_DIR/launcher-after.txt" \
        >> "$ARTIFACT_DIR/runner.log" 2>&1
      code=1
    fi
  fi

  if [[ "$SUCCESS" == "1" && "$code" == "0" ]]; then
    local flow_label="flows" breakdown
    [[ "$FLOW_COUNT" == "1" ]] && flow_label="flow"
    breakdown="$(IFS=,; printf '%s' "${TIMINGS[*]}")"
    printf 'PASS: %s %s in %s (%s)\n' \
      "$FLOW_COUNT" "$flow_label" "$(duration $((SECONDS - STARTED_AT)))" "${breakdown//,/, }"
    rm -rf "$ARTIFACT_DIR"
    exit 0
  fi

  if [[ "$code" == "0" ]]; then code=1; fi
  print_failure
  prune_failed_runs
  exit "$code"
}
trap cleanup EXIT
trap 'STAGE="interrupted"; exit 130' INT TERM

for command in adb curl jq maestro node podman pnpm setsid sha256sum ss timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    note "Missing required command: $command"
    exit 1
  fi
done

mapfile -t PIXELS < <(adb devices -l | awk '$2 == "device" && /model:Pixel_7/ { print $1 }')
if [[ "${#PIXELS[@]}" -ne 1 ]]; then
  note "Expected exactly one connected Pixel 7; found ${#PIXELS[@]}"
  exit 1
fi
SERIAL="${PIXELS[0]}"
adb_device wait-for-device

if ! adb_device shell pm path "$PACKAGE" | grep -q '^package:'; then
  note "The Zero Agent package is not installed on the Pixel 7"
  exit 1
fi
if ! adb_device shell dumpsys package "$PACKAGE" | grep -q 'DEBUGGABLE'; then
  note "The installed Zero Agent package is not a development client"
  exit 1
fi
if ! adb_device shell "run-as $PACKAGE true" >/dev/null 2>&1; then
  note "The installed Zero Agent package does not allow debug storage isolation"
  exit 1
fi
link_handlers="$(adb_device shell cmd package query-activities --components \
  -a android.intent.action.VIEW -d 'zeroagent:///' | tr -d '\r' | grep -v "^$PACKAGE/" || true)"
if [[ -n "$link_handlers" ]]; then
  note "Another app handles zeroagent:// links and would open a chooser: $link_handlers"
  exit 1
fi
for port in "$METRO_PORT" "$WORKER_PORT"; do
  if port_is_listening "$port"; then
    note "Dedicated E2E port $port is already in use"
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
  -e COREPACK_HOME=/corepack \
  -v "$REPO_ROOT":/repo \
  -v zero-release-node-modules:/repo/node_modules \
  -v zero-release-pnpm-store:/pnpm-store \
  -v zero-e2e-corepack:/corepack \
  -v "$PERSIST_DIR":/persist \
  -w /repo \
  "$IMAGE" \
  bash -lc '
    set -e
    corepack enable
    stamp=/repo/node_modules/.zero-e2e-lockfile
    lockfile="$(sha256sum pnpm-lock.yaml | cut -d" " -f1)"
    if [ "$(cat "$stamp" 2>/dev/null)" != "$lockfile" ] \
      || [ ! -x apps/zero-api/node_modules/.bin/wrangler ]; then
      pnpm config set store-dir /pnpm-store
      CI=true pnpm install --frozen-lockfile
      printf "%s\n" "$lockfile" > "$stamp"
    fi
    cd apps/zero-api
    exec pnpm exec wrangler dev --config wrangler.e2e.jsonc \
      --persist-to /persist --ip 0.0.0.0 --port 8787
  ' > "$ARTIFACT_DIR/worker.log" 2>&1 &
WORKER_PID=$!

STAGE="metro startup"
verbose "starting hermetic Metro"
metro_cache_key="$(cat "$REPO_ROOT/pnpm-lock.yaml" "$MOBILE_DIR/metro.config.js" \
  "$MOBILE_DIR/babel.config.js" "$MOBILE_DIR/app.config.js" "$MOBILE_DIR/app.json" \
  | sha256sum | cut -c1-16)"
METRO_TMPDIR="$CACHE_ROOT/metro-$metro_cache_key"
mkdir -p "$METRO_TMPDIR"
find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'metro-*' \
  ! -path "$METRO_TMPDIR" -exec rm -rf {} +
CLERK_KEY="$(node -p "require('${MOBILE_DIR}/eas.json').build.development.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY")"
env -u EXPO_PUBLIC_API_URL \
  TMPDIR="$METRO_TMPDIR" \
  EXPO_PUBLIC_HERMETIC_E2E=1 \
  EXPO_PUBLIC_LAUNCHER_ICON_PROOF="$LAUNCHER_ICON_PROOF" \
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY="$CLERK_KEY" \
  EXPO_UNSTABLE_HEADLESS=1 \
  setsid bash -c '
    cd "$1"
    exec pnpm exec expo start --dev-client --localhost --port "$2"
  ' _ "$MOBILE_DIR" "$METRO_PORT" > "$ARTIFACT_DIR/metro.log" 2>&1 &
METRO_PID=$!

STAGE="worker readiness"
worker_code=""
for _ in $(seq 1 120); do
  worker_code="$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:$WORKER_PORT/api/tasks" 2>/dev/null || true)"
  [[ "$worker_code" == "401" ]] && break
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$worker_code" != "401" ]]; then
  note "Worker readiness returned ${worker_code:-no response}"
  exit 1
fi
for account in "$ACCOUNT_A" "$ACCOUNT_B"; do
  empty_tasks_response="$(curl -fsS "http://localhost:$WORKER_PORT/api/tasks" -H "Authorization: Bearer $account")"
  empty_projects_response="$(curl -fsS "http://localhost:$WORKER_PORT/api/projects" -H "Authorization: Bearer $account")"
  if ! jq -e '.tasks == []' <<< "$empty_tasks_response" >/dev/null \
    || ! jq -e '.projects == []' <<< "$empty_projects_response" >/dev/null; then
    note "Expected empty local state for $account; tasks=$empty_tasks_response projects=$empty_projects_response"
    exit 1
  fi
done
if [[ "$LAUNCHER_ICON_PROOF" == "0" ]]; then
  seed_body="$(jq -nc --arg id "$(cat /proc/sys/kernel/random/uuid)" --arg text "$SERVER_TASK_TEXT" '{id: $id, text: $text}')"
  curl -fsS -X POST "http://localhost:$WORKER_PORT/api/tasks" \
    -H "Authorization: Bearer $ACCOUNT_B" -H 'Content-Type: application/json' \
    -d "$seed_body" > "$ARTIFACT_DIR/seed-account-b.json"
fi

STAGE="metro readiness"
metro_status=""
for _ in $(seq 1 120); do
  metro_status="$(curl -fsS "http://localhost:$METRO_PORT/status" 2>/dev/null || true)"
  [[ "$metro_status" == *"packager-status:running"* ]] && break
  if ! kill -0 "$METRO_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$metro_status" != *"packager-status:running"* ]]; then
  note "Metro readiness returned ${metro_status:-no response}"
  exit 1
fi

STAGE="launch dev client"
adb_device reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT" >/dev/null
adb_device reverse "tcp:$WORKER_PORT" "tcp:$WORKER_PORT" >/dev/null
adb_device shell am start -W \
  -a android.intent.action.VIEW \
  -d "$METRO_DEEP_LINK" \
  "$PACKAGE" > "$ARTIFACT_DIR/launch.txt"

STAGE="launch readiness"
reset_e2e_phone_state 600
TIMINGS+=("startup $(duration $((SECONDS - STARTED_AT)))")

expected_worker_state() {
  case "$1" in
    todo-sync-and-accounts)
      printf '%s' '(.a.tasks | length == 1 and .[0].text == $guest) and (.b.tasks | length == 1 and .[0].text == $server)' ;;
    *)
      printf '%s' '(.a.tasks == []) and (.b.tasks | length == 1 and .[0].text == $server)' ;;
  esac
}

check_worker_state() {
  local flow_name="$1" filter state=""
  filter="$(expected_worker_state "$flow_name") and .a.projects == [] and .b.projects == []"
  for _ in $(seq 1 30); do
    state="$(jq -nc \
      --argjson at "$(curl -fsS "http://localhost:$WORKER_PORT/api/tasks" -H "Authorization: Bearer $ACCOUNT_A" 2>/dev/null || echo null)" \
      --argjson ap "$(curl -fsS "http://localhost:$WORKER_PORT/api/projects" -H "Authorization: Bearer $ACCOUNT_A" 2>/dev/null || echo null)" \
      --argjson bt "$(curl -fsS "http://localhost:$WORKER_PORT/api/tasks" -H "Authorization: Bearer $ACCOUNT_B" 2>/dev/null || echo null)" \
      --argjson bp "$(curl -fsS "http://localhost:$WORKER_PORT/api/projects" -H "Authorization: Bearer $ACCOUNT_B" 2>/dev/null || echo null)" \
      '{a: {tasks: $at.tasks, projects: $ap.projects}, b: {tasks: $bt.tasks, projects: $bp.projects}}')"
    if jq -e --arg guest "$GUEST_TASK_TEXT" --arg server "$SERVER_TASK_TEXT" "$filter" \
      <<< "$state" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf '%s\n' "$state" > "$ARTIFACT_DIR/$flow_name-worker-state.json"
  note "Worker state after $flow_name did not match: $state"
  return 1
}

if [[ "$LAUNCHER_ICON_PROOF" == "1" ]]; then
  FLOW_COUNT=1
  flow_started="$SECONDS"
  run_launcher_icon_proof
  TIMINGS+=("launcher proof $(duration $((SECONDS - flow_started)))")
else
  mapfile -t FLOWS < <(find "$CRITICAL_FLOW_DIR" -maxdepth 1 -type f -name '*.yaml' | sort)
  FLOW_COUNT="${#FLOWS[@]}"
  for index in "${!FLOWS[@]}"; do
    flow="${FLOWS[$index]}"
    flow_name="$(basename "$flow" .yaml)"
    if [[ "$index" -gt 0 ]]; then
      STAGE="phone reset before $flow_name"
      reset_e2e_phone_state
    fi

    STAGE="maestro $flow_name"
    verbose "running $flow_name"
    flow_started="$SECONDS"
    maestro_args=(--no-ansi test "$flow" -e "METRO_DEEP_LINK=$METRO_DEEP_LINK" --format junit
      --output "$ARTIFACT_DIR/maestro/$flow_name.xml"
      --debug-output "$ARTIFACT_DIR/maestro/$flow_name")
    set +e
    if [[ "${E2E_VERBOSE:-0}" == "1" ]]; then
      maestro "${maestro_args[@]}" 2>&1 | tee -a "$ARTIFACT_DIR/maestro.log"
      maestro_code=${PIPESTATUS[0]}
    else
      maestro "${maestro_args[@]}" >> "$ARTIFACT_DIR/maestro.log" 2>&1
      maestro_code=$?
    fi
    set -e
    if [[ "$maestro_code" -ne 0 ]]; then
      FAILED_FLOW="$flow_name"
      exit "$maestro_code"
    fi
    TIMINGS+=("$flow_name $(duration $((SECONDS - flow_started)))")

    STAGE="postcondition $flow_name"
    check_worker_state "$flow_name"
  done
fi

STAGE="storage isolation"
reset_e2e_phone_state
production_checksums > "$ARTIFACT_DIR/production-after.txt"
if ! cmp -s "$ARTIFACT_DIR/production-before.txt" "$ARTIFACT_DIR/production-after.txt"; then
  {
    echo 'Production database checksums changed:'
    diff -u "$ARTIFACT_DIR/production-before.txt" "$ARTIFACT_DIR/production-after.txt" || true
  } >> "$ARTIFACT_DIR/runner.log"
  exit 1
fi

SUCCESS=1
