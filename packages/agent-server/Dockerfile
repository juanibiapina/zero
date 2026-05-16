FROM node:22-bookworm-slim

# Pi writes session state and config under HOME by default. Even though we
# point pi at AGENT_STATE_DIR (the R2-backed mount) for sessions, several
# pi internals still touch the filesystem (settings loader, resource
# loader). Point those at /tmp so nothing leaks into a non-writable layer.
ENV HOME=/tmp/pi-home

# Install fuse3 + curl (for downloading tigrisfs and for the entrypoint
# script). ca-certificates is needed for HTTPS to R2.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fuse3 && \
    rm -rf /var/lib/apt/lists/*

# Non-root user that pi (and everything pi spawns) runs as. tigrisfs and
# the entrypoint shell continue to run as root so they can mount FUSE
# and so pi can't read tigrisfs's /proc/<pid>/environ to recover the R2
# credentials. `user_allow_other` lets pi access the root-owned mount
# via tigrisfs's `-o allow_other`.
RUN useradd -m -u 1001 -s /bin/bash pi && \
    echo 'user_allow_other' >> /etc/fuse.conf

# Pin tigrisfs to a known-good release. Bump deliberately when needed; see
# docs/tech-debt.md for the rationale (avoiding non-deterministic builds).
ARG TIGRISFS_VERSION=1.2.1
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then DEBARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then DEBARCH="arm64"; \
    else echo "unsupported arch: $ARCH" >&2 && exit 1; fi && \
    curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_${DEBARCH}.deb" \
      -o /tmp/tigrisfs.deb && \
    dpkg -i /tmp/tigrisfs.deb && \
    rm /tmp/tigrisfs.deb

# Install the Google Workspace CLI (`gws`). Pinned by version + per-arch
# SHA256. The musl-static build runs on debian without a libc dep. `gws`
# reads its OAuth token from $GOOGLE_WORKSPACE_CLI_TOKEN, so no on-disk
# credential file or login step is needed.
ARG GWS_VERSION=0.22.5
ARG GWS_SHA256_X86_64=4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920
ARG GWS_SHA256_AARCH64=e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then EXPECTED="${GWS_SHA256_X86_64}"; \
    elif [ "$ARCH" = "aarch64" ]; then EXPECTED="${GWS_SHA256_AARCH64}"; \
    else echo "unsupported arch: $ARCH" >&2 && exit 1; fi && \
    TMPDIR=$(mktemp -d) && \
    curl -fsSL "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-${ARCH}-unknown-linux-musl.tar.gz" \
      -o "${TMPDIR}/gws.tar.gz" && \
    echo "${EXPECTED}  ${TMPDIR}/gws.tar.gz" | sha256sum -c - && \
    tar -xzf "${TMPDIR}/gws.tar.gz" -C "${TMPDIR}" && \
    install -m 0755 "${TMPDIR}/gws" /usr/local/bin/gws && \
    rm -rf "${TMPDIR}"

WORKDIR /app

# Install runtime deps. pnpm uses `workspace:*` in devDependencies, which
# npm can't parse. Strip devDependencies and install only what's in
# `dependencies` \u2014 the actual runtime surface.
COPY package.json ./
RUN node -e "const p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));" \
 && npm install --omit=dev --no-audit --no-fund

COPY dist/ ./dist/

# Working dir pi exposes to its tools (read/write/bash/edit), plus the
# fixed mount point and the home directory pi falls back to. /workspace
# and /tmp/pi-home must be writable by the pi user; /mnt/agent-state
# stays root-owned (it's just the mount point — tigrisfs publishes it
# with `allow_other` so pi can still use it).
RUN mkdir -p /workspace /mnt/agent-state /tmp/pi-home && \
    chown -R pi:pi /workspace /tmp/pi-home
WORKDIR /workspace

# Entrypoint mounts R2 via tigrisfs and then exec's node as the
# unprivileged `pi` user. Per-write durability comes from tigrisfs
# `--fsync-on-close`; no explicit shutdown drain is needed.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
