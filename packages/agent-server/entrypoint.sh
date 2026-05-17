#!/usr/bin/env bash
# Mount R2 via tigrisfs, drop privileges to `pi`, exec node. Per-write
# durability comes from tigrisfs `--fsync-on-close`. Privilege separation
# keeps the R2 creds (cached in tigrisfs's address space, root-owned) out
# of reach of pi. See docs/design.md § Secret Proxying.

set -euo pipefail

MOUNT_POINT="/mnt/agent-state"
CF_CA_SRC="/etc/cloudflare/certs/cloudflare-containers-ca.crt"
CF_CA_DEST="/usr/local/share/ca-certificates/cloudflare-containers-ca.crt"

# Emit one structured log line on stderr matching the agent-server shape.
# Extra args are key=value pairs appended as JSON string fields.
log_json() {
  local msg="$1"; shift
  local extra=""
  for kv in "$@"; do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    # Escape backslashes and double quotes in the value.
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    extra+=",\"${key}\":\"${val}\""
  done
  printf '{"service":"agent-server","msg":"%s"%s}\n' "${msg}" "${extra}" >&2
}

# Trust Cloudflare's MITM cert so HTTPS traffic the Workers `outbound`
# handler intercepts (interceptHttps = true) round-trips cleanly. Must
# be installed before tigrisfs and node both make HTTPS calls.
if [[ -f "${CF_CA_SRC}" ]]; then
  cp "${CF_CA_SRC}" "${CF_CA_DEST}"
  update-ca-certificates >/dev/null
  export NODE_EXTRA_CA_CERTS="${CF_CA_SRC}"
  log_json "installed_cloudflare_ca"
else
  log_json "missing_cloudflare_ca" "path=${CF_CA_SRC}" "note=HTTPS interception will fail"
fi

log_json "mounting_r2" "bucket=${R2_BUCKET_NAME}" "prefix=${R2_PREFIX}" "mount_point=${MOUNT_POINT}"

# tigrisfs daemonises (the launcher blocks until the mount is ready, then
# exits leaving the daemon running). We don't track the PID and exec node
# next.
#
# `-o allow_other`: lets non-root pi access the mount (paired with
# `user_allow_other` in /etc/fuse.conf, set in the Dockerfile).
#
# `--file-mode=0666 --dir-mode=0777`: every inode in the mount is
# world-writable. tigrisfs reports inodes as uid=0; with the defaults
# (0600/0755) pi (uid 1001) gets EACCES on every write and on mkdir
# under the root. `--uid=1001` is not an alternative because
# tigrisfs's `--setuid` defaults to `--uid`, which would drop tigrisfs
# off root — but it needs root for the FUSE mount and to hold the AWS
# creds out of pi's reach. (Verified by the integration test:
# removing these flags makes the first createSession fail with 500.)
#
# `--fsync-on-close`: close(2) blocks until R2 confirms the upload.
# Without it, pi's appendFileSync writes land in tigrisfs's writeback
# cache and are lost on idle eviction / deploy / crash. (Verified:
# removing this makes the post-5min-idle integration-test turn time
# out because the cold-resumed container reads a stale JSONL.)
tigrisfs \
  --endpoint "${R2_ENDPOINT}" \
  --file-mode=0666 \
  --dir-mode=0777 \
  --fsync-on-close \
  -o allow_other \
  "${R2_BUCKET_NAME}:${R2_PREFIX}" \
  "${MOUNT_POINT}"

# Defensive: fail loud rather than continue with a non-functional mount.
if ! mountpoint -q "${MOUNT_POINT}"; then
  log_json "mount_failed" "mount_point=${MOUNT_POINT}"
  exit 1
fi

log_json "mounted_r2" "mount_point=${MOUNT_POINT}"

NOTES_MOUNT_POINT="/mnt/notes"
log_json "mounting_notes" "bucket=${MOUNT_NOTES_BUCKET}" "prefix=${MOUNT_NOTES_PREFIX}" "mount_point=${NOTES_MOUNT_POINT}"

# Per-invocation AWS_* override so a future notes-mount provider with
# different creds (e.g. user-configured S3) doesn't need entrypoint
# changes; today the values are the same temp creds as the sessions
# mount above.
AWS_ACCESS_KEY_ID="${MOUNT_NOTES_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${MOUNT_NOTES_SECRET_ACCESS_KEY}" \
AWS_SESSION_TOKEN="${MOUNT_NOTES_SESSION_TOKEN}" \
tigrisfs \
  --endpoint "${MOUNT_NOTES_ENDPOINT}" \
  --file-mode=0666 \
  --dir-mode=0777 \
  --fsync-on-close \
  -o allow_other \
  "${MOUNT_NOTES_BUCKET}:${MOUNT_NOTES_PREFIX}" \
  "${NOTES_MOUNT_POINT}"

if ! mountpoint -q "${NOTES_MOUNT_POINT}"; then
  log_json "mount_failed" "mount_point=${NOTES_MOUNT_POINT}"
  exit 1
fi

log_json "mounted_notes" "mount_point=${NOTES_MOUNT_POINT}"

export AGENT_STATE_DIR="${MOUNT_POINT}"

# Privilege separation, per docs/design.md § Secret Proxying: mount
# credentials are consumed by tigrisfs (root) at mount time and then
# scrubbed from the env so the unprivileged `pi` user can't recover
# them via /proc/self/environ. tigrisfs has already cached them in its
# own root-owned address space, so the mount keeps working after the
# unset. Any future `MOUNT_*_*` secret must be added below for the
# pattern to hold — do NOT reach for sentinel substitution for these:
# tigrisfs computes SigV4 over the request body and a mid-flight byte
# swap on egress would invalidate the signature.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
      R2_PARENT_ACCESS_KEY_ID R2_PARENT_SECRET_ACCESS_KEY \
      MOUNT_NOTES_ACCESS_KEY_ID MOUNT_NOTES_SECRET_ACCESS_KEY \
      MOUNT_NOTES_SESSION_TOKEN

log_json "drop_privileges" "user=pi" "uid=1001"

# Exec node as pi. SIGTERM reaches node directly (PID 1 via exec chain);
# node closes the listener and the platform tears down the rest.
exec setpriv \
  --reuid=pi --regid=pi --clear-groups --inh-caps=-all \
  -- node /app/dist/index.js
