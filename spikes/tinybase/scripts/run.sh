#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="zero-tinybase-proof-$$"
TEMP="$(mktemp -d -t zero-tinybase-proof.XXXXXX)"
PORT=8787
cleanup() {
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ "${PROOF_KEEP_ARTIFACTS:-0}" == "1" ]]; then
    echo "Proof artifacts: $TEMP"
  else
    rm -rf "$TEMP"
  fi
}
trap cleanup EXIT

if ss -H -ltn "sport = :$PORT" | grep -q .; then
  echo "Port $PORT is occupied; stop the other Worker before running the proof." >&2
  exit 1
fi

start_worker() {
  podman run -d --rm --name "$NAME" --network host \
    -v "$ROOT:/app" -v "$TEMP/persist:/persist" -w /app \
    node:22-slim ./node_modules/.bin/wrangler dev \
      --persist-to /persist --ip 0.0.0.0 --port "$PORT" \
    > /dev/null
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  podman logs "$NAME" >&2 || true
  echo 'Worker did not start' >&2
  exit 1
}

mkdir -p "$TEMP/persist"
start_worker
PROOF_RESULT_PATH="$TEMP/result.json" "$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/proof.ts"
podman stop -t 10 "$NAME" >/dev/null
start_worker
STATE="$(curl -fsS "http://127.0.0.1:$PORT/api/state" -H 'Authorization: Bearer proof-user-a')"
jq -e --arg project "$(jq -r .projectId "$TEMP/result.json")" \
      --arg task "$(jq -r .taskId "$TEMP/result.json")" \
      '.projects[$project].title == "REST project" and .tasks[$task].text == "edited while disconnected"' \
      <<< "$STATE" >/dev/null
echo 'PASS: Durable Object SQLite survived Worker restart.'
