#!/usr/bin/env bash
set -Eeuo pipefail

PROOF_PACKAGE="dev.juanibiapina.zeroagent"
PROOF_METRO_PORT="${E2E_METRO_PORT:-8098}"
PROOF_DIR="${E2E_ARTIFACT_ROOT:-/tmp/medicine-native-proof}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PROOF_DIR"
for command in adb maestro python3 jq rg; do command -v "$command" >/dev/null; done
adb shell dumpsys package "$PROOF_PACKAGE" | rg 'DEBUGGABLE' >/dev/null
adb shell run-as "$PROOF_PACKAGE" true >/dev/null
PROOF_IDLE_CONFIG="$(adb shell settings get global device_idle_constants | tr -d '\r')"
PROOF_BATTERY_SAVER="$(adb shell settings get global low_power | tr -d '\r')"
[[ "$PROOF_IDLE_CONFIG" =~ ^[a-zA-Z0-9_=,.:+-]*$ ]]
[[ "$PROOF_BATTERY_SAVER" =~ ^(null|0|1)$ ]]
PROOF_STAGE=prepare
cleanup() {
  adb shell cmd deviceidle unforce >/dev/null 2>&1 || true
  adb shell cmd battery reset >/dev/null 2>&1 || true
  adb shell cmd power set-mode "$([[ "$PROOF_BATTERY_SAVER" == 1 ]] && echo 1 || echo 0)" >/dev/null 2>&1 || true
  if [[ "$PROOF_IDLE_CONFIG" == null ]]; then
    adb shell settings delete global device_idle_constants >/dev/null 2>&1 || true
  else
    adb shell settings put global device_idle_constants "$PROOF_IDLE_CONFIG" >/dev/null 2>&1 || true
  fi
  adb shell am force-stop "$PROOF_PACKAGE" >/dev/null 2>&1 || true
}
trap 'printf "Native proof failed: %s; artifacts: %s\n" "$PROOF_STAGE" "$PROOF_DIR" >&2' ERR
trap cleanup EXIT
adb shell pm grant "$PROOF_PACKAGE" android.permission.POST_NOTIFICATIONS
adb shell appops set "$PROOF_PACKAGE" SCHEDULE_EXACT_ALARM allow

proof_flow() {
  local action="$1" expected="$2"
  cat > "$PROOF_DIR/action.yaml" <<EOF
appId: $PROOF_PACKAGE
---
- extendedWaitUntil:
    visible: "$action"
    timeout: 45000
- tapOn: "$action"
- extendedWaitUntil:
    visible: "$expected"
    timeout: 30000
EOF
  maestro --no-ansi test "$PROOF_DIR/action.yaml" --debug-output "$PROOF_DIR/maestro" >> "$PROOF_DIR/maestro.log" 2>&1
}
proof_open() {
  adb shell cmd statusbar collapse
  adb shell am force-stop "$PROOF_PACKAGE"
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard
  adb reverse "tcp:$PROOF_METRO_PORT" "tcp:$PROOF_METRO_PORT" >/dev/null
  adb shell am start -W -a android.intent.action.VIEW -d "zeroagent://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${PROOF_METRO_PORT}" "$PROOF_PACKAGE" >/dev/null
  for attempt in $(seq 1 20); do
    if [[ "$attempt" == 2 ]]; then
      adb shell am start -W -a android.intent.action.VIEW -d 'zeroagent:///e2e-medicine-proof' "$PROOF_PACKAGE" >/dev/null
    fi
    maestro --no-ansi hierarchy --compact > "$PROOF_DIR/hierarchy.txt"
    if rg -q 'accessibilityText=Schedule native proof.*enabled=true' "$PROOF_DIR/hierarchy.txt"; then return; fi
    if rg -q 'text=Home|text=Medicines' "$PROOF_DIR/hierarchy.txt"; then break; fi
    sleep 1
  done
  adb shell am start -W -a android.intent.action.VIEW -d 'zeroagent:///e2e-medicine-proof' "$PROOF_PACKAGE" >/dev/null
  for attempt in $(seq 1 20); do
    maestro --no-ansi hierarchy --compact > "$PROOF_DIR/hierarchy.txt"
    if rg -q 'accessibilityText=Schedule native proof.*enabled=true' "$PROOF_DIR/hierarchy.txt"; then return; fi
    sleep 1
  done
  return 1
}
proof_state() {
  adb shell run-as "$PROOF_PACKAGE" cat no_backup/zero-notifications.json > "$PROOF_DIR/state-file.json" 2>/dev/null || : > "$PROOF_DIR/state-file.json"
  local muted=false
  if adb shell run-as "$PROOF_PACKAGE" ls no_backup/zero-notifications-silent >/dev/null 2>&1; then muted=true; fi
  jq -n --argjson muted "$muted" --rawfile raw "$PROOF_DIR/state-file.json" \
    '{state: (if ($raw | length) > 0 then ($raw | fromjson) else {} end), muted: $muted}' > "$PROOF_DIR/state.json"
}
proof_kill_react() {
  adb shell input keyevent KEYCODE_HOME
  local proof_pid
  proof_pid="$(adb shell pidof "$PROOF_PACKAGE" | tr -d '\r')"
  [[ "$proof_pid" =~ ^[0-9]+$ ]]
  adb shell run-as "$PROOF_PACKAGE" kill -9 "$proof_pid"
  for attempt in $(seq 1 20); do
    if ! adb shell pidof "$PROOF_PACKAGE" >/dev/null; then return; fi
    sleep 0.2
  done
  return 1
}
proof_schedule() {
  proof_open
  proof_flow "$1" 'Notifications scheduled .*'
  proof_state
  jq -e '.muted and .state.workspace == "taskdo-workspace-medicine-proof.sqlite" and (.state.alarms | any(.wake == "alarmClock"))' "$PROOF_DIR/state.json" >/dev/null
  PROOF_DEADLINE="$(jq -r '.state.alarms[] | select(.wake == "alarmClock") | .time / 1000' "$PROOF_DIR/state.json" | head -1)"
  PROOF_EARLY="$(jq -r '.state.alarms[] | select(.wake == "exact") | .time / 1000' "$PROOF_DIR/state.json" | head -1)"
  cp "$PROOF_DIR/state.json" "$PROOF_DIR/$PROOF_STAGE-scheduled.json"
  proof_kill_react
}
proof_no_playback() {
  adb shell dumpsys activity services "$PROOF_PACKAGE" > "$PROOF_DIR/services.txt"
  ! rg -q 'MedicineAlarmService' "$PROOF_DIR/services.txt"
}
proof_await_stage() {
  local kind="$1" deadline="$2" stage
  if [[ "$kind" == reminder ]]; then stage=0; else stage=1; fi
  while [[ "$(date +%s)" -le "$((deadline + 30))" ]]; do
    proof_state
    if jq -e --argjson stage "$stage" '.state.cards | to_entries | any(.value.stage == $stage)' "$PROOF_DIR/state.json" >/dev/null; then
      adb logcat -d -s ZeroNotifications:I > "$PROOF_DIR/$PROOF_STAGE-$kind-logcat.txt"
      python3 - "$PROOF_DIR/$PROOF_STAGE-$kind-logcat.txt" "$stage" "$deadline" <<'PY'
import datetime, re, sys
stage, deadline = sys.argv[2], int(sys.argv[3])
for line in open(sys.argv[1]):
    match = re.search(r'notification_presented stage=(\w+) wake=\w+ scheduled=(\S+) delivered=(\S+) alert=true', line)
    if not match or match[1] != stage:
        continue
    scheduled, delivered = [datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() for v in match.group(2, 3)]
    if int(scheduled) == deadline and 0 <= delivered - scheduled <= 30:
        print(f'PASS stage {stage} delivered in {delivered - scheduled:.3f}s')
        sys.exit(0)
raise SystemExit('No on-time scheduled notification in native logs')
PY
      cp "$PROOF_DIR/state.json" "$PROOF_DIR/$PROOF_STAGE-$kind-delivered.json"
      proof_no_playback
      return
    fi
    sleep 2
  done
  return 1
}
proof_shade() {
  adb shell cmd statusbar collapse
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard
  adb shell cmd statusbar expand-notifications
  for attempt in $(seq 1 5); do
    maestro --no-ansi hierarchy --compact > "$PROOF_DIR/$PROOF_STAGE-shade.csv"
    if rg -q 'text=E2E medicine' "$PROOF_DIR/$PROOF_STAGE-shade.csv"; then return; fi
    sleep 0.5
  done
  return 1
}
proof_action_point() {
  python3 - "$PROOF_DIR/$PROOF_STAGE-shade.csv" "$1" <<'PY'
import csv, re, sys
nodes = {}
for row in csv.reader(open(sys.argv[1])):
    if len(row) == 4 and row[0].isdigit():
        attrs = {key.strip(): value for key, value in re.findall(r'([^;=]+)=([^;]*)(?:;|$)', row[2])}
        nodes[row[0]] = (row[3], attrs)
def inside(node, parent):
    while node in nodes:
        if node == parent:
            return True
        node = nodes[node][0]
    return False
for node, (parent, attrs) in nodes.items():
    if attrs.get('text') != 'E2E medicine':
        continue
    while parent in nodes:
        children = [attrs for key, (owner, attrs) in nodes.items() if inside(key, parent)]
        if sys.argv[2] == 'expand' and any(attrs.get('text') == 'Taken' for attrs in children):
            sys.exit(0)
        for child in children:
            matches = child.get('resource-id') == 'android:id/expand_button' if sys.argv[2] == 'expand' else child.get('text') == 'Taken'
            if matches:
                x1, y1, x2, y2 = map(int, re.findall(r'\d+', child['bounds']))
                print((x1 + x2) // 2, (y1 + y2) // 2)
                sys.exit(0)
        if any(child.get('resource-id') == 'android:id/expand_button' for child in children):
            sys.exit(0)
        parent = nodes[parent][0]
PY
}
proof_taken() {
  proof_shade
  local action_point proof_x proof_y
  for attempt in $(seq 1 5); do
    action_point="$(proof_action_point taken)"
    if [[ -n "$action_point" ]]; then break; fi
    action_point="$(proof_action_point expand)"
    if [[ -n "$action_point" ]]; then
      read -r proof_x proof_y <<< "$action_point"
      adb shell input tap "$proof_x" "$proof_y"
    fi
    sleep 0.5
    maestro --no-ansi hierarchy --compact > "$PROOF_DIR/$PROOF_STAGE-shade.csv"
  done
  action_point="$(proof_action_point taken)"
  [[ -n "$action_point" ]]
  read -r proof_x proof_y <<< "$action_point"
  adb shell input tap "$proof_x" "$proof_y"
  for attempt in $(seq 1 20); do
    proof_state
    if jq -e '.muted and (.state.receipts | any(.type == "settled"))' "$PROOF_DIR/state.json" >/dev/null; then
      adb shell cmd statusbar collapse
      return
    fi
    sleep 0.25
  done
  return 1
}
proof_import() {
  proof_open
  proof_flow 'Import medicine receipts' 'Persisted taken doses: 1.*'
  proof_state
  jq -e '(.state.receipts | length == 0) and .state.quiesced' "$PROOF_DIR/state.json" >/dev/null
  proof_flow 'Clear native proof' 'Medicine proof cleared'
}
proof_power_saving() {
  adb shell cmd battery unplug
  adb shell cmd power set-mode 1
  for attempt in $(seq 1 20); do
    adb shell dumpsys power > "$PROOF_DIR/$PROOF_STAGE-power.txt"
    if rg -q 'Battery Saver is currently: ON|mBatterySaverEnabled=true|mLowPowerModeEnabled=true' "$PROOF_DIR/$PROOF_STAGE-power.txt"; then break; fi
    sleep 0.25
  done
  rg -q 'Battery Saver is currently: ON|mBatterySaverEnabled=true|mLowPowerModeEnabled=true' "$PROOF_DIR/$PROOF_STAGE-power.txt"
  if [[ "${1:-}" == idle ]]; then
    if [[ "$PROOF_IDLE_CONFIG" == null || -z "$PROOF_IDLE_CONFIG" ]]; then
      adb shell settings put global device_idle_constants min_time_to_alarm=0
    else
      adb shell settings put global device_idle_constants "$PROOF_IDLE_CONFIG,min_time_to_alarm=0"
    fi
    for attempt in $(seq 1 20); do
      adb shell dumpsys deviceidle > "$PROOF_DIR/$PROOF_STAGE-idle-state.txt"
      if rg -q 'min_time_to_alarm=0$' "$PROOF_DIR/$PROOF_STAGE-idle-state.txt"; then break; fi
      sleep 0.25
    done
    rg -q 'min_time_to_alarm=0$' "$PROOF_DIR/$PROOF_STAGE-idle-state.txt"
    adb shell input keyevent KEYCODE_SLEEP
    for attempt in $(seq 1 5); do
      if adb shell cmd deviceidle force-idle > "$PROOF_DIR/$PROOF_STAGE-idle.txt"; then break; fi
      sleep 0.5
    done
    adb shell dumpsys deviceidle > "$PROOF_DIR/$PROOF_STAGE-idle-state.txt"
    rg -q 'mState=IDLE' "$PROOF_DIR/$PROOF_STAGE-idle-state.txt"
  fi
}

PROOF_CASE="${E2E_NATIVE_PROOF_CASE:-all}"
[[ "$PROOF_CASE" == all || "$PROOF_CASE" == remaining || "$PROOF_CASE" == finish || "$PROOF_CASE" == boot || "$PROOF_CASE" == handoffs || "$PROOF_CASE" == power ]]
if [[ "$PROOF_CASE" == all ]]; then
  PROOF_STAGE=early-taken-cancellation
  proof_schedule 'Schedule native proof'
  proof_await_stage reminder "$PROOF_EARLY"
  proof_taken
  jq -e '(.state.alarms | all(.wake != "alarmClock"))' "$PROOF_DIR/state.json" >/dev/null
  proof_no_playback
  proof_import
  printf 'PASS early Taken cancels the deadline with JavaScript absent\n'
fi
if [[ "$PROOF_CASE" == all || "$PROOF_CASE" == remaining || "$PROOF_CASE" == power ]]; then
  for saving in battery-and-idle battery; do
    PROOF_STAGE="$saving"
    proof_schedule 'Schedule both stages proof'
    if [[ "$saving" == battery-and-idle ]]; then proof_power_saving idle; else proof_power_saving; fi
    proof_await_stage reminder "$PROOF_EARLY"
    proof_await_stage alarm "$PROOF_DEADLINE"
    adb shell dumpsys notification > "$PROOF_DIR/$PROOF_STAGE-notifications.txt"
    rg -q "pkg=$PROOF_PACKAGE" "$PROOF_DIR/$PROOF_STAGE-notifications.txt"
    adb shell cmd deviceidle unforce >/dev/null
    adb shell cmd battery reset
    adb shell cmd power set-mode 0
    proof_shade
    rg -q 'dose due' "$PROOF_DIR/$PROOF_STAGE-shade.csv"
    proof_taken
    proof_import
  done
fi
if [[ "$PROOF_CASE" == all || "$PROOF_CASE" == remaining || "$PROOF_CASE" == boot ]]; then
  PROOF_STAGE=reboot-restoration
  adb shell dumpsys lock_settings | rg -q 'CredentialType: NONE' || { echo 'Reboot proof needs a test phone without a screen lock' >&2; exit 1; }
  proof_schedule 'Schedule reboot proof'
  adb reboot
  for attempt in $(seq 1 120); do
    if adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | rg -q '^1$'; then break; fi
    sleep 2
  done
  proof_state
  jq -e '.muted and (.state.alarms | any(.wake == "alarmClock"))' "$PROOF_DIR/state.json" >/dev/null
  cp "$PROOF_DIR/state.json" "$PROOF_DIR/reboot-restored.json"
  proof_await_stage alarm "$PROOF_DEADLINE"
  proof_taken
  proof_import
  printf 'PASS reboot restores deadline delivery without reopening the app\n'
fi
if [[ "$PROOF_CASE" == all || "$PROOF_CASE" == remaining || "$PROOF_CASE" == finish ]]; then
  PROOF_STAGE=independent-simultaneous-doses
  proof_schedule 'Schedule multiple doses proof'
  proof_await_stage reminder "$PROOF_EARLY"
  proof_taken
  jq -e '(.state.alarms | any(.wake == "alarmClock")) and (.state.settledHere | length == 1)' "$PROOF_DIR/state.json" >/dev/null
  proof_await_stage alarm "$PROOF_DEADLINE"
  adb shell cmd statusbar expand-notifications
  maestro --no-ansi hierarchy --compact > "$PROOF_DIR/multiple-shade.csv"
  rg -q 'text=E2E second medicine' "$PROOF_DIR/multiple-shade.csv"
  proof_import
  printf 'PASS Taken leaves the other simultaneous dose scheduled\n'
fi
if [[ "$PROOF_CASE" == all || "$PROOF_CASE" == remaining || "$PROOF_CASE" == finish || "$PROOF_CASE" == handoffs || "$PROOF_CASE" == boot ]]; then
  PROOF_STAGE=undo-replay
  proof_schedule 'Schedule reboot proof'
  proof_open
  proof_flow 'Check undone receipt replay' 'Undone receipt remains pending'
  proof_state
  jq -e '(.state.settledHere | length == 0) and (.state.alarms | any(.wake == "alarmClock")) and (.state.receipts | all(.type != "settled"))' "$PROOF_DIR/state.json" >/dev/null
  proof_flow 'Clear native proof' 'Medicine proof cleared'
  printf 'PASS replay after Undo rearms the pending native dose\n'
  PROOF_STAGE=quiescence-race
  proof_schedule 'Schedule reboot proof'
  proof_open
  proof_flow 'Check quiescence race' 'Quiescence race safe'
  proof_state
  jq -e '.state.quiesced and (.state.receipts | length == 0) and (.state.alarms | length == 0)' "$PROOF_DIR/state.json" >/dev/null
  proof_flow 'Clear native proof' 'Medicine proof cleared'
  printf 'PASS checkpoint retains concurrent receipts and refuses late Taken\n'
fi
printf 'Native proof artifacts: %s\n' "$PROOF_DIR"
