---
title: Stale Container Image in Dev
category: devtools
tags: [docker, wrangler, containers, turbo, zero]
date: 2026-02-25
---

# Stale Container Image in Dev

## Problem

`wrangler dev` builds the Docker container image once at startup from `dist/`. If the agent-server TypeScript source changes but `dist/` isn't recompiled, or if the Docker image isn't rebuilt, the container runs stale code. This manifests as:
- Container crashes with bizarre exit codes (millions — not normal Unix codes)
- API endpoint mismatches between worker and container
- Silent behavior changes that are hard to diagnose

## Root Cause

`@zero/agent-server` had no `dev` script and no turbo dependency linking it to `@zero/api`. During `pnpm turbo dev`:
1. Turbo didn't build agent-server before starting wrangler dev
2. Turbo didn't run a watch for agent-server
3. Result: `dist/` could be stale → Docker image built from stale code

## Solution

Two turbo config changes:

1. **`turbo.json`**: Added `@zero/api#dev` task with `dependsOn: ["@zero/agent-server#build"]` — ensures agent-server is compiled before wrangler dev builds the Docker image.

2. **`zero/agent-server/package.json`**: Added `"dev": "tsc --watch --preserveWatchOutput"` — keeps `dist/` in sync during development. After code changes, a `gob restart` picks up the fresh dist/.

## Key Insight

`wrangler dev` with containers only builds the Docker image at startup. There is no hot-reload for container code. The developer must restart the dev server after agent-server changes. The turbo dependency ensures the restart always produces a fresh image.
