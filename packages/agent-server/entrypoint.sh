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
