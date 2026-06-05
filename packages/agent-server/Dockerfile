FROM node:22-bookworm-slim

# Pi's settings/resource loaders touch $HOME even when sessions live
# elsewhere; point them at a writable location.
ENV HOME=/tmp/pi-home

# Pi's global config root. Skills under /agent/skills/ are auto-discovered.
ENV PI_CODING_AGENT_DIR=/agent

# curl/ca-certificates for state restore + HTTPS interception.
# poppler-utils (pdftotext/pdftoppm/pdfinfo) for PDF attachments.
# git for cloning/reading GitHub repositories.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      poppler-utils && \
    rm -rf /var/lib/apt/lists/*

# Pi runs as a non-root user.
RUN useradd -m -u 1001 -s /bin/bash pi

# Google Workspace CLI. Musl-static build;
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

# GitHub CLI.
ARG GH_VERSION=2.93.0
ARG GH_SHA256_X86_64=02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0
ARG GH_SHA256_AARCH64=c55feb33684abba57e9909737340d5b39282257c0363e1edde6785ac4a413be7
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then GHARCH=amd64; EXPECTED="${GH_SHA256_X86_64}"; \
    elif [ "$ARCH" = "aarch64" ]; then GHARCH=arm64; EXPECTED="${GH_SHA256_AARCH64}"; \
    else echo "unsupported arch: $ARCH" >&2 && exit 1; fi && \
    TMPDIR=$(mktemp -d) && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GHARCH}.tar.gz" \
      -o "${TMPDIR}/gh.tar.gz" && \
    echo "${EXPECTED}  ${TMPDIR}/gh.tar.gz" | sha256sum -c - && \
    tar -xzf "${TMPDIR}/gh.tar.gz" -C "${TMPDIR}" && \
    install -m 0755 "${TMPDIR}/gh_${GH_VERSION}_linux_${GHARCH}/bin/gh" /usr/local/bin/gh && \
    rm -rf "${TMPDIR}"

# Web search and content extraction CLI. Ships a pi skill under skills/
# that the COPY block below merges into /agent/skills/.
ARG WEBSEARCH_VERSION=2.1.0
RUN npm install -g @juanibiapina/websearch@${WEBSEARCH_VERSION}

WORKDIR /app

# Strip workspace:* devDependencies (npm can't parse them) and install
# only runtime deps.
COPY package.json ./
RUN node -e "const p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));" \
 && npm install --omit=dev --no-audit --no-fund

COPY dist/ ./dist/

# /workspace is the single persisted tree (sessions + notes + pi's
# working files). /tmp/pi-home and /agent (PI_CODING_AGENT_DIR) also
# need to be writable by pi.
RUN mkdir -p /workspace/sessions /workspace/notes /workspace/attachments /workspace/repos /agent /tmp/pi-home && \
    chown -R pi:pi /workspace /agent /tmp/pi-home

# Git auth for the GitHub App installation token. The credential helper
# emits the sentinel $GH_TOKEN as the HTTP Basic password at git runtime;
# the worker's outbound proxy swaps it for the real token on egress to
# github.com. Lives in pi's HOME (/tmp/pi-home) as the global gitconfig.
RUN git config --file /tmp/pi-home/.gitconfig \
      credential."https://github.com".helper \
      '!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN}"; }; f' && \
    chown pi:pi /tmp/pi-home/.gitconfig

# SYSTEM.md replaces pi's default system prompt with Zero's.
# Pi discovers it at $PI_CODING_AGENT_DIR/SYSTEM.md.
COPY context/SYSTEM.md /agent/SYSTEM.md
RUN chown pi:pi /agent/SYSTEM.md

# Skills are auto-discovered by pi from $PI_CODING_AGENT_DIR/skills/.
# Add new skills under packages/agent-server/skills/<name>/SKILL.md.
# Skills bundled by npm packages (e.g. websearch) are merged in too.
COPY skills/ /agent/skills/
RUN cp -r /usr/local/lib/node_modules/@juanibiapina/websearch/skills/* /agent/skills/
RUN chown -R pi:pi /agent/skills

WORKDIR /workspace

# Entrypoint restores the state archive then exec's node as the unprivileged `pi` user.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
