#!/usr/bin/env bash
# ============================================================================
# agent-server entrypoint (supervisor)
# ============================================================================
#
# Owns two child processes so we can shut down cleanly when Cloudflare
# sends SIGTERM (e.g. on deploy, scale-down, sleep):
#
#   1. tigrisfs (root) — backgrounded; provides the R2-backed FUSE mount.
#   2. node (pi user)  — forked via setpriv after privileges are dropped.
#
# On SIGTERM we signal node first so the agent-server can drain in-flight
# pi turns (it owns its own idle-wait inside `src/index.ts`). Only after
# node exits do we unmount tigrisfs, giving it a chance to flush dirty
# pages to R2 before its address space goes away. Without this ordering,
# the platform's default SIGTERM-to-all-processes truncates pi mid-reply
# and abandons unflushed JSONL writes.
#
# tini (PID 1, set in the Dockerfile ENTRYPOINT) reaps any zombies and
# forwards SIGTERM/SIGINT to this script.
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

# Run tigrisfs in foreground (-f) so we own its PID directly. Without -f
# it daemonises and we lose the handle, which means we can't wait on it
# during shutdown to confirm it flushed to R2 before we exit.
# `-o allow_other` lets the non-root pi user access the mount (combined
# with `user_allow_other` in /etc/fuse.conf, set in the Dockerfile).
# `--file-mode=0666 --dir-mode=0777` makes every inode in the mount
# world-writable. R2 has no notion of unix ownership; these flags only
# affect what permission bits the FUSE driver reports to the kernel.
# Without this, files tigrisfs creates are reported as uid=0 mode=0644
# and the unprivileged pi user gets EACCES on append. Pi's agent event
# queue silently swallows EACCES, so the reply still goes out but the
# JSONL write never happens — the failure mode that lost every write
# after the privsep split. We don't use --uid because tigrisfs's
# --setuid defaults to --uid, which would make tigrisfs itself drop
# root privileges — and tigrisfs needs root for the FUSE mount and is
# where the AWS creds live. Making files world-writable keeps tigrisfs
# at root while letting pi write through the mount.
# `--fsync-on-close` makes every close() block until R2 confirms the
# upload. Pi persists session entries via appendFileSync (open + write +
# close), so without this flag the writes land in tigrisfs's in-memory
# writeback cache and only reach R2 on a clean unmount. Cloudflare's
# Durable Object reset (triggered by code updates) terminates the
# container without honoring SIGTERM, so we can't rely on the supervisor
# unmount path alone — making each write synchronous is the durability
# guarantee. Trade-off: each session-entry write pays one R2 round-trip
# (pi writes 1-3 entries per turn, so ~hundreds of ms added per turn).
tigrisfs \
  --endpoint "${R2_ENDPOINT}" \
  --file-mode=0666 \
  --dir-mode=0777 \
  --fsync-on-close \
  -o allow_other \
  -f \
  "${R2_BUCKET_NAME}:${R2_PREFIX}" \
  "${MOUNT_POINT}" &
tigrisfs_pid=$!

# Wait up to ~5s for the kernel to wire up the FUSE mount. tigrisfs
# becomes a mountpoint only after it has authenticated with R2 and the
# kernel has accepted the FUSE descriptor. Polling beats `sleep 1`
# because (a) we exit as soon as it's actually ready, and (b) we fail
# loudly instead of silently continuing with no mount.
for _ in $(seq 1 50); do
  if mountpoint -q "${MOUNT_POINT}"; then
    break
  fi
  sleep 0.1
done
if ! mountpoint -q "${MOUNT_POINT}"; then
  log_json "mount_failed" "mount_point=${MOUNT_POINT}"
  kill -TERM "${tigrisfs_pid}" 2>/dev/null || true
  wait "${tigrisfs_pid}" 2>/dev/null || true
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

# Fork node as the unprivileged pi user. We background it so we can
# install the SIGTERM trap before waiting; otherwise the shell's
# foreground process would receive the signal directly and bypass our
# ordered drain.
setpriv \
  --reuid=pi --regid=pi --clear-groups --inh-caps=-all \
  -- node /app/dist/index.js &
node_pid=$!

# Ordered shutdown:
#   1. signal node → it stops accepting new HTTP requests and waits for
#      in-flight pi turns to finish (see src/index.ts).
#   2. wait for node to exit cleanly.
#   3. unmount tigrisfs so it flushes dirty pages to R2 before the
#      container's address space goes away.
#   4. wait for tigrisfs to exit.
#
# The drain is idempotent so it's safe whether the trap fires or node
# exits on its own.
shutdown_done=0
shutdown() {
  if [[ "${shutdown_done}" -eq 1 ]]; then
    return
  fi
  shutdown_done=1

  log_json "shutdown_begin"

  if kill -0 "${node_pid}" 2>/dev/null; then
    kill -TERM "${node_pid}" 2>/dev/null || true
    wait "${node_pid}" 2>/dev/null || true
  fi
  log_json "node_exited"

  # Plain `-u` is correct here because node has exited; no open fds.
  # `-z` only as defensive fallback in case of EBUSY (shouldn't happen).
  fusermount -u "${MOUNT_POINT}" 2>/dev/null \
    || fusermount -uz "${MOUNT_POINT}" 2>/dev/null \
    || umount -f "${MOUNT_POINT}" 2>/dev/null \
    || true
  log_json "tigrisfs_unmount_requested"

  wait "${tigrisfs_pid}" 2>/dev/null || true
  log_json "tigrisfs_exited"

  exit 0
}

trap shutdown TERM INT

# Block on node. `wait $pid` returns when node exits OR when a trapped
# signal fires (bash returns from `wait` to run the trap, then we fall
# through to the explicit `shutdown` below to cover both paths).
wait "${node_pid}" 2>/dev/null || true
shutdown
