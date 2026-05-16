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
      fuse3 \
      tini && \
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

# Entrypoint is a supervisor: mounts R2, drops privileges to `pi`, then
# drains in-flight pi turns on SIGTERM before unmounting tigrisfs so any
# JSONL writes flush to R2 before the container exits. tini (PID 1, set
# below) forwards signals to it. See entrypoint.sh for the full shutdown
# contract.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
