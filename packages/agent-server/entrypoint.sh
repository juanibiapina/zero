#!/usr/bin/env bash
# ============================================================================
# agent-server entrypoint
# ============================================================================
#
# Mount the user's R2 prefix at /mnt/agent-state via tigrisfs (as root),
# strip the R2 credentials from the environment, then exec node as the
# unprivileged `pi` user. All R2 envs are set by
# AgentContainer.refreshEnvVars in the worker.
#
# Privilege separation: tigrisfs daemonises with the AWS creds cached in
# its own address space. Because pi runs as a different user, it cannot
# read /proc/<tigrisfs_pid>/environ to recover them, and the unset below
# keeps them out of pi's own /proc/self/environ.
# ============================================================================

set -euo pipefail

MOUNT_POINT="/mnt/agent-state"
CF_CA_SRC="/etc/cloudflare/certs/cloudflare-containers-ca.crt"
CF_CA_DEST="/usr/local/share/ca-certificates/cloudflare-containers-ca.crt"

# Trust the Cloudflare MITM cert so HTTPS traffic intercepted by the
# Workers `outbound` handler (interceptHttps = true) round-trips cleanly.
# Cloudflare mounts the cert at runtime; install it before tigrisfs
# (which talks to R2 over HTTPS) and before node (which talks to
# Anthropic over HTTPS).
if [[ -f "${CF_CA_SRC}" ]]; then
  cp "${CF_CA_SRC}" "${CF_CA_DEST}"
  update-ca-certificates >/dev/null
  export NODE_EXTRA_CA_CERTS="${CF_CA_SRC}"
  echo "[entrypoint] installed Cloudflare container CA" >&2
else
  echo "[entrypoint] WARN: ${CF_CA_SRC} not found; HTTPS interception will fail" >&2
fi

echo "[entrypoint] mounting ${R2_BUCKET_NAME}:${R2_PREFIX} at ${MOUNT_POINT}" >&2

# Foreground (-f) wouldn't return; we want tigrisfs to daemonise so we
# can exec node afterwards. Run without -f and let it fork.
# `-o allow_other` lets the non-root pi user access the mount (combined
# with `user_allow_other` in /etc/fuse.conf, set in the Dockerfile).
tigrisfs \
  --endpoint "${R2_ENDPOINT}" \
  -o allow_other \
  "${R2_BUCKET_NAME}:${R2_PREFIX}" \
  "${MOUNT_POINT}"

# tigrisfs returns immediately after backgrounding; give the kernel a
# moment to wire up the FUSE mount before pi tries to read it.
sleep 1
mountpoint -q "${MOUNT_POINT}"

echo "[entrypoint] mounted ${MOUNT_POINT}" >&2

export AGENT_STATE_DIR="${MOUNT_POINT}"

# Scrub R2 credentials from the env before handing control to pi. The
# tigrisfs daemon already cached them in its own address space, so the
# mount keeps working; pi (running as a different user) cannot reach
# tigrisfs's /proc/<pid>/environ, and unsetting here keeps them out of
# pi's own /proc/self/environ.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
      R2_PARENT_ACCESS_KEY_ID R2_PARENT_SECRET_ACCESS_KEY

echo "[entrypoint] dropping privileges to pi (uid=1001)" >&2
exec setpriv \
  --reuid=pi --regid=pi --clear-groups --inh-caps=-all \
  -- node /app/dist/index.js
