# Sourced by run-metro-e2e.sh; uses its device, artifact, and isolation helpers.

restore_launcher_aliases() {
  local name component command failed=0
  for name in Default Empty OneTask TwoTasks ThreeTasks FourPlusTasks; do
    component="$PACKAGE.MainActivityIcon$name"
    if grep -Fxq "enabledComponents: $component" "$ARTIFACT_DIR/launcher-before.txt"; then
      command=enable
    elif grep -Fxq "disabledComponents: $component" "$ARTIFACT_DIR/launcher-before.txt"; then
      command=disable
    else
      command=default-state
    fi
    if ! adb_device shell run-as "$PACKAGE" cmd package "$command" "$PACKAGE/$component" \
      >> "$ARTIFACT_DIR/launcher-restore.txt" 2>&1; then
      failed=1
    fi
  done
  return "$failed"
}

assert_launcher_icon() {
  local expected="$PACKAGE/.MainActivityIcon$1"
  local checkpoint="$2" attempts="${3:-1}" actual="" attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    actual="$(adb_device shell cmd package query-activities --components \
      -a android.intent.action.MAIN -c android.intent.category.LAUNCHER \
      -p "$PACKAGE" | tr -d '\r')"
    printf '%s\n' "$actual" > "$ARTIFACT_DIR/launcher-$checkpoint.txt"
    if [[ "$actual" == "$expected" ]]; then return 0; fi
    sleep 0.5
  done
  printf 'Expected %s at %s; resolved: %s\n' "$expected" "$checkpoint" "$actual" \
    | tee "$ARTIFACT_DIR/launcher-check.txt" >&2
  return 1
}

run_launcher_phase() {
  local action="$1" number="$2" foreground="$3" background="$4"
  local checkpoint="$action-$number"
  STAGE="launch launcher $checkpoint"
  if [[ "$action" == "ready" ]]; then
    adb_device shell am start -W -a android.intent.action.VIEW \
      -d "$METRO_DEEP_LINK" \
      "$PACKAGE" >> "$ARTIFACT_DIR/launch.txt"
  else
    adb_device shell am start -W -a android.intent.action.MAIN \
      -n "$PACKAGE/.MainActivity" >> "$ARTIFACT_DIR/launch.txt"
  fi
  STAGE="maestro launcher $checkpoint"
  maestro --no-ansi test "$PROOF_FLOW_DIR/launcher-icon-follows-home.yaml" \
    -e "ACTION=$action" -e "TASK_NUMBER=$number" \
    --format junit --output "$ARTIFACT_DIR/maestro/launcher-$checkpoint.xml" \
    --debug-output "$ARTIFACT_DIR/maestro/launcher-$checkpoint" \
    >> "$ARTIFACT_DIR/maestro.log" 2>&1
  STAGE="launcher foreground $checkpoint"
  if [[ -n "$foreground" ]]; then
    assert_launcher_icon "$foreground" "$checkpoint-foreground"
  fi
  adb_device shell input keyevent KEYCODE_HOME
  STAGE="launcher background $checkpoint"
  assert_launcher_icon "$background" "$checkpoint-background" 30
}

run_launcher_icon_proof() {
  local count remaining tasks_response="" projects_response="" other_tasks="" other_projects=""
  local icons=(Empty OneTask TwoTasks ThreeTasks FourPlusTasks FourPlusTasks)
  run_launcher_phase ready 0 '' Empty
  for count in 1 2 3 4 5; do
    run_launcher_phase add "$count" "${icons[$((count - 1))]}" "${icons[$count]}"
  done
  run_launcher_phase bind 0 FourPlusTasks FourPlusTasks
  # Complete four Tasks, then sign out with one remaining so the fresh guest's
  # checkmark proves that the account count cannot survive sign-out.
  for count in 1 2 3 4; do
    remaining=$((5 - count))
    run_launcher_phase complete "$count" "${icons[$((remaining + 1))]}" "${icons[$remaining]}"
  done
  run_launcher_phase sign-out 0 OneTask Empty

  STAGE="postcondition launcher proof"
  for count in $(seq 1 30); do
    tasks_response="$(curl -fsS "http://localhost:$WORKER_PORT/api/tasks" -H "Authorization: Bearer $ACCOUNT_A")"
    projects_response="$(curl -fsS "http://localhost:$WORKER_PORT/api/projects" -H "Authorization: Bearer $ACCOUNT_A")"
    other_tasks="$(curl -fsS "http://localhost:$WORKER_PORT/api/tasks" -H "Authorization: Bearer $ACCOUNT_B")"
    other_projects="$(curl -fsS "http://localhost:$WORKER_PORT/api/projects" -H "Authorization: Bearer $ACCOUNT_B")"
    if jq -e '.tasks | length == 1 and .[0].text == "E2E icon task 5"' <<< "$tasks_response" >/dev/null \
      && jq -e '.projects == []' <<< "$projects_response" >/dev/null \
      && jq -e '.tasks == []' <<< "$other_tasks" >/dev/null \
      && jq -e '.projects == []' <<< "$other_projects" >/dev/null; then break; fi
    sleep 1
  done
  printf '%s\n' "$tasks_response" > "$ARTIFACT_DIR/launcher-account-a-tasks.json"
  printf '%s\n' "$projects_response" > "$ARTIFACT_DIR/launcher-account-a-projects.json"
  printf '%s\n' "$other_tasks" > "$ARTIFACT_DIR/launcher-account-b-tasks.json"
  printf '%s\n' "$other_projects" > "$ARTIFACT_DIR/launcher-account-b-projects.json"
  jq -e '.tasks | length == 1 and .[0].text == "E2E icon task 5"' <<< "$tasks_response" >/dev/null
  jq -e '.projects == []' <<< "$projects_response" >/dev/null
  jq -e '.tasks == []' <<< "$other_tasks" >/dev/null
  jq -e '.projects == []' <<< "$other_projects" >/dev/null
}
