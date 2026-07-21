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
(`ZEROVAULT_API_KEY` / `ZEROVAULT_API_URL`) to regenerate `.dev.vars`, and
it spins up several background processes and ports. That's awkward to run
per-PR in CI.

**Risk:** silent breakage in the turn pipeline between runs. Bounded by the
fact that the only user is also the operator.

**Fix when revisited:** provision the ZeroVault CI secrets and add an
`e2e` job (or a scheduled workflow) that runs `bin/e2e-test`.
