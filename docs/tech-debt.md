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

## R2 traffic still traverses the worker (one hop)

**Where:** `apps/api/src/AgentContainer.ts` (`outboundByHost["*.r2.cloudflarestorage.com"]`).

**What:** R2 is exempted from the substitution catch-all via a
pass-through `outboundByHost` glob, so we no longer buffer or scan R2
request bodies. But because `interceptHttps = true` plus a catch-all
handler forces intercept-all mode (which intercepts HTTPS via the `*`
pattern), even pass-through R2 traffic still round-trips through the
worker before reaching `<acct>.r2.cloudflarestorage.com`.

**Risk:** Latency on the FUSE mount under heavy session I/O — every
read/write/list pays one extra worker hop.

**Fix when revisited:** the only way to fully skip the hop is to drop
out of intercept-all mode, which means giving up the catch-all (and
therefore the generic substitution). If R2 latency becomes a real
problem, options are: (a) register every host that pi might call
statically in `outboundByHost` (per-host mode skips R2's HTTPS
interception entirely), or (b) move pi's Anthropic call through a
dedicated `outboundByHost["api.anthropic.com"]` and drop the catch-all.

## Secret-proxy only substitutes request bodies, not responses

**Where:** `apps/api/src/secret-proxy.ts`.

**What:** The handler substitutes fake → real on the way *out*. It
doesn't scrub the response on the way back. If an upstream ever echoes
the key (Anthropic doesn't), the real value would land in pi's address
space.

**Risk:** Today: zero (Anthropic doesn't echo). Future: depends on what
else we register.

**Fix when revisited:** add the inverse substitution to the response
body, behind a per-secret flag. Anthropic streams SSE, so the
implementation needs to operate on a streaming `ReadableStream` rather
than buffering the full response.

