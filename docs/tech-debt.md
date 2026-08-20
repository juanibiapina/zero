# Tech Debt

Tracked shortcuts, workarounds, and deferred improvements. When an entry
is resolved, delete it.

## E2E tests run on demand only

**Where:** `bin/e2e-test`, `packages/agent-e2e/`.

**What:** The end-to-end suite (local worker + mock Telegram + mock
Anthropic) is invokable via `bin/e2e-test` but is not wired into `bin/ci`
or the GitHub Actions CI workflow. Regressions in the full webhook → turn →
reply pipeline are only caught when someone runs it manually.

**Why it's like this:** the script needs ZeroVault credentials
(`ZERO_API_KEY` / `ZERO_API_URL`) to serve the worker's secrets, and
it spins up several background processes and ports. That's awkward to run
per-PR in CI.

**Risk:** silent breakage in the turn pipeline between runs. Bounded by the
fact that the only user is also the operator.

**Fix when revisited:** provision the ZeroVault CI secrets and add an
`e2e` job (or a scheduled workflow) that runs `bin/e2e-test`.

## `@cloudflare/workers-types` pinned to a pre-regression version

**Where:** `pnpm.overrides` in the root `package.json`
(`"@cloudflare/workers-types": "5.20260801.1"`).

**What:** The whole repo is pinned to workers-types `5.20260801.1` via a pnpm
override, so the newer versions pulled transitively (e.g. by `wrangler` under
`@cloudflare/vitest-plugin`) do not reach the type-checker.

**Why it's like this:** from `5.20260807.2` onward, `index.d.ts` emits
`declare const Buffer` / `process` / `global`. A `const` does not merge with
`@types/node`'s `var` globals, so it discards Node's global block: `Buffer.from()`
loses its type and surfaces as `TS2554: Expected 0 arguments, but got 1`, while
`process` silently degrades to `any`. Any package listing both
`@cloudflare/workers-types` and `node` in `compilerOptions.types` is affected
(here: `packages/auth`). `5.20260804.1` is the last clean release; `5.20260801.1`
is the pinned floor. Upstream bug: https://github.com/cloudflare/workerd/issues/7026

**Risk:** held-back ambient Worker typings only (dev-time, no runtime effect).
Types lag the deployed runtime slightly; we consume nothing newer today.

**Fix when revisited:** when a workers-types release closes workerd#7026 (emits
`var` for the Node-owned globals, or drops them), remove the override and let the
normal ranges resolve. Watch that issue for the fixed version.
