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
(daily cron) that runs `bin/integration-test` with
`ZEROVAULT_API_KEY` and `ZEROVAULT_API_URL` in CI secrets, and pings on
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

## Typing indicator has no safety timeout

**Where:** `apps/api/src/UserDO/index.ts` (`markSessionActive` / `markSessionIdle` /
`alarm`), `apps/api/src/handle-agent-end.ts` (`handleAgentEnd`).

**What:** While a turn runs, a `status` column on the `sessions` row is
flipped to `active` and a DO alarm re-sends the Telegram "typing" action
every few seconds. The only thing that stops it is the `/agent-end` callback
running `markSessionIdle`. There is no expiry or watchdog: if a turn
never calls back (container crash, dropped `/agent-end`, lost callback), the
row stays `active` and the topic types indefinitely.

**Why it's like this:** we deliberately chose `status` alone over a
timestamp + cap to keep the state minimal, betting that `agent_end`
always reaches `/agent-end` (it does on reply, empty turn, abort, and
`close_session`).

**Risk:** a lost reply leaves a perpetual "typing…" in that topic until
the next successful turn clears it. Bounded: cosmetic, single-user, and
self-heals on the next reply for that session.

**Fix when revisited:** add a watchdog — e.g. an `activeSince` timestamp
checked in `alarm()` so a session older than a cap is forced back to
`idle` and the alarm stops re-arming.
