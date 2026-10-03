#!/usr/bin/env bash
set -Eeuo pipefail

PROOF_PACKAGE="dev.juanibiapina.zeroagent"
PROOF_METRO_PORT="${E2E_METRO_PORT:-8098}"
PROOF_DIR="${E2E_ARTIFACT_ROOT:-/tmp/medicine-native-proof}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PROOF_DIR"
for command in adb maestro python3 jq rg; do command -v "$command" >/dev/null; done
if ! adb shell dumpsys package "$PROOF_PACKAGE" | rg 'DEBUGGABLE' >/dev/null; then
  echo 'Install the Zero Agent development APK on the test Pixel' >&2
  exit 1
fi
if ! adb shell run-as "$PROOF_PACKAGE" true >/dev/null 2>&1; then
  echo 'The development APK must allow debug storage access' >&2
  exit 1
fi
PROOF_IDLE_CONFIG="$(adb shell settings get global device_idle_constants | tr -d '\r')"
[[ "$PROOF_IDLE_CONFIG" =~ ^[a-zA-Z0-9_=,.:+-]*$ ]] || { echo 'Unsupported idle configuration' >&2; exit 1; }

cleanup() {
  adb shell cmd deviceidle unforce >/dev/null 2>&1 || true
  if [[ "$PROOF_IDLE_CONFIG" == null ]]; then
    adb shell settings delete global device_idle_constants >/dev/null 2>&1 || true
  else
    adb shell settings put global device_idle_constants "$PROOF_IDLE_CONFIG" >/dev/null 2>&1 || true
  fi
  adb shell am force-stop "$PROOF_PACKAGE" >/dev/null 2>&1 || true
}
PROOF_STAGE=prepare
trap 'printf "Native proof failed: %s; artifacts: %s\\n" "$PROOF_STAGE" "$PROOF_DIR" >&2' ERR
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
  adb shell run-as "$PROOF_PACKAGE" cat shared_prefs/medicine-reminders-v1.xml > "$PROOF_DIR/state.xml"
  python3 - "$PROOF_DIR/state.xml" > "$PROOF_DIR/state.json" <<'PY'
import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
value = root.find("string[@name='state']")
mute = root.find("boolean[@name='silentProof']")
print(json.dumps({'state': json.loads(value.text) if value is not None else {}, 'muted': mute is not None and mute.attrib['value'] == 'true'}))
PY
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
proof_taken() {
  adb shell cmd statusbar expand-notifications
  maestro --no-ansi hierarchy --compact > "$PROOF_DIR/shade.csv"
  local expand_point
  expand_point="$(python3 - "$PROOF_DIR/shade.csv" <<'PY'
import csv, re, sys
rows = list(csv.reader(open(sys.argv[1])))
nodes = {}
for row in rows:
    if len(row) != 4 or not row[0].isdigit(): continue
    attrs = dict(re.findall(r'([^;=]+)=([^;]*)(?:;|$)', row[2]))
    nodes[row[0]] = (row[3], {key.strip(): value for key, value in attrs.items()})
def inside(node, parent):
    while node in nodes:
        if node == parent: return True
        node = nodes[node][0]
    return False
if not any(attrs.get('text') == 'Taken' for parent, attrs in nodes.values()):
    for title, (parent, attrs) in nodes.items():
        if attrs.get('text') != 'E2E medicine': continue
        while parent in nodes:
            matches = [attrs for node, (owner, attrs) in nodes.items() if inside(node, parent) and attrs.get('resource-id') == 'android:id/expand_button']
            if matches:
                points = list(map(int, re.findall(r'\d+', matches[0]['bounds'])))
                print((points[0] + points[2]) // 2, (points[1] + points[3]) // 2)
                sys.exit(0)
            parent = nodes[parent][0]
PY
)"
  if [[ -n "$expand_point" ]]; then
    read -r proof_x proof_y <<< "$expand_point"
    adb shell input tap "$proof_x" "$proof_y"
  fi
  cat > "$PROOF_DIR/taken.yaml" <<EOF
appId: $PROOF_PACKAGE
---
- tapOn:
    text: Taken
    index: 0
EOF
  maestro --no-ansi test "$PROOF_DIR/taken.yaml" --debug-output "$PROOF_DIR/maestro" >> "$PROOF_DIR/maestro.log" 2>&1
  adb shell cmd statusbar collapse
  proof_state
  jq -e '.muted and (.state.receipts | any(.kind == "taken")) and (.state.scheduled | all(.kind != "alarm"))' "$PROOF_DIR/state.json" >/dev/null
}
proof_schedule() {
  proof_open
  proof_flow "$1" 'Alarm scheduled .*'
  proof_state
  jq -e '.muted and .state.workspace == "taskdo-workspace-medicine-proof.sqlite" and (.state.scheduled | any(.kind == "alarm"))' "$PROOF_DIR/state.json" >/dev/null
  PROOF_DEADLINE="$(python3 - "$PROOF_DIR/state.json" <<'PY'
import json, sys, datetime
state = json.load(open(sys.argv[1]))['state']
occurrence = next(item for item in state['scheduled'] if item['kind'] == 'alarm')
print(int(datetime.datetime.fromisoformat(occurrence['scheduledAt'].replace('Z', '+00:00')).timestamp()))
PY
)"
  proof_kill_react
}
proof_no_service() {
  adb shell dumpsys activity services "$PROOF_PACKAGE" > "$PROOF_DIR/services.txt"
  ! rg -q 'MedicineAlarmService' "$PROOF_DIR/services.txt"
}
proof_await_service() {
  while [[ "$(date +%s)" -lt "$((PROOF_DEADLINE + 35))" ]]; do
    adb shell dumpsys activity services "$PROOF_PACKAGE" > "$PROOF_DIR/services.txt"
    if rg -q 'MedicineAlarmService' "$PROOF_DIR/services.txt" && rg -q 'isForeground=true' "$PROOF_DIR/services.txt"; then return; fi
    sleep 2
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

PROOF_CASE="${E2E_NATIVE_PROOF_CASE:-all}"
[[ "$PROOF_CASE" == all || "$PROOF_CASE" == boot || "$PROOF_CASE" == handoffs ]] || { echo 'Use all, boot, or handoffs for E2E_NATIVE_PROOF_CASE' >&2; exit 1; }
if [[ "$PROOF_CASE" == all ]]; then
PROOF_STAGE=quiet-cancellation
proof_schedule 'Schedule native proof'
proof_taken
cp "$PROOF_DIR/state.json" "$PROOF_DIR/quiet-taken.json"
while [[ "$(date +%s)" -le "$((PROOF_DEADLINE + 3))" ]]; do proof_no_service; sleep 2; done
proof_import
printf 'PASS quiet Taken cancels the deadline with React absent\n'

PROOF_STAGE=idle-delivery
proof_schedule 'Schedule native proof'
# AlarmClock normally prevents deep idle close to its deadline. Shorten that
# test guard instead of changing the phone clock; restore it in cleanup.
if [[ "$PROOF_IDLE_CONFIG" == null || -z "$PROOF_IDLE_CONFIG" ]]; then
  adb shell settings put global device_idle_constants min_time_to_alarm=0
else
  adb shell settings put global device_idle_constants "$PROOF_IDLE_CONFIG,min_time_to_alarm=0"
fi
adb shell cmd deviceidle force-idle > "$PROOF_DIR/idle.txt"
proof_await_service
cp "$PROOF_DIR/services.txt" "$PROOF_DIR/idle-service.txt"
adb shell cmd deviceidle unforce >/dev/null
proof_taken
proof_no_service
proof_import
printf 'PASS exact delivery in idle after process death, Taken stops the service\n'
fi

if [[ "$PROOF_CASE" != handoffs ]]; then
# Reboot clears Android's scheduled alarms. Check that saved future reminders
# are restored when the phone starts again, without reopening the app.
PROOF_STAGE=reboot-restoration
adb shell dumpsys lock_settings | rg -q 'CredentialType: NONE' || { echo 'Reboot proof needs a test phone without a screen lock' >&2; exit 1; }
proof_schedule 'Schedule reboot proof'
adb reboot
for attempt in $(seq 1 120); do
  if adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | rg -q '^1$'; then break; fi
  sleep 2
done
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
proof_state
jq -e '.muted and (.state.scheduled | any(.kind == "alarm"))' "$PROOF_DIR/state.json" >/dev/null
cp "$PROOF_DIR/state.json" "$PROOF_DIR/reboot-restored.json"
while [[ "$(date +%s)" -lt "$((PROOF_DEADLINE - 5))" ]]; do
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard
  adb shell cmd statusbar expand-notifications
  maestro --no-ansi hierarchy --compact > "$PROOF_DIR/reboot-shade.csv"
  if rg -q 'text=Native proof only.*Alarm at' "$PROOF_DIR/reboot-shade.csv"; then break; fi
  sleep 1
done
rg -q 'text=Native proof only.*Alarm at' "$PROOF_DIR/reboot-shade.csv"
adb shell cmd statusbar collapse
printf 'PASS quiet notification is restored after reboot\n'
proof_no_service
proof_await_service
PROOF_STARTED_AT="$(date +%s)"
while [[ "$(date +%s)" -lt "$((PROOF_STARTED_AT + 75))" ]]; do
  if proof_no_service; then break; fi
  sleep 2
done
PROOF_STOPPED_AT="$(date +%s)"
proof_no_service
[[ "$PROOF_STOPPED_AT" -ge "$((PROOF_STARTED_AT + 55))" && "$PROOF_STOPPED_AT" -le "$((PROOF_STARTED_AT + 75))" ]]
printf 'PASS muted alarm service stops automatically after sixty seconds\n'
proof_taken
proof_no_service
proof_import
printf 'PASS reboot restores future delivery without starting playback at boot\n'
fi
PROOF_STAGE=undo-replay
proof_schedule 'Schedule native proof'
proof_open
proof_flow 'Check undone receipt replay' 'Undone receipt remains pending'
proof_state
jq -e '(.state.suppressed | length == 0) and (.state.scheduled | any(.kind == "alarm")) and (.state.receipts | all(.kind != "taken"))' "$PROOF_DIR/state.json" >/dev/null
proof_flow 'Clear native proof' 'Medicine proof cleared'
printf 'PASS replay after Undo rearms the pending native dose\n'

PROOF_STAGE=quiescence-race
proof_schedule 'Schedule native proof'
proof_open
proof_flow 'Check quiescence race' 'Quiescence race safe'
proof_state
jq -e '.state.quiesced and (.state.receipts | length == 0) and (.state.scheduled | length == 0)' "$PROOF_DIR/state.json" >/dev/null
proof_flow 'Clear native proof' 'Medicine proof cleared'
printf 'PASS checkpoint retains concurrent receipts and refuses late Taken\n'
printf 'Native proof artifacts: %s\n' "$PROOF_DIR"
