# Tech Debt

Tracked shortcuts, workarounds, and deferred improvements. When an entry
is resolved, delete it.

## Container image `npm install` is non-deterministic

**Where:** `packages/agent-server/Dockerfile`, the `RUN … npm install --omit=dev` step.

**What:** The image install resolves `@earendil-works/pi-coding-agent`
(and its transitive dependency graph) from npm at build time. There is no
lockfile inside the build context, so two builds run against different
registry state can produce different `node_modules`.

**Why it's like this:** pnpm uses `workspace:*` in our `devDependencies`,
which `npm` refuses to parse. The simplest workaround was to strip
`devDependencies` inside the Dockerfile and let `npm install` resolve the
runtime deps from scratch.

**Risk:** A transitive regression in pi-coding-agent (or anything it
pulls in) is picked up by the next container rebuild even if our code
didn't change.

**Fix when revisited:** copy a deterministic lockfile into the image
(e.g. a generated `package-lock.json` produced from the workspace
manifest), or pin `@earendil-works/pi-coding-agent` to an exact version
and commit a frozen lockfile alongside the Dockerfile.

## tigrisfs version is pinned manually

**Where:** `packages/agent-server/Dockerfile`, `ARG TIGRISFS_VERSION=...`.

**What:** The container downloads a specific tigrisfs `.deb` release
from GitHub. Cloudflare's example uses `latest`; we pin so two builds
produce the same binary.

**Risk:** Security fixes and reliability improvements only land when
someone bumps the `ARG`. There's no automated check.

**Fix when revisited:** wire a Renovate / Dependabot rule that watches
`tigrisdata/tigrisfs` releases and opens PRs to bump the `ARG`.

## R2 FUSE mount is unavailable in `wrangler dev`

**Where:** `packages/agent-server/entrypoint.sh`.

**What:** `wrangler dev` runs containers without the FUSE capabilities
`tigrisfs` needs to mount R2. Since the mount is mandatory (no
fallback), any local request that triggers a container start fails: the
entrypoint aborts and the worker sees a container error.

**Risk:** The container code path is unreachable from `wrangler dev`.
All container behaviour (pi loop, mount, persistence, resume) has to be
verified in deployed previews / production.

**Fix when revisited:** investigate whether `wrangler dev` gained a flag
to enable FUSE/privileged containers, or stand up a local minio +
remount-on-host harness for the integration test.
