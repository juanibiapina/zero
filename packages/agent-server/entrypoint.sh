#!/usr/bin/env bash
# Mount each MOUNT_<n>_* group via tigrisfs, drop privileges to `pi`,
# exec node. Per-write durability comes from tigrisfs `--fsync-on-close`.
# Privilege separation keeps the per-mount creds (cached in tigrisfs's
# address space, root-owned) out of reach of pi. See docs/design.md
# § Persistence and § Secret Proxying.

set -euo pipefail

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

# Iterate the MOUNT_<n>_* env groups emitted by the worker's
# AgentContainer.refreshEnvVars. Each group is a complete tigrisfs
# invocation; the shell stays scope-agnostic so the worker can add or
# remove mounts without touching this file.
#
# Per-invocation AWS_* override scopes the creds to just one tigrisfs
# call. A future provider (e.g. user-configured S3) with different
# creds for one mount won't disturb the others.
#
# tigrisfs daemonises (the launcher blocks until the mount is ready,
# then exits leaving the daemon running). We don't track the PIDs.
#
# Flags rationale (verified by integration test; see docs/tech-debt.md
# "R2 persistence fix — verification history"):
#   -o allow_other         lets non-root pi access the mount, paired
#                          with `user_allow_other` in /etc/fuse.conf
#                          set in the Dockerfile.
#   --file-mode=0666       inodes are reported as uid=0 by tigrisfs;
#   --dir-mode=0777        without these the pi user (uid 1001) gets
#                          EACCES on writes and mkdir.
#   --fsync-on-close       close(2) blocks until R2 confirms; without
#                          it, pi's appendFileSync lands in writeback
#                          cache and is lost on idle eviction / crash.
for i in $(seq 1 "${MOUNT_COUNT}"); do
  name_var="MOUNT_${i}_NAME"
  point_var="MOUNT_${i}_POINT"
  endpoint_var="MOUNT_${i}_ENDPOINT"
  bucket_var="MOUNT_${i}_BUCKET"
  prefix_var="MOUNT_${i}_PREFIX"
  ak_var="MOUNT_${i}_ACCESS_KEY_ID"
  sk_var="MOUNT_${i}_SECRET_ACCESS_KEY"
  st_var="MOUNT_${i}_SESSION_TOKEN"

  name="${!name_var}"
  point="${!point_var}"

  log_json "mounting" "name=${name}" "bucket=${!bucket_var}" "prefix=${!prefix_var}" "mount_point=${point}"

  AWS_ACCESS_KEY_ID="${!ak_var}" \
  AWS_SECRET_ACCESS_KEY="${!sk_var}" \
  AWS_SESSION_TOKEN="${!st_var}" \
  tigrisfs \
    --endpoint "${!endpoint_var}" \
    --file-mode=0666 \
    --dir-mode=0777 \
    --fsync-on-close \
    -o allow_other \
    "${!bucket_var}:${!prefix_var}" \
    "${point}"

  # Defensive: fail loud rather than continue with a non-functional mount.
  if ! mountpoint -q "${point}"; then
    log_json "mount_failed" "name=${name}" "mount_point=${point}"
    exit 1
  fi

  log_json "mounted" "name=${name}" "mount_point=${point}"
done

# Privilege separation, per docs/design.md § Secret Proxying: mount
# credentials are consumed by tigrisfs (root) at mount time and then
# scrubbed from the env so the unprivileged `pi` user can't recover
# them via /proc/self/environ. tigrisfs has already cached them in its
# own root-owned address space, so the mounts keep working after the
# unset. Any future per-mount secret added to a MOUNT_<n>_* group must
# be added below for the pattern to hold — do NOT reach for sentinel
# substitution for these: tigrisfs computes SigV4 over the request
# body and a mid-flight byte swap on egress would invalidate the
# signature.
for i in $(seq 1 "${MOUNT_COUNT}"); do
  unset "MOUNT_${i}_ACCESS_KEY_ID" "MOUNT_${i}_SECRET_ACCESS_KEY" "MOUNT_${i}_SESSION_TOKEN"
done

# Restore the notes archive from the worker's R2 binding. A 404 or
# network error means no prior snapshot exists — start with an empty dir.
log_json "notes_restore"
curl -sfH "X-Clerk-User-Id: ${CLERK_USER_ID}" http://zero.worker/notes \
  | tar xz -C /local/notes 2>/dev/null || true
chown -R pi:pi /local/notes

log_json "drop_privileges" "user=pi" "uid=1001"

# Exec node as pi. SIGTERM reaches node directly (PID 1 via exec chain);
# node closes the listener and the platform tears down the rest.
exec setpriv \
  --reuid=pi --regid=pi --clear-groups --inh-caps=-all \
  -- node /app/dist/index.js
