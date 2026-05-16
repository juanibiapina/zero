# Tech Debt

Tracked shortcuts, workarounds, and deferred improvements. When an entry
is resolved, delete it.

## Integration test runs on demand only

**Where:** `bin/integration-test`, `packages/integration-tests/`.

**What:** The Telegram round-trip integration test is invokable
locally via `bin/integration-test` but is not wired into `bin/ci` or
any scheduled GitHub Actions workflow. Regressions in the deployed
worker (KV → container → pi → Anthropic → Telegram round-trip)
are only caught when someone remembers to run it manually.

**Why it's like this:** each run costs a few cents on Anthropic and
takes 30–90s, so it's a poor fit for per-PR CI. A nightly cron felt
premature for a one-user project.

**Risk:** silent breakage in production between runs. Bounded by the
fact that the only user is also the operator.

**Fix when revisited:** add a GitHub Actions `schedule:` workflow
(daily cron) that runs `bin/integration-test` with the
`zero-tests/dev` Doppler service token in a CI secret, and pings on
failure.

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
pass-through `outboundByHost` glob, so we no longer scan R2 bodies for
the secret sentinel. We do still buffer R2 PUT/POST bodies in that
handler so the SigV4 signature survives Workers' `fetch` (passing the
container's Request straight through left bodies as streams without
Content-Length and R2 rejected them with 411 / 403 — see commit
f4f4876). And because `interceptHttps = true` plus a catch-all handler
forces intercept-all mode (which intercepts HTTPS via the `*` pattern),
even pass-through R2 traffic still round-trips through the worker
before reaching `<acct>.r2.cloudflarestorage.com`.

**Risk:** Latency on the FUSE mount under heavy session I/O — every
read/write/list pays one extra worker hop, and writes additionally pay
one body-buffer round-trip in worker memory.

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

## Speculative defenses in the R2 persistence fix (commit f4f4876)

**Where:**

- `packages/agent-server/entrypoint.sh` — tigrisfs `--fsync-on-close`; tigrisfs `--file-mode=0666 --dir-mode=0777`

**What:** While debugging “pi session writes never reach R2” we made
several changes that *could* have been the fix, then found the real
root cause (Workers' `fetch(req)` re-streaming bodies, breaking SigV4
and stripping Content-Length — confirmed by the `r2_request` diagnostic
log showing 411 / 403). The body-buffering fix in
`AgentContainer.outboundByHost["*.r2.cloudflarestorage.com"]` was
proven necessary; the two tigrisfs flags above shipped alongside it
without independent verification.

**Risk:** Extra complexity / latency in the FUSE mount for no proven
benefit. If a future bug appears in this area we can't easily tell
whether the flags are “doing their job” or quietly broken — because we
never confirmed they were doing anything in the first place.
`--fsync-on-close` in particular adds an R2 round-trip to every
session-entry write.

**Fix when revisited:** verify each one by reverting and watching
production. For each: revert, `bin/deploy` with
`--containers-rollout=immediate`, clear KV, send messages spanning a
`sleepAfter` window (5 min idle), verify (a) replies still arrive and
(b) the session JSONL on R2 grows after each turn
(`aws s3api list-objects-v2 ... | jq '.Contents[] | {Key, Size,
LastModified}'`).

Suggested order, cheapest-to-revert and most-likely-unnecessary first:

1. **tigrisfs `--fsync-on-close`**. With body-buffering fixing the real
   bug, tigrisfs's default lazy writeback will eventually flush. The
   only window this flag closes is between the last write and the next
   abrupt kill. Measure that window in practice (e.g. integration test
   with idle eviction) before deciding to keep the per-write round-trip
   cost.
2. **tigrisfs `--file-mode=0666 --dir-mode=0777`**. Most likely
   required: pi runs as uid 1001 and tigrisfs reports inodes as uid=0
   by default, so without world-writable mode pi can't append to files
   it just created. Confirm with a fresh-session test — the first user
   turn writes the header + user + assistant entries; if that PUT
   doesn't appear on R2 with this flag removed, the flag is required.
   `--uid=1001` is not an alternative because `--setuid` defaults to
   `--uid`, which would make tigrisfs itself drop privileges and break
   the FUSE mount.

