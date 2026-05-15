FROM node:22-bookworm-slim

# Pi writes session state and config under HOME by default. Even though we
# pass an in-memory SessionManager, several pi internals still touch the
# filesystem (settings loader, resource loader). Point them at /tmp so
# nothing leaks into a non-writable layer.
ENV HOME=/tmp/pi-home

WORKDIR /app

# Install runtime deps. pnpm uses `workspace:*` in devDependencies, which
# npm can't parse. Strip devDependencies and install only what's in
# `dependencies` — the actual runtime surface.
COPY package.json ./
RUN node -e "const p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));" \
 && npm install --omit=dev --no-audit --no-fund

COPY dist/ ./dist/

# Working dir pi exposes to its tools (read/write/bash/edit).
RUN mkdir -p /workspace /tmp/pi-home
WORKDIR /workspace

EXPOSE 8080

CMD ["node", "/app/dist/index.js"]
