#!/usr/bin/env bash
# Install Cloudflare's MITM CA, restore the /workspace state archive,
# drop privileges to `pi`, exec node. Persistence is a single compressed
# archive of /workspace stored at <clerkUserId>/state.tar.gz, restored on
# boot and saved on agent_end / SIGTERM. See docs/design.md § Persistence.

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
# be installed before node makes HTTPS calls (Anthropic API-key swap).
if [[ -f "${CF_CA_SRC}" ]]; then
  cp "${CF_CA_SRC}" "${CF_CA_DEST}"
  update-ca-certificates >/dev/null
  export NODE_EXTRA_CA_CERTS="${CF_CA_SRC}"
  log_json "installed_cloudflare_ca"
else
  log_json "missing_cloudflare_ca" "path=${CF_CA_SRC}" "note=HTTPS interception will fail"
fi

# Restore the /workspace archive from the worker's R2 binding. A 404 or
# network error means no prior snapshot exists — start with an empty tree.
log_json "state_restore"
curl -sfH "X-Clerk-User-Id: ${CLERK_USER_ID}" http://zero.worker/state \
  | tar xz -C /workspace 2>/dev/null || true
chown -R pi:pi /workspace

# Bootstrap the Google CLI credential stores. The badlogic clients
# (gmcli/gccli/gdcli) read ~/.<tool>/accounts.json and send the
# accessToken verbatim as `Authorization: Bearer ...`. With no
# expiry_date the OAuth client never refreshes, so the sentinel reaches
# egress unmodified and the worker's proxy swaps it for the real token.
# The token sentinel is omitted entirely when Google isn't connected, so
# both vars present == Google connected. Files live in pi's non-persistent
# HOME, rewritten fresh each cold start.
if [[ -n "${GOOGLE_WORKSPACE_CLI_TOKEN:-}" && -n "${GOOGLE_ACCOUNT_EMAIL:-}" ]]; then
  accounts_json=$(cat <<EOF
[{"email":"${GOOGLE_ACCOUNT_EMAIL}","oauth2":{"clientId":"injected","clientSecret":"injected","refreshToken":"none","accessToken":"${GOOGLE_WORKSPACE_CLI_TOKEN}"}}]
EOF
)
  for tool in gmcli gccli gdcli; do
    mkdir -p "/tmp/pi-home/.${tool}"
    printf '%s\n' "${accounts_json}" > "/tmp/pi-home/.${tool}/accounts.json"
  done
  chown -R pi:pi /tmp/pi-home/.gmcli /tmp/pi-home/.gccli /tmp/pi-home/.gdcli
  log_json "google_accounts_bootstrapped" "email=${GOOGLE_ACCOUNT_EMAIL}"
else
  log_json "google_not_connected" "note=skipping Google CLI bootstrap"
fi

log_json "drop_privileges" "user=pi" "uid=1001"

# Exec node as pi. SIGTERM reaches node directly (PID 1 via exec chain);
# node closes the listener and the platform tears down the rest.
exec setpriv \
  --reuid=pi --regid=pi --clear-groups --inh-caps=-all \
  -- node /app/dist/index.js
