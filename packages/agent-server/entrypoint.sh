#!/usr/bin/env bash
# ============================================================================
# agent-server entrypoint
# ============================================================================
#
# Mount R2 via tigrisfs, drop privileges to `pi`, then exec node. There is
# no supervisor or shutdown drain: per-write durability comes from
# tigrisfs `--fsync-on-close`, which makes every close(2) block until R2
# confirms the upload. By the time SIGTERM arrives, every session-entry
# pi has acknowledged is already on R2.
#
# Privilege separation: tigrisfs caches the AWS creds in its own address
# space; we `unset` them before exec'ing node as the unprivileged `pi`
# user via setpriv. /proc/<tigrisfs_pid>/environ is mode 0400 root, so
# pi cannot recover them by reading /proc.
# ============================================================================

set -euo pipefail

MOUNT_POINT="/mnt/agent-state"
CF_CA_SRC="/etc/cloudflare/certs/cloudflare-containers-ca.crt"
CF_CA_DEST="/usr/local/share/ca-certificates/cloudflare-containers-ca.crt"

# Emit a single JSON log line on stderr matching the agent-server log
# shape ({"service":"agent-server","msg":"...",...}). Args after `msg`
# are key=value pairs appended as JSON string fields.
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

# Trust the Cloudflare MITM cert so HTTPS traffic intercepted by the
# Workers `outbound` handler (interceptHttps = true) round-trips cleanly.
# Cloudflare mounts the cert at runtime; install it before tigrisfs
# (which talks to R2 over HTTPS) and before node (which talks to
# Anthropic over HTTPS).
if [[ -f "${CF_CA_SRC}" ]]; then
  cp "${CF_CA_SRC}" "${CF_CA_DEST}"
  update-ca-certificates >/dev/null
  export NODE_EXTRA_CA_CERTS="${CF_CA_SRC}"
  log_json "installed_cloudflare_ca"
else
  log_json "missing_cloudflare_ca" "path=${CF_CA_SRC}" "note=HTTPS interception will fail"
fi

log_json "mounting_r2" "bucket=${R2_BUCKET_NAME}" "prefix=${R2_PREFIX}" "mount_point=${MOUNT_POINT}"

# Without -f tigrisfs daemonises: the launcher process blocks until the
# mount is ready and then exits, leaving the daemon running in the
# background. That's what we want here \u2014 we don't track the PID and we
# exec node next.
# `-o allow_other` lets the non-root pi user access the mount (combined
# with `user_allow_other` in /etc/fuse.conf, set in the Dockerfile).
# `--file-mode=0666 --dir-mode=0777` makes every inode in the mount
# world-writable. Tigrisfs reports inodes as uid=0 by default; with
# the default modes (0600 files, 0755 dirs) the unprivileged pi user
# (uid 1001) gets EACCES on every write and even on mkdir under the
# mount root. Verified empirically: removing these flags makes
# `createSession` fail at `mkdirSync(/mnt/agent-state/<sessionId>)`
# and the agent-server returns 500 on the very first message
# (`create_session_failed` in the worker logs). `--uid=1001` is not
# an alternative because tigrisfs's `--setuid` defaults to `--uid`,
# which would make tigrisfs itself drop root privileges \u2014 and
# tigrisfs needs root for the FUSE mount and is where the AWS creds
# live. Making files world-writable keeps tigrisfs at root while
# letting pi write through the mount.
# `--fsync-on-close` makes every close() block until R2 confirms the
# upload. Pi persists session entries via appendFileSync (open + write +
# close), so without this flag the writes land in tigrisfs's in-memory
# writeback cache. With no supervisor unmounting on SIGTERM, dirty
# pages that haven't been flushed by writeback are simply lost when the
# container exits (idle eviction, deploy, crash). Verified empirically:
# removing this flag and running the session-persistence integration
# test makes turn 3 (post-5min-idle) time out because the cold-resumed
# container reads a stale JSONL missing turn 2's entries. Trade-off:
# each session-entry write pays one R2 round-trip (pi writes 1-3
# entries per turn, so ~hundreds of ms added per turn) in exchange for
# correctness across idle eviction.
tigrisfs \
  --endpoint "${R2_ENDPOINT}" \
  --file-mode=0666 \
  --dir-mode=0777 \
  --fsync-on-close \
  -o allow_other \
  "${R2_BUCKET_NAME}:${R2_PREFIX}" \
  "${MOUNT_POINT}"

# tigrisfs should have set up the mount before its launcher returned,
# but verify defensively so we fail loud rather than continuing with a
# non-functional mount.
if ! mountpoint -q "${MOUNT_POINT}"; then
  log_json "mount_failed" "mount_point=${MOUNT_POINT}"
  exit 1
fi

log_json "mounted_r2" "mount_point=${MOUNT_POINT}"

export AGENT_STATE_DIR="${MOUNT_POINT}"

# Scrub R2 credentials from the env before handing control to pi. The
# tigrisfs daemon already cached them in its own address space, so the
# mount keeps working; pi (running as a different user) cannot reach
# tigrisfs's /proc/<pid>/environ, and unsetting here keeps them out of
# pi's own /proc/self/environ.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
      R2_PARENT_ACCESS_KEY_ID R2_PARENT_SECRET_ACCESS_KEY

log_json "drop_privileges" "user=pi" "uid=1001"

# Exec node as the unprivileged pi user. No background, no trap \u2014
# SIGTERM goes directly to node (PID 1 via the exec chain), node closes
# the HTTP listener and exits, and the platform tears down the rest.
exec setpriv \
  --reuid=pi --regid=pi --clear-groups --inh-caps=-all \
  -- node /app/dist/index.js
