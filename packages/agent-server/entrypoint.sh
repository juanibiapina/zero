#!/usr/bin/env bash
# ============================================================================
# agent-server entrypoint
# ============================================================================
#
# Mount the user's R2 prefix at /mnt/agent-state via tigrisfs, then exec
# node. All R2 envs are set by AgentContainer.refreshEnvVars in the
# worker.
# ============================================================================

set -euo pipefail

MOUNT_POINT="/mnt/agent-state"

echo "[entrypoint] mounting ${R2_BUCKET_NAME}:${R2_PREFIX} at ${MOUNT_POINT}" >&2

# Foreground (-f) wouldn't return; we want tigrisfs to daemonise so we
# can exec node afterwards. Run without -f and let it fork.
tigrisfs \
  --endpoint "${R2_ENDPOINT}" \
  "${R2_BUCKET_NAME}:${R2_PREFIX}" \
  "${MOUNT_POINT}"

# tigrisfs returns immediately after backgrounding; give the kernel a
# moment to wire up the FUSE mount before pi tries to read it.
sleep 1
mountpoint -q "${MOUNT_POINT}"

echo "[entrypoint] mounted ${MOUNT_POINT}" >&2

export AGENT_STATE_DIR="${MOUNT_POINT}"
exec node /app/dist/index.js
