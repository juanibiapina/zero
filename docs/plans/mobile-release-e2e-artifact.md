# Mobile release E2E suite — decision artifact (Minto)

## Governing thought

Build the release E2E suite as a **hermetic stack**: an app build with **mocked
auth** talking to a **local worker** with a throwaway local Durable Object. This
uses the real Google account nowhere and touches production data nowhere, and it
lets the important signed-in flows run **both** on the Pixel 7 on `mini` and on
the CI emulator.

## Key line (the three reasons this is the right shape)

1. **It is the only design that satisfies both hard constraints at once** — no
   production data and no second Google account.
2. **It unlocks the important flows in CI**, which the alternative could not.
3. **It ships no test code to production** and reuses a pattern the repo already
   has.

Everything below supports these three.

---

## 1. It satisfies both hard constraints at once

- Two requirements collide: no production data, and no second Google account.
  Same account against the real worker means the same per-user Durable Object,
  which is production data.
- Mocking auth removes Google from the loop entirely; a local worker with a
  local DO removes production data entirely. Both constraints fall out of the
  design instead of being worked around.
- The rejected alternative — route the real account to a `:e2e` DO suffix in the
  production worker — kept the real worker in the loop and only isolated by a
  name suffix. Dropped.

## 2. It unlocks the important flows in CI

- Google OAuth cannot be automated, so an unmocked emulator can never reach a
  signed-in screen. That is why today's CI stops at a signed-out smoke.
- With auth mocked, the emulator reaches the signed-in tree, so capture→Inbox,
  task→Today, offline→sync, and cross-tab all run in CI, not only on the device.
- The device (Pixel 7 on `mini`) runs the identical flows on real hardware. CI
  and device share one flow set.
- Real OAuth is still covered, thinly and separately: the signed-out
  `sign-in.yaml` and `probe.yaml` run against the true Clerk instance, plus an
  occasional manual real-account pass.

## 3. It ships no test code to production and reuses an existing pattern

- The auth bypass lives only in the test wrangler config, gated on
  `ENVIRONMENT=test`, which production never sets. The deployed worker is
  untouched.
- The local-worker-with-mocks pattern already exists (`packages/agent-e2e` mocks
  Telegram and OpenAI via `wrangler.test.jsonc`); this extends it to `/api/*`.

---

## How the pieces fit (support for the three reasons)

- **App fake auth.** No auth seam exists today; `@clerk/expo` and
  `@clerk/expo/native` are imported directly in four files. A Metro resolver
  alias gated by `EXPO_PUBLIC_E2E_FAKE_AUTH=1` swaps both to a tiny fake:
  `useAuth` returns signed-in with `getToken → 'e2e-test-user'`; `ClerkProvider`
  passes through; `UserButton`/`useSSO`/`tokenCache` are stubs. No screen edits.
- **Worker bypass.** `/api/*` is guarded by `clerkMiddleware()`, which needs a
  Clerk secret the test config lacks. Branch before it: under `ENVIRONMENT=test`,
  set `userId` from the bearer. Unit-tested inert without the flag.
- **Local worker on `mini`.** `workerd` will not start on NixOS directly, but
  containers are already enabled (rootless podman, verified; `workerd` runs in
  `node:22-slim`). Run `wrangler dev` in a container, publish port 8787,
  `adb reverse` it to the Pixel. No `dotfiles` change.
- **CI worker.** Runs natively on the ubuntu runner; the emulator reaches it at
  `10.0.2.2:8787`.
- **Flow layout.** `.maestro/ci/` (signed-out, `clearState`) and
  `.maestro/release/` (signed-in, hermetic) never mix in one run.

## What it costs, and the cover

- It does not exercise real Clerk/Google OAuth or the real Cloudflare edge. The
  signed-out smoke against real Clerk plus an occasional manual real-account pass
  cover that narrow, stable surface.
- New plumbing: the fake-auth module + Metro alias, and the worker test bypass.
  Both small, both build/test-gated.

## Proof already gathered

- Four files import Clerk directly, with no seam (read in source).
- `clerkMiddleware` needs a secret the test config lacks (read in `app.ts` /
  `clerk.ts`).
- Offline sync is real (`@tanstack/offline-transactions` + op-sqlite in
  `tasks-collection.ts`), so the sync flow is meaningful.
- Rootless podman works for `juan` on `mini`, and `workerd 2026-08-30` ran in a
  container (verified live).

## First move

A phase-0 spike: run `wrangler dev` in a container on `mini` with the
`ENVIRONMENT=test` bypass, `curl` `/api/tasks` with the fake bearer, then hit it
from the Pixel over `adb reverse`. It proves the whole spine before any UI flow
is written.

Full implementation plan: `docs/plans/mobile-release-e2e.md`.
