# Installing pnpm in Docker Images

This document outlines different approaches to install pnpm in Docker images for this monorepo project.

## Why pnpm?

This project uses pnpm (specified in `package.json` as `"packageManager": "pnpm@10.21.0"`), which offers:
- Faster installations due to content-addressable storage
- Disk space efficiency through hard linking
- Strict dependency management
- Better monorepo support

## Approach 1: Using Corepack (Recommended)

Corepack is included with Node.js 16+ and is the official way to manage package managers.

```dockerfile
# Enable corepack and install pnpm
RUN corepack enable && corepack prepare pnpm@10.21.0 --activate
```

**Pros:**
- Official Node.js feature
- Respects `packageManager` field in package.json
- No additional downloads required
- Version consistency

**Cons:**
- Requires Node.js 16+

## Approach 2: Direct Installation Script

Install pnpm using the official installation script.

```dockerfile
# Install pnpm using the official installation script
RUN curl -fsSL https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -
ENV PATH="/root/.local/share/pnpm:$PATH"
```

**Pros:**
- Always gets the latest version
- Works with any Node.js version
- Direct from official source

**Cons:**
- Requires curl
- Additional network request
- Version might not match package.json

## Approach 3: NPM Global Install

Install pnpm via npm (not recommended but possible).

```dockerfile
RUN npm install -g pnpm@10.21.0
```

**Pros:**
- Simple and familiar
- Version control

**Cons:**
- Uses npm to install pnpm (defeats some benefits)
- Larger image size
- Not the official recommendation

## Implementation Status

✅ **Current Status**: The main Dockerfile (`./packages/agent-server/Dockerfile`) has been updated to use corepack with pnpm.

## Alternative Dockerfiles Created

1. **`Dockerfile.pnpm`** - Uses the installation script approach
2. **`Dockerfile.corepack`** - Uses corepack with automatic version detection
3. **`Dockerfile.monorepo`** - Multi-stage build for the entire monorepo

## Build Commands

```bash
# Build using the updated Dockerfile
docker build -t agent-server ./packages/agent-server

# Build using alternative approaches
docker build -f ./packages/agent-server/Dockerfile.pnpm -t agent-server-pnpm ./packages/agent-server
docker build -f ./packages/agent-server/Dockerfile.corepack -t agent-server-corepack ./packages/agent-server
docker build -f ./Dockerfile.monorepo -t monorepo-agent-server .
```

## Best Practices

1. **Use corepack** when possible for official support
2. **Pin pnpm version** to match your package.json
3. **Use `--frozen-lockfile`** in production builds
4. **Consider multi-stage builds** for monorepos to optimize image size
5. **Cache node_modules** appropriately by copying package.json first

## Troubleshooting

- If corepack is not available, fall back to the installation script
- Ensure the PATH includes pnpm when using manual installation
- For monorepos, consider workspace-aware installation strategies